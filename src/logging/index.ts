'use strict'

// import assert from 'assert'
import {hostname} from 'os'
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

const Store = async (text: string = '', data: Object = {}, severity:Severity = Severity.DEFAULT): Promise<void> => {
  if (glog) {
    const metadata = {severity: severity}
    const entry = glog.entry(metadata, Object.assign({text: text}, Object.assign(data, {hostname})))

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
