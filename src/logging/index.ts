'use strict'

// import assert from 'assert'
import {hostname} from 'os'
import Fetch from 'node-fetch'
import Debug from 'debug'
import {get as GetConfig} from '../config'
const debugLog = Debug('app:logger')

enum Severity {
  DEFAULT,
  DEBUG,
  INFO,
  NOTICE,
  WARNING,
  ERROR,
  CRITICAL,
  ALERT,
  EMERGENCY
}

interface LogLimitArray {
  [key: string]: number
}

interface LogLimit {
  [key: string]: LogLimitArray
}

const logLimits: LogLimit = {
  RateLimit: {},
  Connection: {}
}

const config = GetConfig()
let glog: any

if (typeof config.stackdriver !== 'undefined') {
  const {Logging} = require('@google-cloud/logging')
  const logging = new Logging({
    projectId: 'xrpledgerdata',
    credentials: config.stackdriver
  })
  glog = logging.log('rippled-ws-proxy')
}

const sendLiveNotification = (data: any = {}): void => {
  if (typeof config.notifications !== 'undefined') {
    if (typeof config.notifications.mattermost === 'string') {
      try {
        debugLog('(Sending live notification)')

        const keys = Object.keys(data)
        if ([
          'ip',
          'headers',
          'transaction',
          'reason'
        ].every(r => {
          return keys.indexOf(r) > -1
        })) {
          const soft = keys.indexOf('soft') > -1
          const reason = data?.reason
            .replace(/ (r[a-zA-Z0-9]{18,}) /, ' **`$1`** ')
            .replace(/( level )([0-9])/, '$1 `$2`')

          const fields:any = []

          fields.push({short: true, title: 'Action', value: '`' + (soft ? 'Reported & relayed' : 'BLOCKED') + '`'})
          fields.push({short: true, title: 'Edge Node', value: '`' + hostname + '`'})
          fields.push({short: true, title: 'IP', value: '`' + data?.ip + '`'})
          Object.keys(data?.headers).forEach(h => {
            if (String(data?.headers[h]) !== '') {
              fields.push({short: true, title: h, value: '`' + data?.headers[h] + '`'})
            }
          })
          fields.push({
            short: false,
            title: 'Transaction',
            value: '```' + `\n` + JSON.stringify(data?.transaction, null, 2) + `\n` + '```'
          })

          Fetch(config.notifications.mattermost, {
            method: 'post',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              text: `**${reason}**`,
              attachments: [
                {
                  fallback: 'Transaction by `' + data?.ip + '`',
                  color: soft ? '#FFCC00' : '#CA0000',
                  fields
                }
              ]
            })
          })
          // .then(r => r.text()).then(debugLog)
        }
      } catch (e) {
        debugLog('Error sending live notification', (e as any).message)
      }
    }
  }
}

const Store = async (text: string = '', data: Object = {}, severity:Severity = Severity.DEFAULT): Promise<void> => {
  if (glog) {
    /**
     * Suppress repeated log events (key in logLimits) to prevent StackDriver spamming
     */
    if (Object.keys(logLimits).indexOf(text) > -1) {
      const dataIpLoc = Object.keys(data).indexOf('ip')
      if (dataIpLoc > -1) {
        const ip = Object.values(data)[dataIpLoc]
        if (typeof logLimits[text][ip] !== 'undefined') {
          logLimits[text][ip]++
          debugLog(`Suppressed Stackdriver logging: ${text} @ ${ip} (occurred ${logLimits[text][ip]} time(s))`)
          return Promise.resolve()
        } else {
          logLimits[text][ip] = 1
          setTimeout(() => { delete logLimits[text][ip] }, 60 * 1000)
        }
      }
    }

    const metadata = {severity: Severity[severity]}
    try {
      const entry = glog.entry(metadata, Object.assign({text: text}, Object.assign(data, {hostname})))

      if (Object.keys(data).indexOf('liveNotification') > -1 && Boolean((data as any).liveNotification || false)) {
        sendLiveNotification(data)
      }

      await glog.write(entry, {resource: {type: 'global'}})
      if (
        severity === Severity.WARNING ||
        severity === Severity.ERROR ||
        severity === Severity.CRITICAL ||
        severity === Severity.ALERT ||
        severity === Severity.EMERGENCY
      ) {
        debugLog(`<STACKDRIVER> Logged: ${text}`)
      }
    } catch (e) {
      debugLog(`Stackdriver logging error: ${text} - err: ${(e as any).message}`)
    }
  }

  return Promise.resolve()
}

export {
  Severity,
  Store
}
