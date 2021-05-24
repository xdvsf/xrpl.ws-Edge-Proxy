'use strict'

import crypto from 'crypto'
import Debug from 'debug'
import WebSocket from 'ws'
const log = Debug('app')
const logMsg = Debug('msg')
import {Severity as SDLoggerSeverity, Store as SDLogger} from '../logging/'

import * as Config from '../config'
import {Request} from 'express'
import {UplinkClient} from './'
import {Client} from './types'
import io from '@pm2/io'
import ProxyMessageFilter from '../filtering/SubmitFilter'

let connectionId = 0

const metrics = {
  connections: io.counter({name: '∑ connections'}),
  clients: io.metric({name: '# clients'})
}

/**
 * TODO:
 *    REMOTE LOGGER
 *    UNLOCK FH SERVER
 *    SWITCH BACKEND
 *    DASHBOARD
 */

type UplinkServer = {
  type: string
  endpoint: string
  healthy: boolean
  errors: number // TODO: Register errors over time, if > X in recent time Y: healthy = false
  id?: string
}

// TODO: ugly, async, etc.
const UplinkServers: Array<UplinkServer> = Config.get().uplinks.map((u: any) => {
  return Object.assign(u, {
    healthy: typeof u.healthy === 'boolean' ? u.healthy : true,
    errors: 0
  })
})

/**
 * TODO: soft-force all clients connected to a specific UplinkServer to
 * connect to a new backend server, eg. pre-maintenance.
 */

class ProxyServer {
  private WebSocketServer: any
  private Clients: Client[] = []

  constructor (wss: WebSocket.Server) {
    this.WebSocketServer = wss
    this.init()
  }

  getUplinkServers (): Array<UplinkServer> {
    return UplinkServers.map(s => {
      return Object.assign({}, {
        ...s,
        id: crypto.createHash('md5').update(s.endpoint).digest('hex')
      })
    })
  }

  addUplinkServer (type: string, uri: string): void {
    if (this.getUplinkServers().filter(s => s.id === crypto.createHash('md5').update(uri).digest('hex')).length < 1) {
      UplinkServers.push({
        type: type,
        endpoint: uri,
        healthy: false,
        errors: 0
      })
    }
  }

  updateUplinkServer (uplink: string, action: string): void {
    UplinkServers.filter(s => {
      return crypto.createHash('md5').update(s.endpoint).digest('hex') === uplink
    }).forEach(s => {
      log(`Marking uplink [ ${s.endpoint} ] - ${action.toUpperCase()}`)
      if (action === 'migrate') {
        s.healthy = false
        const clientsToMigrate = this.getClients().filter(c => {
          return typeof c.uplink !== 'undefined'
            && typeof c.uplink.url === 'string'
            && c.uplink.url === s.endpoint
        })
        log(`Migrating [ ${clientsToMigrate.length} clients ] away from ${s.endpoint}`)
        clientsToMigrate.forEach(c => {
          c.socket.emit('migrate')
        })
      }
      if (action === 'down') {
        s.healthy = false
      }
      if (action === 'up') {
        s.healthy = true
      }
    })
  }

  getClients (): Array<Client> {
    return this.Clients
  }

  getClientIpCount (ip?: string): Array<string> | number {
    const clientsByIp = this.Clients.filter(c => {
      return c.uplinkType === 'basic' && !c.closed && (ip === undefined || ip === c.ip)
    }).map(c => {
      return c.ip
    }).reduce((a: any, b: string) => {
      return Object.assign(a, {
        [b]: typeof a[b] === 'undefined' ? 1 : a[b] + 1
      })
    }, {})

    return ip === undefined
      ? clientsByIp
      : clientsByIp[ip] || 0
  }

