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
        debugLog('Error sending live notification', e.message)
      }
    }
  }
}

const Store = async (text: string = '', data: Object = {}, severity:Severity = Severity.DEFAULT): Promise<void> => {
  if (glog) {
    const metadata = {severity: Severity[severity]}
    const entry = glog.entry(metadata, Object.assign({text: text}, Object.assign(data, {hostname})))

    if (Object.keys(data).indexOf('liveNotification') > -1) {
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
  }

  return Promise.resolve()
}

export {
  Severity,
  Store
}
