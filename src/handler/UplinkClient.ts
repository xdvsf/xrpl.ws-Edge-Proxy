'use strict'

import Debug from 'debug'
import WebSocket from 'ws'
const log = Debug('app')
const logMsg = Debug('msg')
import {Client} from './types'
import io from '@pm2/io'

const penaltyDurationSec = 60

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
      log(`Close. Connection timeout.`)

      if (Object.keys(penalties).indexOf(endpoint) < 0) {
        penalties[endpoint] = {count: 0, last: 0, is: false}
      }

      penalties[endpoint].count++
      log(`Penalty ${endpoint} is now ${penalties[endpoint].count}`)
      penalties[endpoint].last = Math.round(new Date().getTime() / 1000)

      if (penalties[endpoint].count > 1) {
        penalties[endpoint].is = true
      }

      log(penalties)

      this.close()
    }, 7.5 * 1000)

    this.on('open', () => {
      clearTimeout(this.connectTimeout)
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

      this.clientState = undefined
      log.destroy()
    })

    this.on('message', data => {
      clearTimeout(this.connectTimeout)

      const firstPartOfMessage = data.toString().slice(0, 100).trim()
      if (!firstPartOfMessage.match(/(NEW_CONNECTION_TEST|CONNECTION_PING_TEST|REPLAYED_SUBSCRIPTION)/)) {
        logMsg(`{${clientState!.id}} ` + 'Message from ', endpoint, ':', firstPartOfMessage)
        metrics.messages.inc()
        this.clientState!.counters.rxCount++
        this.clientState!.counters.rxSize += data.toString().length
        this.clientState!.socket.send(data)
      } else {
        if (firstPartOfMessage.match(/CONNECTION_PING_TEST/)) {
          clearTimeout(this.pongTimeout)
          this.pongTimeout = setTimeout(() => {
            log(`{${clientState!.id}} ` +
              `!! Not received a PONG for some time (15sec), assume uplink ${endpoint} GONE`)
            this.close()
          }, 15 * 1000)
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
        log(`Penalty ${endpoint} is now removed`)
      }

      clearTimeout(this.connectTimeout)
      clearTimeout(this.pongTimeout)
      clearInterval(this.pingInterval)

      log(`UPLINK TEMP PENALTY: CLOSE {${clientState!.id}} @ ${endpoint}`)
      this.close()
    }


    this.clientState.uplinkCount++
  }

  getId (): number {
    return this.id
  }

  close (code?: number, data?: string) {
    if (typeof code !== 'undefined' && typeof data !== 'undefined' && data === 'ON_PURPOSE') {
      this.closedOnPurpose = true
    }
    try {
      super.close()
    } catch (e) {
      log(`{${this.clientState!.id}} ` + '!! WS Close ERROR', e.message)
    }
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
      if (!message.slice(0, 100).match(/NEW_CONNECTION_TEST|CONNECTION_PING_TEST|REPLAYED_SUBSCRIPTION/)) {
        log('UplinkClient sent message: UPLINK NOT CONNECTED YET. Added to buffer.')
        this.clientState!.uplinkMessageBuffer.push(message)
      }
    }
  }
}

export default UplinkClient