  createSubmitClient (clientState: Client): Client {
    const submitClient: Client = {
      id: connectionId,
      closed: false,
      uplinkType: 'submit',
      preferredServer: '',
      socket: clientState.socket,
      request: clientState.request,
      uplinkMessageBuffer: [],
      uplinkSubscriptions: [],
      ip: clientState.ip,
      connectMoment: new Date(),
      counters: {rxCount:0, txCount:0, rxSize:0, txSize: 0, uplinkReconnects: 0},
      uplinkCount: 0,
      headers: {
        'origin': String(clientState.request.headers['origin'] || ''),
        'userAgent': String(clientState.request.headers['user-agent'] || ''),
        'acceptLanguage': String(clientState.request.headers['accept-language'] || ''),
        'xForwardedFor': String(clientState.request.headers['x-forwarded-for'] || ''),
        'requestUrl': String(clientState.request?.url || '')
      },
      uplinkLastMessages: []
    }

    submitClient.preferredServer = this.getUplinkServer(submitClient)
    this.connectUplink(submitClient)

    return submitClient
  }

  submitTransaction (clientState: Client, submitMessage: string): void {
    if (clientState !== undefined) {
      if (typeof clientState.submitClient === 'undefined') {
        clientState.submitClient = this.createSubmitClient(clientState)
        // setInterval(() => {
        //   if (clientState !== undefined) {
        //     if (clientState.submitClient !== undefined) {
        //       log('submitClient', Object.assign({}, {
        //         id: clientState.submitClient.id,
        //         closed: clientState.submitClient.closed,
        //         uplinkType: clientState.submitClient.uplinkType,
        //         preferredServer: clientState.submitClient.preferredServer,
        //         uplinkMessageBuffer: clientState.submitClient.uplinkMessageBuffer,
        //         connectMoment: clientState.submitClient.connectMoment,
        //         counters: clientState.submitClient.counters,
        //         uplinkCount: clientState.submitClient.uplinkCount,
        //         uplinkLastMessages: clientState.submitClient.uplinkLastMessages
        //       }))
        //     } else {
        //       log('clientState.submitClient UNDEFINED')
        //     }
        //   } else {
        //     log('clientState UNDEFINED')
        //   }
        // }, 3000)
      }
      let flow = ''
      let node = ''
      if (typeof clientState.submitClient!.uplink !== 'undefined'
        && clientState.submitClient!.uplink.readyState === clientState.submitClient!.uplink.OPEN) {
          clientState.submitClient.uplink!.send(submitMessage)
          flow = 'send'
          node = clientState.submitClient!.uplink!.url || ''
      } else {
        clientState.submitClient!.uplinkMessageBuffer.push(submitMessage)
        log(`{${clientState.submitClient!.id}} Storing new buffered message`)
        flow = 'buffer'
      }

      if (node === '') {
        node = clientState.submitClient!.preferredServer
      }

      SDLogger('TX Submit Routing', {
        ip: clientState?.ip,
        flow,
        node,
        command: submitMessage
      }, SDLoggerSeverity.DEBUG)

      const mLength = Config.get()?.monitoring?.ClientCommandHistory || 10
      if (submitMessage.indexOf('"command":"ping"') < 0) {
        clientState.submitClient!.uplinkLastMessages.unshift(
          `${clientState.submitClient!.counters.txCount}:${submitMessage}`
        )
        clientState.submitClient!.uplinkLastMessages = clientState.submitClient!.uplinkLastMessages.slice(0, mLength)
      }
    }
  }

  getUplinkServer (clientState: Client): string {
    const possibleServers: string[] = UplinkServers.filter((r: any) => {
      return r.healthy === true && r.type === clientState.uplinkType.toLowerCase()
    }).map((r: any) => {
      return r.endpoint
    })

    if (possibleServers.length === 1) {
      return possibleServers[0]
    } else if (possibleServers.length > 1) {
      return possibleServers[Math.floor(Math.random() * possibleServers.length)]
    }

    // TODO: pooling?
    return 'wss://s2.ripple.com/#fallback'
  }

