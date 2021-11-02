'use strict'

import Debug from 'debug'
import {ProxyServer} from './'
import {penalties} from './UplinkClient'
import {Client} from './types'
import {Request, Response} from 'express'
import {Stats as ProxyMessageFilterStats} from '../filtering/SubmitFilter'
const log = Debug('app').extend('HttpServer')
const logAdmin = log.extend('Admin')

// http://localhost:4001/status?counters=true&headers=true&noclients=true

class HttpServer {
  constructor (app: any, proxy: ProxyServer) {
    const getClientMap = (Clients: Array<Client>, req: Request) => {
      return Clients.map(c => {
        const headers = Object.keys(req.query).indexOf('headers') > -1
          ? {headers: c.headers}
          : {}

        const counters = Object.keys(req.query).indexOf('counters') > -1
          ? {
            counters: {
              messages: c.counters,
              state: {
                queue: this.lengthOrDetails(c.uplinkMessageBuffer, req),
                subscriptions: this.lengthOrDetails(c.uplinkSubscriptions, req)
              }
            }
          }
          : {}

        return {
          id: c.id,
          ip: c.ip,
          uptime: Math.ceil((new Date().getTime() - c.connectMoment.getTime()) / 1000),
          ...counters,
          ...headers,
          uplinkCount: c.uplinkCount,
          uplink: {
            state: c.socket.readyState,
            endpoint: c.uplink
              ? c.uplink!.url
              : null
          },
          uplinkLastMessages: c.uplinkLastMessages,
          ...(['nonfhClient', 'submitClient', 'reportingClient'].reduce((a, clientType) => {
            const _c = clientType === 'nonfhClient' ? c.nonfhClient
              : (clientType === 'submitClient' ? c.submitClient : c.reportingClient)

            const ccounters = _c && Object.keys(req.query).indexOf('counters') > -1
              ? {messages: _c.counters}
              : {}

            Object.assign(a, {
              [clientType]: {
                connected: _c !== undefined,
                details: _c === undefined
                  ? {}
                  : {
                    id: _c.id,
                    uptime: Math.ceil((new Date().getTime() - _c.connectMoment.getTime()) / 1000),
                    uplinkCount: _c.uplinkCount,
                    counters: {
                      ...ccounters,
                      state: {
                        queue: this.lengthOrDetails(_c.uplinkMessageBuffer, req)
                      }
                    },
                    uplink: {
                      state: _c.socket.readyState,
                      endpoint: _c.uplink
                        ? _c.uplink!.url
                        : null
                    }
                  }
              }
            })

            return a
          }, {}))
        }
      })
    }

    app.get('/', (req: Request, res: Response) => {
      res.send('rippled-ws-server')
    })
    /**
     * TODO: ADMIN
     */
    app.get('/kill/:client', (req: Request, res: Response) => {
      logAdmin('-- ADMIN KILL --')
      const matchingClient = proxy.getClients().filter(c => {
        return c.id === Number(req.params.client)
      })
      if (matchingClient.length === 1) {
        res.json({params: req.params, client: getClientMap(matchingClient, req)[0]})
        matchingClient[0].socket.close()
      } else {
        res.json({error: true})
      }
    })

    app.get('/uplink/:uplink/:action', (req: Request, res: Response) => {
      logAdmin('-- ADMIN UPLINK ACTION --')
      const matchingUplink = proxy.getUplinkServers().filter(s => {
        return s.id === req.params.uplink
      })
      if (matchingUplink.length === 1 && typeof matchingUplink[0].id === 'string') {
        proxy.updateUplinkServer(matchingUplink[0].id, req.params.action)
        res.json({params: req.params, uplink: matchingUplink[0].endpoint})
      } else {
        res.json({error: true})
      }
    })

    app.get('/add-uplink/:type/:proto/:uri/:hash', (req: Request, res: Response) => {
      logAdmin('-- ADMIN ADD UPLINK --')
      if (['basic', 'priority'].indexOf(req.params.type) > -1 && ['ws', 'wss'].indexOf(req.params.proto) > -1) {
        const uri = req.params.proto + '://' + req.params.uri + '/#' + req.params.hash
        proxy.addUplinkServer(req.params.type, uri)
        const newUplink = proxy.getUplinkServers().filter(s => {
          return s.type === req.params.type && s.endpoint === uri
        })
        res.json({params: req.params, uplink: newUplink})
      } else {
        res.json({error: true})
      }
    })

    app.get('/status', (req: Request, res: Response) => {
      logAdmin('-- ADMIN STATUS --')
      const clientDetails = Object.keys(req.query).indexOf('noclients') > -1
        ? {}
        : {clientDetails: getClientMap(proxy.getClients(), req)}
      res.json({
        clients: {
          call: {
            params: req.params,
            query: req.query
          },
          uplinks: proxy.getUplinkServers(),
          count: proxy.getClients().length,
          clientDetails,
          filter: ProxyMessageFilterStats
        },
        penalties
      })
    })
  }

  lengthOrDetails (object: Array<string | object>, req: Request): Array<string | object> | number {
    if (req.query.details) {
      return object
    }
    return object.length
  }
}

export default HttpServer
