'use strict'

import Debug from 'debug'
import WebSocket from 'ws'
const log = Debug('app')
const logMsg = Debug('msg')
import {Severity as SDLoggerSeverity, Store as SDLogger} from '../logging/'
import {Client} from './types'
import io from '@pm2/io'

const maxErrorsBeforePenalty = 5
const penaltyDurationSec = 120

const maxPongTimeout = 30

const metrics = {
  messages: io.counter({name: '# messages'})
}

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

  constructor (clientState: Client, endpoint: string) {
    // super(UplinkServers.basic)
    super(endpoint, {headers: {'X-Forwarded-For': clientState.ip, 'X-User': clientState.ip}})

    log(`{${clientState!.id}} ` + `Construct new UplinkClient to ${endpoint}`)

    this.clientState = clientState
    this.id = clientState.uplinkCount + 1

    // log(penalties)

    this.connectTimeout = setTimeout(() => {
      log(`Close. Connection timeout. - Penalties (before):`, {penalties})

      this.penalty(endpoint)

      if (process.env?.LOGCLOSE) {
        log('C__9')
      }
      this.close()
    }, 17.5 * 1000)

    this.on('open', () => {
      this.pingInterval = setInterval(() => {
        this.send(JSON.stringify({id: 'CONNECTION_PING_TEST', command: 'ping'}))
      }, 2500)

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
      if (this.clientState!.closed) {
        log(`{${clientState!.id}} ` + `     -> Don't reconnect, client gone`)
      } else {
        if (this.closedOnPurpose) {
          log(`{${clientState!.id}} ` + '     -> On purpose :)')
        } else {
          log(`{${clientState!.id}} ` +
            '     -> [NOT ON PURPOSE] Client still here - Instruct parent to find new uplink')
          this.emit('gone')
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

      this.startPongTimeout(clientState, endpoint)

      if (!firstPartOfMessage.match(/(NEW_CONNECTION_TEST|CONNECTION_PING_TEST|REPLAYED_SUBSCRIPTION)/)) {
        const ledgerRangeMatch = dataString.match(/validated_ledgers.+?([0-9,-]+)/)
        if (ledgerRangeMatch) {
          this.connectionIsSane()
          const newLedgerRange = `32570-${ledgerRangeMatch[1].split('-').reverse()[0].split(',').reverse()[0]}`
          logMsg(`LEDGER RANGE received: ${ledgerRangeMatch[1]}, update to: ${newLedgerRange}`)
          dataString = dataString.replace(ledgerRangeMatch[1], newLedgerRange)
        }
        logMsg(`{${clientState!.id}} ` + 'Message from ', endpoint, ':', firstPartOfMessage.slice(0, 256))
        // logMsg(`{${clientState!.id}} ` + 'Message from ', endpoint, ':', JSON.parse(dataString))
        metrics.messages.inc()
        this.clientState!.counters.rxCount++
        this.clientState!.counters.rxSize += dataString.length
        this.clientState!.socket.send(dataString)
      } else {
        if (firstPartOfMessage.match(/CONNECTION_PING_TEST/)) {
          this.connectionIsSane()
          logMsg(`MSG (PING_TEST) {${clientState!.id}:${
            clientState!.closed
              ? 'closed'
              : 'open'
          }} ${endpoint}, ${firstPartOfMessage}`)
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
      }
    })

    // Penalties
    if (Object.keys(penalties).indexOf(endpoint) > -1 && penalties[endpoint].is) {
      if (Math.round(new Date().getTime() / 1000) - penalties[endpoint].last > penaltyDurationSec) {
        penalties[endpoint].last = 0
        penalties[endpoint].count = 0
        penalties[endpoint].is = false
        log(`_______________ Penalty ${endpoint} is now removed`)
      }

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

  penalty (endpoint: string): void {
    if (Object.keys(penalties).indexOf(endpoint) < 0) {
      penalties[endpoint] = {count: 0, last: 0, is: false}
    }

    penalties[endpoint].count++
    log(`Penalty ${endpoint} is now ${penalties[endpoint].count}`)
    penalties[endpoint].last = Math.round(new Date().getTime() / 1000)

    if (penalties[endpoint].count > maxErrorsBeforePenalty) {
      penalties[endpoint].is = true
      const penaltyDetails = {
        endpoint,
        ip: this.clientState?.ip,
        uplinkCount: this.clientState?.uplinkCount || 0
      }
      // log('Endpoint Penalty', penaltyDetails)
      SDLogger('Endpoint Penalty', penaltyDetails, SDLoggerSeverity.NOTICE)
    }
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
      log(`{${this.clientState!.id}} ` + '!! WS Close ERROR', e.message)
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
          log('Error parsing message JSON', e.message)
        }
      }

      super.send(message)
    } else {
      if (!message.slice(0, 1024).match(/NEW_CONNECTION_TEST|CONNECTION_PING_TEST|REPLAYED_SUBSCRIPTION/)) {
        log('UplinkClient sent message: UPLINK NOT CONNECTED YET. Added to buffer.')
        this?.clientState?.uplinkMessageBuffer.push(message)
        if (Array.isArray(this?.clientState?.uplinkMessageBuffer)) {
          if (Array(this.clientState!.uplinkMessageBuffer).length > 1000) {
            if (process.env?.LOGCLOSE) {
              log('Clearing ClientState, buffer > 1000')
            }
            try {
              if (process.env?.LOGCLOSE) {
                log('C__8')
              }
              this.clientState!.socket.close()
              this.clientState!.uplink!.close()
            } catch (e) {
              log('!!!!! >', e.message)
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