  connectUplink (clientState: Client): void {
    if (typeof clientState.uplink !== 'undefined') {
      if (clientState.uplink?.url === clientState.preferredServer) {
        return
      }
    }
    if (!clientState.closed) {
      let newUplink: UplinkClient | undefined = new UplinkClient(clientState, clientState.preferredServer)
      /**
       * 'gone' event only emits if NOT closed on purpose
       */
      newUplink.on('gone', () => {
        const thisUplink = UplinkServers.filter((r: any) => {
          return r.endpoint === newUplink?.url
        })
        if (thisUplink.length === 1) {
          thisUplink[0].errors++
        }

        /**
         * Select new uplink server (RR)
         */
        clientState.preferredServer = this.getUplinkServer(clientState)
        log(`{${clientState!.id}} Uplink gone, retry in 2000ms to [ ${clientState.preferredServer} ]`)

        if (typeof clientState !== 'undefined' && !clientState!.closed) {
          setTimeout(() => {
            newUplink = undefined
            clientState.uplink = undefined
            if (typeof clientState !== 'undefined' && !clientState!.closed) {
              clientState.counters.uplinkReconnects++
              log(`{${clientState!.id}} Reconnecting...`)
              this.connectUplink(clientState)
            }
          }, 2000)
        }
        return
      })

      newUplink.on('close', () => {
        setTimeout(() => {
          newUplink = undefined
        }, 5000)
      })

      newUplink.on('error', e => {
        log(`!!! newUplink error`, e.message)
      })

      newUplink.on('open', () => {
        newUplink!.send(JSON.stringify({id: 'NEW_CONNECTION_TEST', command: 'ping'}))

        const killNewUplinkTimeout = setTimeout(() => {
          try {
            newUplink!.close(0, 'ON_PURPOSE')
            newUplink = undefined
          } catch (e) {
            log('X1', e)
          }
          log(`{${clientState!.id}} !!! No incoming message within 10 sec from new uplink ${newUplink?.url}, close`)
        }, 10 * 1000)

        newUplink!.once('message', m => {
          log(`{${clientState!.id}} >> Got first message from uplink. First health check OK.`)

          /**
           * TODO: Opt in notify connected client with 'pseudo messages'
           * Only based on path or header, to prevent clients from breaking
           * if they actively check for rippled responses. Suggestion:
           * passthrough @ clientState (based on req » param / query)
           */

          // try {
          //   clientState.socket.send(JSON.stringify({
          //     state: 'CONNECTED'
          //   }))
          // } catch (e) {}

          clearTimeout(killNewUplinkTimeout)

          if (typeof newUplink !== 'undefined' && clientState.uplinkCount === newUplink?.getId()) {
            if (typeof clientState.uplink !== 'undefined') {
              log(`{${clientState!.id}} Switch uplinks. ` +
                `${clientState.uplink?.url} disconnects, ${newUplink?.url} connects`)
              clientState.uplink.close(0, 'ON_PURPOSE')
              clientState.uplink = undefined
            }

            // Uplink emits messages, switch the uplink
            clientState.uplink = newUplink

            // Flush buffer to uplink
            if (typeof clientState.uplinkMessageBuffer !== 'undefined' && clientState.uplinkMessageBuffer.length > 0) {
              log(`{${clientState!.id}} Replaying buffered messages:`, clientState.uplinkMessageBuffer.length)
              clientState.uplinkMessageBuffer.forEach(b => {
                ProxyMessageFilter(
                  b,
                  clientState,
                  {
                    send (safeData: string): void {
                      newUplink!.send(safeData)
                    },
                    submit: (safeData: string): void => {
                      this.submitTransaction(clientState, safeData)
                    },
                    reject (mockedResponse: string): void {
                      clientState?.socket?.send(mockedResponse)
                    }
                  }
                )
              })
              clientState.uplinkMessageBuffer = []
            }
          } else {
            try {
              newUplink!.close(0, 'ON_PURPOSE')
              log(`{${clientState!.id}} ${newUplink?.url} connected, but id expired`
                + ` (got ${newUplink!.getId()}, is at ${clientState.uplinkCount}). Closing.`)
            } catch (e) {
              log('X2', e)
            }
          }
        })

        return
      })
    } else {
      log(`Not connecting: state != closed.`)
    }
  }

