import Debug from 'debug'
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import * as http from 'http'
import WebSocket from 'ws'
import {ProxyServer, HttpServer} from './handler'

const posix = require('posix')
posix.setrlimit('nofile', {soft: 10000})

if (typeof process.env.JEST_WORKER_ID === 'undefined') {
  process.stdout.write(`<<< rippled-ws-proxy >>>\n\n`)
}

const log = Debug('app')

/**
 * WS server
 */
const app = express()
app.use(helmet({
  frameguard: {
    action: 'allow-from',
    domain: '*'
  }
}))

// @ts-ignore
app.use(cors())

const server = http.createServer(app)
const wss = new WebSocket.Server({server})

server.listen(process.env.PORT || 80, () => {
  const address = server.address()
  const port = typeof address !== 'string' ? address!.port || -1 : -1
  log(`WS server started at port ${port}`)
})

/**
 * Admin server
 */

const adminApp = express()
const adminServer = http.createServer(adminApp)
adminServer.listen(Number(process.env.PORT || 80) + 1, () => {
  const address = adminServer.address()
  const port = typeof address !== 'string' ? address!.port || -1 : -1
  log(`ADMIN server started at port ${port}`)
})

/**
 * Run proxy and Admin server
 */

const proxy = new ProxyServer(wss)
const admin = new HttpServer(adminApp, proxy)

/**
 * Remaining stuff
 */

const shutdown = async () => {
  return new Promise((resolve, reject) => {
    server.on('close', () => resolve(null))
    server.on('error', e => reject(e))
    server.close()

    adminServer.on('close', () => resolve(null))
    adminServer.on('error', e => reject(e))
    adminServer.close()
  })
}

export {
  shutdown
}
