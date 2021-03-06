'use strict'

import crypto from 'crypto'
import Debug from 'debug'
import WebSocket from 'ws'
const log = Debug('app')
const logMsg = Debug('msg')
import ProxyServer from './ProxyServer'
import {Severity as SDLoggerSeverity, Store as SDLogger} from '../logging/'
import {Client} from './types'
import io from '@pm2/io'

const minFeeDrops = 10

const maxErrorsBeforePenalty = 4
const penaltyDurationSec = 60

const maxPongTimeout = 30

const metrics = {
  messages: io.counter({name: '# messages'})
}

const feeHistoryLength = 500
const feeHistoryOpenLedger: string[] = []

type penaltyData = {
  count: number
  last: number
  is: boolean
}

type penaltyObj = {
  [key: string]: penaltyData
}

const penalties: penaltyObj = {}

class UplinkClient extends WebSocket {
  private closedOnPurpose: boolean = false
  private clientState: Client | undefined
  private id: number = 0
  private connectTimeout: any
  private pingInterval: any
  private pongTimeout: any
  private proxy: ProxyServer
  private socketDebugMessages = false

  constructor (clientState: Client, endpoint: string, proxy: ProxyServer) {
    super(endpoint, {
      headers: {
        'X-Forwarded-For': clientState.ip.split(',')[0],
        'X-User': 'xrplcluster/' + clientState.ip
      }
    })
    log('super', endpoint, clientState?.uplinkType)

    log(`{${clientState!.id}} ` + `Construct new UplinkClient to ${endpoint}`)
    if ((clientState?.request?.url || '').match(/state|debug/)) {
      this.socketDebugMessages = true
      this.sendSocketDebugMessage(JSON.stringify({endpoint}))
    }

    this.clientState = clientState
    this.id = clientState.uplinkCount + 1
    this.proxy = proxy

    this.cleanPenalties()

    // log(penalties)

    this.connectTimeout = setTimeout(() => {
      log(`Close. Connection timeout. - Penalties (before):`, {penalties})
      this.sendSocketDebugMessage(JSON.stringify({endpoint, message: 'Connection timeout'}))

      this.penalty(endpoint)

      if (process.env?.LOGCLOSE) {
        log('C__9')
      }
      this.close()
    }, 7.5 * 1000)

    this.on('open', () => {
      this.startPongTimeout(clientState, endpoint)

      this.pingInterval = setInterval(() => {
        this.send(JSON.stringify({id: 'CONNECTION_PING_TEST', command: 'ping'}))
      }, 5 * 1000)

      log(`{${clientState!.id}} ` + 'UplinkClient connected to ', endpoint)
      log(`{${clientState!.id}} ` + 'Subscriptions to replay ', this.clientState!.uplinkSubscriptions.length)

      this.clientState!.uplinkSubscriptions.forEach((s: string): void => {
        if (s.trim().slice(0, 1) === '{') {
          this.send(s.trim().slice(0, -1) + `,"id":"REPLAYED_SUBSCRIPTION"}`)
        } else{
          // Custom
          const subscribeData = s.split(':')
          this.send(
            `{"id":"REPLAYED_SUBSCRIPTION","command": "subscribe","${subscribeData[0]}":["${subscribeData[1]}"]}`
          )
        }
      })
    })

    this.on('close', () => {
      if (process.env?.LOGCLOSE) {
        log('C__14')
      }

      clearTimeout(this.connectTimeout)
      clearTimeout(this.pongTimeout)
      clearInterval(this.pingInterval)

      log(`{${clientState!.id}} ` + '>> UplinkClient disconnected from ', endpoint)
      this.sendSocketDebugMessage(JSON.stringify({endpoint, message: 'Uplink disconnected'}))

      if (this.clientState!.closed) {
        log(`{${clientState!.id}} ` + `     -> Don't reconnect, client gone`)
      } else {
        if (this.closedOnPurpose) {
          log(`{${clientState!.id}} ` + '     -> On purpose :)')
        } else {
          log(`{${clientState!.id}} ` +
            '     -> [NOT ON PURPOSE] Client still here - Instruct parent to find new uplink')
          this.emit('gone')
          this.sendSocketDebugMessage(JSON.stringify({endpoint, message: 'Find new uplink'}))
        }
      }
      // this.clientState = undefined
    })

    this.on('message', data => {
      let dataString = data.toString()
      clearTimeout(this.connectTimeout)

      if (typeof clientState !== 'undefined' && clientState!.closed) {
        // Client is gone.
        log(`CLIENT {${clientState!.id}} GONE - kill uplink`)
        this.closedOnPurpose = true
        if (process.env?.LOGCLOSE) {
          log('C__10')
        }
        this.close()

        clearTimeout(this.pongTimeout)
        clearInterval(this.pingInterval)

        return
      }

      const firstPartOfMessage = dataString.slice(0, 1024).trim()

      if (firstPartOfMessage.match(/ledger_index|complete_ledgers/)) {
        this.connectionIsSane()
      }

      // Replace fake _id values for remapping of values, see SubmitFilter assignFakeResponseValue()
      if (firstPartOfMessage.match(/__fake_value/)) {
        try {
          const dataJson = JSON.parse(dataString)
          log(`\n\n{START:assignFakeResponseValue}\n`)

          let fake_field_key = ''
          let fake_field_value = ''

          if (dataJson?.id) {
            if (typeof dataJson?.id === 'object' && dataJson.id !== null) {
              //
              log('ID is object, revert to original value')
              ;[fake_field_key, fake_field_value] = [
                (dataJson?.id?.__fake_value || '').split(':')[0],
                (dataJson?.id?.__fake_value || '').split(':').slice(1).join(':')
              ]
              dataJson.id = dataJson?.id?.__original_value
            }
            if (typeof dataJson?.id === 'string') {
              if (dataJson.id.slice(0, 13) === '__fake_value_') {
                log('There was no id, just the fake value')
                ;[fake_field_key, fake_field_value] = [
                  dataJson.id.slice(13).split(':')[0],
                  dataJson.id.slice(13).split(':').slice(1).join(':')
                ]
                delete dataJson.id
              } else {
                log('There was an existing string id, revert to original string')
                const [originalId, fakeValue] = dataJson.id.split('|__fake_value_')
                dataJson.id = originalId
                ;[fake_field_key, fake_field_value] = [
                  fakeValue.split(':')[0],
                  fakeValue.split(':').slice(1).join(':')
                ]
              }
            }
          }

          log({fake_field_key, fake_field_value})
          if (fake_field_key !== '') {
            if (typeof dataJson.result === 'object' && dataJson.result !== null) {
              dataJson.result[fake_field_key] = fake_field_value
            }
          }

          log(`\n{END:assignFakeResponseValue}\n\n\n`)
          dataString = JSON.stringify(dataJson)
        } catch (e) {
          log('assignFakeResponseValue postprocessing error', (e as any).message)
        }
      }

      // "base_fee":"10","median_fee":"5000","minimum_fee":"10","open_ledger_fee":"10"
      if (firstPartOfMessage.match(/base_fee.+open_ledger_fee.+/)) {
        // fee response
        try {
          // Fee Padding
          const dataJson = JSON.parse(dataString)
          if (dataJson?.result?.drops?.base_fee) {
            dataJson.result.drops.base_fee = Number(dataJson.result.drops.base_fee) < minFeeDrops
              ? String(minFeeDrops)
              : dataJson.result.drops.base_fee
          }

          if (dataJson?.result?.drops?.minimum_fee) {
            dataJson.result.drops.minimum_fee = Number(dataJson.result.drops.minimum_fee) < minFeeDrops
              ? String(minFeeDrops)
              : dataJson.result.drops.minimum_fee
          }

          if (dataJson?.result?.drops?.open_ledger_fee) {
            feeHistoryOpenLedger.push(dataJson.result.drops.open_ledger_fee)
            if (feeHistoryOpenLedger.length > feeHistoryLength) {
              feeHistoryOpenLedger.splice(0, feeHistoryOpenLedger.length - feeHistoryLength)
            }
            const feeHistoryOpenLedgerSorted = new Uint32Array([...feeHistoryOpenLedger.map(v => Number(v))]).sort()
            const feeHistoryOpenLedgerSelected = Math.floor(feeHistoryOpenLedgerSorted.length / 2)
            const feeHistoryOpenLedgerCommon = String(feeHistoryOpenLedgerSorted[feeHistoryOpenLedgerSelected])

            // Overrule open ledger fee with ~median
            if (Number(dataJson.result.drops.open_ledger_fee) > Number(feeHistoryOpenLedgerCommon)) {
              log('Overrule open_ledger_fee using ~median, from:',
                dataJson.result.drops.open_ledger_fee, 'to:', feeHistoryOpenLedgerCommon)

              dataJson.result.drops.open_ledger_fee = feeHistoryOpenLedgerCommon
            }

            // log({
            //   thisFee: dataJson.result.drops.open_ledger_fee,
            //   feeHistoryOpenLedger,
            //   feeHistoryOpenLedgerSorted,
            //   feeHistoryOpenLedgerSelected,
            //   feeHistoryOpenLedgerCommon
            // })
          }

          if (dataJson?.result?.drops?.open_ledger_fee) {
            dataJson.result.drops.open_ledger_fee = Number(dataJson.result.drops.open_ledger_fee) < minFeeDrops
              ? String(minFeeDrops)
              : dataJson.result.drops.open_ledger_fee
          }

          dataString = JSON.stringify(dataJson)
        } catch (e) {
          log('Fee postprocessing error', (e as any).message)
        }
      }

      const replay = (): void => {
        log('Replay')
        if ((clientState?.uplinkLastMessages || []).length < 10) {
          // Only < 10 messages sent this session, immediately dumped
          clientState.uplinkLastMessages.forEach(lm => {
            this.send(lm.split(':').slice(1).join(':'))
          })
        }
        return
      }

      if (!firstPartOfMessage.match(/(NEW_CONNECTION_TEST|CONNECTION_PING_TEST|REPLAYED_SUBSCRIPTION)/)) {
        if (
          (firstPartOfMessage.match(/lgrIdxsInvalid/) && firstPartOfMessage.match(/Ledger indexes invalid/))
          // Internal error, but also eg. path_find TL destination exceeded
          // || (firstPartOfMessage.match(/:73,/) && firstPartOfMessage.match(/Internal error/))
        ) {
          // Server is having trouble
          logMsg('Server is having (temp) unrecoverable problems, switch uplink')
          if (process.env?.LOGCLOSE) {
            log('C__40 -- Switch uplink')
          }
          this.penalty(endpoint, 20)
          this.close()
          return replay()
        }

        if (dataString.match(/error/) && dataString.match(/noCurrent|noNetwork|noClosed|tooBusy|amendmentBlocked/)) {
          logMsg('noCurrent|noNetwork|noClosed|tooBusy|amendmentBlocked', endpoint)
          if (process.env?.LOGCLOSE) {
            log('C__22 -- Switch uplink')
          }
          this.penalty(endpoint, 6)
          this.close()
          return replay()
        }

        const ledgerRangeMatch = dataString.match(/(validated_ledgers|complete_ledgers)[: "]+([0-9,-]+)/)
        if (ledgerRangeMatch) {
          this.connectionIsSane()
          if (clientState?.uplinkType === 'basic') {
            if (ledgerRangeMatch[2].split(',').length > 1 || ledgerRangeMatch[2].split('-')[0] !== '32570') {
              logMsg('validated_ledgers/complete_ledgers: non FH, FH requested', ledgerRangeMatch[2])
              if (process.env?.LOGCLOSE) {
                log('C__20 -- Switch uplink')
              }
              this.penalty(endpoint, 6)
              this.close()
              return replay()
            }
          }
          const newLedgerRange = `32570-${ledgerRangeMatch[2].split('-').reverse()[0].split(',').reverse()[0]}`
          logMsg(`LEDGER RANGE received: ${ledgerRangeMatch[2]}, update to: ${newLedgerRange}`)
          dataString = dataString.replace(ledgerRangeMatch[2], newLedgerRange)
        } else {
          if (dataString.match(/(validated_ledgers|complete_ledgers)[: "]+(empty)/)) {
            logMsg('Not synced with the network', endpoint)
            if (process.env?.LOGCLOSE) {
              log('C__21 -- Switch uplink')
            }
            this.penalty(endpoint, 6)
            this.close()
            return replay()
          }
        }

        logMsg(`{${clientState!.id}} ` + 'Message from ', endpoint, ':', firstPartOfMessage.slice(0, 256))
        // logMsg(`{${clientState!.id}} ` + 'Message from ', endpoint, ':', JSON.parse(dataString))
        metrics.messages.inc()
        this.clientState!.counters.rxCount++
        this.clientState!.counters.rxSize += dataString.length
        this.clientState!.socket.send(dataString)
      } else {
        if (firstPartOfMessage.match(/CONNECTION_PING_TEST/)) {
          this.startPongTimeout(clientState, endpoint)
          // logMsg(`MSG (PING_TEST) {${clientState!.id}:${
          //   clientState!.closed
          //     ? 'closed'
          //     : 'open'
          // }} ${endpoint}, ${firstPartOfMessage}`)
        }
      }
    })

    this.on('ping', () => {
      this.pong()
    })

    this.on('error', error => {
      clearTimeout(this.connectTimeout)
      clearTimeout(this.pongTimeout)
      clearInterval(this.pingInterval)

      this.penalty(endpoint)

      if (!error.message.match(/closed before.+established/)) {
        log(`{${clientState!.id}} ` + 'UPLINK CONNECTION ERROR', endpoint, ': ', error.message)
        this.sendSocketDebugMessage(JSON.stringify({endpoint, message: 'Uplink connection error'}))
      }
    })

    // Penalties
    if (Object.keys(penalties).indexOf(endpoint) > -1 && penalties[endpoint].is) {
      clearTimeout(this.connectTimeout)
      clearTimeout(this.pongTimeout)
      clearInterval(this.pingInterval)

      log(`_________________ UPLINK TEMP PENALTY: CLOSE {${clientState!.id}} @ ${endpoint}`)
      if (process.env?.LOGCLOSE) {
        log('C__12')
      }

      this.close()
    }

    this.clientState.uplinkCount++
  }

  sendSocketDebugMessage (message: string): void {
    try {
      if (this.socketDebugMessages) {
        this.clientState?.socket.send(message)
      }
    } catch (e) {
      //
    }
  }

  penalty (endpoint: string, weight = 2): void {
    // No penalty for reporting mode
    if (this.clientState?.uplinkType !== 'reporting') {
      if (Object.keys(penalties).indexOf(endpoint) < 0) {
        penalties[endpoint] = {count: 0, last: 0, is: false}
      }

      penalties[endpoint].count += weight
      log(`Penalty ${endpoint} is now ${penalties[endpoint].count}`)
      penalties[endpoint].last = Math.round(new Date().getTime() / 1000)

      if (penalties[endpoint].count > maxErrorsBeforePenalty) {
        penalties[endpoint].is = true
        const penaltyDetails = {
          endpoint,
          ip: this.clientState?.ip,
          uplinkCount: this.clientState?.uplinkCount || 0
        }

        // Enter maintenance mode
        const hash = crypto.createHash('md5').update(endpoint).digest('hex')
        this.proxy.updateUplinkServer(hash, 'migrate')
        log('___| Penalty > maxErrors, migrate clients', endpoint)

        // log('Endpoint Penalty', penaltyDetails)
        SDLogger('Endpoint Penalty', penaltyDetails, SDLoggerSeverity.NOTICE)
      }
    }
  }

  cleanPenalties (): void {
    Object.keys(penalties).forEach(endpoint => {
      if (Math.round(new Date().getTime() / 1000) - penalties[endpoint].last > penaltyDurationSec) {
        if (penalties[endpoint].last > 0) {
          penalties[endpoint].last = 0
          penalties[endpoint].count = 0
          penalties[endpoint].is = false
          log(`_______________ Penalty ${endpoint} is now removed -- exit maintenance mode`)
          // Exit maintenance mode
          const hash = crypto.createHash('md5').update(endpoint).digest('hex')
          this.proxy.updateUplinkServer(hash, 'up')
        }
      }
    })
  }

  connectionIsSane (): void {
    if (process.env?.LOGCLOSE) {
      log('Connection is sane :)', this.clientState?.preferredServer)
    }
    clearTimeout(this.connectTimeout) // Connection is functional
  }

  getId (): number {
    return this.id
  }

  close (code?: number, data?: string) {
    clearTimeout(this.connectTimeout)
    clearTimeout(this.pongTimeout)
    clearInterval(this.pingInterval)

    if (typeof code !== 'undefined' && typeof data !== 'undefined' && data === 'ON_PURPOSE') {
      this.closedOnPurpose = true
    }
    if (typeof data === 'string' && data.split(':')[0] === 'NO_MESSAGE_TIMEOUT') {
      this.penalty(data.split(':').slice(1).join(':'))
    }

    try {
      if (process.env?.LOGCLOSE) {
        log('C__13')
      }
      super.close()
    } catch (e) {
      log(`{${this.clientState!.id}} ` + '!! WS Close ERROR', (e as any).message)
    }
  }

  startPongTimeout (clientState: Client, endpoint: string): void {
    clearTimeout(this.pongTimeout)

    this.pongTimeout = setTimeout(() => {
      this.penalty(endpoint)

      log(`{${clientState!.id}} ` +
        `!! Not received a PONG for some time (${maxPongTimeout} sec), assume uplink ${endpoint} GONE`)
      if (process.env?.LOGCLOSE) {
        log('C__11')
      }
      this.sendSocketDebugMessage(JSON.stringify({endpoint, message: 'Ping/Pong timeout'}))
      this.close()
    }, maxPongTimeout * 1000)
  }

  send (message: string) {
    if (typeof this !== 'undefined' && this.readyState === this.OPEN) {
      if (message.length <= 1024 * 1024) {
        /**
         * Register subscriptions
         */
        try {
          const messageJson = JSON.parse(message)

          if (typeof messageJson.command === 'string') {
            const command = messageJson.command.toLowerCase()

            /**
             * Handle subscriptions
             */
            if (['subscribe','unsubscribe'].indexOf(command) > -1) {
              let appendSubscription = true

              if (typeof messageJson.id !== 'undefined') {
                if (messageJson.id === 'REPLAYED_SUBSCRIPTION') {
                  appendSubscription = false
                }
                delete messageJson.id
              }

              delete messageJson.url
              delete messageJson.url_username
              delete messageJson.url_password

              messageJson.command = messageJson.command.toLowerCase().trim()

              const commandKeys = Object.keys(messageJson)

              ;['accounts', 'accounts_proposed'].forEach(subscriptionType => {
                if (commandKeys.indexOf(subscriptionType) > -1) {
                  messageJson[subscriptionType].forEach((account: string) => {
                    const subscribeStr = subscriptionType + ':' + account
                    if (messageJson.command === 'subscribe') {
                      if (this.clientState!.uplinkSubscriptions.indexOf(subscribeStr) < 0) {
                        this.clientState!.uplinkSubscriptions.push(subscribeStr)
                      }
                    }
                    if (messageJson.command === 'unsubscribe') {
                      const accountMatch = this.clientState!.uplinkSubscriptions.indexOf(subscribeStr)
                      if (accountMatch > -1) {
                        this.clientState!.uplinkSubscriptions.splice(accountMatch, 1)
                      }
                    }
                  })
                  delete messageJson[subscriptionType]
                }
              })

              if (Object.keys(messageJson).length > 1) {
                // There are still properties after handling subscriptions

                const thisMessageString = JSON.stringify(messageJson)
                if (this.clientState!.uplinkSubscriptions.length > 0) {
                  // If last message equals current message, ignore it.
                  const lastMessage = this.clientState!.uplinkSubscriptions.slice(-1)[0]

                  // Message already exists
                  if (lastMessage === thisMessageString) {
                    appendSubscription = false
                  }

                  // Got no unsubscribes, so subscribes may be unique
                  if (this.clientState!.uplinkSubscriptions.filter(s => {
                    return s.match(/unsubscribe/)
                  }).length < 1) {
                    if (this.clientState!.uplinkSubscriptions.indexOf(thisMessageString) > -1) {
                      appendSubscription = false
                    }
                  }
                  if (thisMessageString.match(/unsubscribe/)) {
                    const matchingSubMsg = thisMessageString.replace('unsubscribe', 'subscribe')
                    const matchingSubscription = this.clientState!.uplinkSubscriptions.indexOf(matchingSubMsg)
                    if (matchingSubscription > -1) {
                      this.clientState!.uplinkSubscriptions.splice(matchingSubscription, 1)
                      appendSubscription = false
                    }
                  }
                }
                if (appendSubscription) {
                  this.clientState!.uplinkSubscriptions.push(thisMessageString)
                }
              }
            }
          }
        } catch (e) {
          log('Error parsing message JSON', (e as any).message)
        }
      }

      super.send(message)
    } else {
      if (!message.slice(0, 1024).match(/NEW_CONNECTION_TEST|CONNECTION_PING_TEST|REPLAYED_SUBSCRIPTION/)) {
        log('UplinkClient sent message: UPLINK NOT CONNECTED YET. Added to buffer.')
        this?.clientState?.uplinkMessageBuffer.push(message)
        if (Array.isArray(this?.clientState?.uplinkMessageBuffer)) {
          if (Array(this.clientState!.uplinkMessageBuffer).length > 50) {
            if (process.env?.LOGCLOSE) {
              log('Clearing ClientState, buffer > 50')
            }
            try {
              if (process.env?.LOGCLOSE) {
                log('C__8')
              }
              this.clientState!.socket.close()
              this.clientState!.uplink!.close()
            } catch (e) {
              log('!!!!! >', (e as any).message)
            }
          }
        }
      }
    }
  }
}

export {
  UplinkClient,
  penalties
}

export default UplinkClient