  init (): void {
    this.WebSocketServer.on('error', (e: any) => {
      log(`!!! WebSocketServer error`, e)
    })

    this.WebSocketServer.on('connection', (ws: WebSocket, req: Request) => {
      let ip: string = req.connection.remoteAddress || ''
      if (typeof req.headers['x-forwarded-for'] !== 'undefined' && String(req.headers['x-forwarded-for']) !== '') {
        ip = String(req.headers['x-forwarded-for'])
      }

      const config = Config.get()
      const clientIpCount: number = Number(this.getClientIpCount(ip)) || 0
      const maxIpConnectionCount: number = config?.limits?.ipBasic || 8
      const whitelistedIp: boolean = Object.keys(config?.limits?.ipWhitelist || {}).indexOf(ip) > -1

      if (clientIpCount >= maxIpConnectionCount && !whitelistedIp) {
        log(`IP ${ip} kicked for exceeding IP limits (${clientIpCount}/${maxIpConnectionCount})`)

        const reason = `Connection (public) IP limit reached for ${ip}. Upgrade? https://forms.gle/FsXCvZsX7rapLAso8`

        SDLogger('RateLimit', {
          ip,
          rawHeaders: req.headers,
          ipLimit: true
        }, SDLoggerSeverity.ALERT)

        try {
          ws.close(1008, reason)
        } catch (e) {
          log('X4', e)
        }

        return
      } else {
        connectionId++

        let clientState: Client | undefined = {
          id: connectionId,
          closed: false,
          uplinkType: 'basic',
          preferredServer: '',
          socket: ws,
          request: req,
          uplinkMessageBuffer: [],
          uplinkSubscriptions: [],
          ip: ip,
          connectMoment: new Date(),
          counters: {rxCount:0, txCount:0, rxSize:0, txSize: 0, uplinkReconnects: 0},
          uplinkCount: 0,
          headers: {
            'origin': String(req.headers['origin'] || ''),
            'userAgent': String(req.headers['user-agent'] || ''),
            'acceptLanguage': String(req.headers['accept-language'] || ''),
            'xForwardedFor': String(req.headers['x-forwarded-for'] || ''),
            'requestUrl': String(req?.url || '')
          },
          uplinkLastMessages: []
        }
        clientState.preferredServer = this.getUplinkServer(clientState)

        // No overall Connection logging, disabled: StackDriver hammering
        // SDLogger('Connection', {
        //   ip: clientState?.ip,
        //   headers: clientState?.headers,
        //   preferredServer: clientState?.preferredServer
        // }, SDLoggerSeverity.INFO)

        log(`{${clientState!.id}} New connection from [ ${clientState.ip} ], ` +
          `origin: [ ${clientState.headers.origin || ''} ]`)

        this.connectUplink(clientState)

        this.Clients.push(clientState)
        metrics.connections.inc()
        metrics.clients.set(this.Clients.length)

        const pingInterval = setInterval(() => {
          ws.ping()
          // log('sendping')
        }, 15 * 1000)

        let pingTimeout: any
        ws.on('pong', () => {
          // log('gotpong')
          clearTimeout(pingTimeout)
          pingTimeout = setTimeout(() => {
            log(`{${clientState!.id}} ` + 'No pong for 2 (15 sec) intervals')
            ws.terminate()
          }, 2 * 15 * 1000)
        })

        ws.on('migrate', () => {
          clientState!.preferredServer = this.getUplinkServer(clientState!)
          this.connectUplink(clientState!)
        })

        ws.on('message', (message: string) => {
          let relayMessage = true
          logMsg(`{${clientState!.id}} Received request: %s`, message)
          clientState!.counters.txCount++
          clientState!.counters.txSize += message.length

          if (message.length <= 1024) {
            try {
              const messageJson = JSON.parse(message)
              if (typeof messageJson.__api !== 'undefined') {
                relayMessage = false
                if (messageJson.__api === 'state') {
                  ws.send(JSON.stringify({
                    id: messageJson?.id || undefined,
                    status: 'CONNECTED',
                    type: 'PROXY',
                    endpoint: typeof clientState!.uplink !== 'undefined' ? clientState!.uplink?.url : null,
                    preferredServer: clientState!.preferredServer,
                    uplinkType: clientState!.uplinkType,
                    counters: clientState!.counters,
                    headers: clientState!.headers,
                    uplinkCount: clientState!.uplinkCount,
                    connectMoment: clientState!.connectMoment
                  }))
                }
                if (messageJson.__api === 'upgrade') {
                  /**
                   * Todo: verification, payments, ...
                   */
                  clientState!.uplinkType = 'priority'
                  // clientState.preferredServer = this.getUplinkServer(clientState)
                  // this.connectUplink(clientState)
                  ws.emit('migrate')
                }
                if (messageJson.__api === 'downgrade') {
                  clientState!.uplinkType = 'basic'
                  // clientState.preferredServer = this.getUplinkServer(clientState)
                  // this.connectUplink(clientState)
                  ws.emit('migrate')
                }
              }
            } catch (e) {
              if (e.message !== 'Unexpected end of JSON input') {
                log('X3', e)
              }
            }
          }

          if (relayMessage) {
            if (typeof clientState!.uplink !== 'undefined'
              && clientState!.uplink.readyState === clientState!.uplink.OPEN) {
              ProxyMessageFilter(
                message,
                clientState,
                {
                  send (safeData: string): void {
                    clientState!.uplink!.send(safeData)
                  },
                  submit: (safeData: string): void => {
                    this.submitTransaction(clientState!, safeData)
                  },
                  reject (mockedResponse: string): void {
                    clientState?.socket?.send(mockedResponse)
                  }
                }
              )
            } else {
              // BUFFER MESSAGE
              clientState!.uplinkMessageBuffer.push(message)
              log(`{${clientState!.id}} Storing new buffered message`)
            }

            const mLength = Config.get()?.monitoring?.ClientCommandHistory || 10
            if (message.indexOf('"command":"ping"') < 0) {
              clientState!.uplinkLastMessages.unshift(`${clientState!.counters.txCount}:${message}`)
              clientState!.uplinkLastMessages = clientState!.uplinkLastMessages.slice(0, mLength)
            }
          }
        })

        ws.on('error', e => {
          log(`!!! ws error`, e)
          ws.close()
        })

        ws.on('close', (code: number, reason: string) => {
          clientState!.closed = true

          const thisClient = this.Clients.filter(c => {
            return c.socket === ws
          })

          if (thisClient.length === 1) {
            this.Clients.splice(this.Clients.indexOf(thisClient[0]), 1)
            metrics.clients.set(this.Clients.length)
          } else {
            log(`!!! ERROR! CANNOT SPLICE CLIENTS FOR CLIENT WITH ID [ ${clientState!.id} ]`)
          }

          log(`{${clientState!.id}} Closed socket @code`, code, reason)

          if (typeof clientState !== 'undefined') {
            if (typeof clientState!.uplink !== 'undefined') {
              clientState!.uplink.close()
            }
            if (typeof clientState!.uplinkMessageBuffer !== 'undefined') {
              clientState!.uplinkMessageBuffer = []
            }
          }

          clearInterval(pingInterval)
          clearTimeout(pingTimeout)

          if (typeof clientState!.submitClient !== 'undefined') {
            clientState!.submitClient.closed = true
            if (typeof clientState!.submitClient!.uplink !== 'undefined') {
              clientState!.submitClient!.uplink.close()
            }
            setTimeout(() => {
              if (typeof clientState !== 'undefined') {
                if (typeof clientState!.submitClient !== 'undefined') {
                  if (typeof clientState!.submitClient!.uplink !== 'undefined') {
                    clientState!.submitClient!.uplink = undefined
                  }
                }
                if (typeof clientState!.submitClient !== 'undefined') {
                  clientState!.submitClient = undefined
                }
                if (typeof clientState!.uplinkMessageBuffer !== 'undefined') {
                  clientState!.uplinkMessageBuffer = []
                }
              }
            }, 500)
          }

          setTimeout(() => {
            clientState!.uplink = undefined
            setTimeout(() => {
              clientState = undefined
            }, 100)
          }, 1000)
        })
      } // else: not IP limited
    })
  }
}

export default ProxyServer
