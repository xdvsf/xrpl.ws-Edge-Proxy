'use strict'

import WebSocket from 'ws'
import {Request} from 'express'
import {UplinkClient} from '../'

type Client = {
  id: number
  closed: boolean
  uplinkType: string
  preferredServer: string
  socket: WebSocket
  uplink?: UplinkClient
  submitClient?: Client
  nonfhClient?: Client
  uplinkCount: number
  uplinkMessageBuffer: string[]
  uplinkSubscriptions: string[]
  request: Request
  ip: string
  connectMoment: Date
  counters: {
    rxCount: number
    txCount: number
    rxSize: number
    txSize: number
    uplinkReconnects: number
  },
  headers: {
    'origin': string
    'userAgent': string
    'acceptLanguage': string
    'xForwardedFor': string
    'requestUrl': string
  },
  uplinkLastMessages: string[]
}

export default Client

