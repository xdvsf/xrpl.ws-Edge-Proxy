'use strict'

import Debug from 'debug'
import {Client} from '../handler/types'
import {get as GetConfig} from '../config'
import fetch from 'node-fetch'
import Codec from 'ripple-binary-codec'
import {Severity as SDLoggerSeverity, Store as SDLogger} from '../logging/'

const log = Debug('app').extend('filter')
const txroutelog = log.extend('txrouting')

log('Init Proxy MessageFilter')

interface StringMapNumber { [key: string]: number }
interface StringMapString { [key: string]: string }
interface StringMapAny { [key: string]: any }

const filteredByIp: StringMapNumber = {}
const filteredByDestination: StringMapString = {}
const filteredByFee: StringMapNumber = {}
const advisoryAccounts: StringMapAny = {}

const destinationTagMissingAccounts: StringMapAny = {}
const filteredByDestinationTagMissing: StringMapNumber = {}

const advisoryData = {
  levels: {
    E: 'ERROR',
    0: 'UNKNOWN',
    1: 'PROBABLE',
    2: 'HIGH_PROBABILITY',
    3: 'CONFIRMED'
  },
  accounts: advisoryAccounts,
  update: 0,
  updating: false
}

const updateAdvisory = async () => {
  log('<< UPDATING ADVISORY >>')
  const config = await GetConfig()
  advisoryData.updating = true

  try {
    const authCall = await fetch('https://api.xrplorer.com/v1/auth', {
      headers: {'Content-type': 'application/json'},
      method: 'post',
      timeout: 10000,
      redirect: 'follow',
      follow: 3,
      body: JSON.stringify(config.credentials.xrpforensics)
    })
    const authData = await authCall.json()

    const data = await fetch('https://api.xrplorer.com/v1/advisorylist', {
      headers: {Authorization: 'Bearer ' + authData?.access_token},
      method: 'get',
      timeout: 10000,
      redirect: 'follow',
      follow: 3
    })
    const json = await data.json()

    if (Object.keys(json).length < 100) {
      throw new Error('Invalid advisory repsonse (keylen)')
    }

    advisoryData.update = Math.round(+(new Date()) / 1000)
    advisoryData.updating = false

    Object.assign(advisoryData.accounts, json)

    log(`Updated advisory data: ${Object.keys(json).length} accounts`)
    // log(json)

    return true
  } catch (e) {
    advisoryData.updating = false
    log('Error updating advisory data', (e as any).message)

    return false
  }
}
const destinationTagData = {
  accounts: destinationTagMissingAccounts,
  update: 0,
  updating: false
}

const updateDestinationTagRequired = async () => {
  log('<< UPDATING DESTINATION TAG LIST >>')
  destinationTagData.updating = true

  try {
    const data = await fetch('https://xrpl.ws-stats.com/lists/f:dtag_accounts_without_flag', {
      method: 'get', timeout: 7500, redirect: 'follow', follow: 3
    })
    const t = await data.text()
    const json = t.split(`\n`).reduce((a, b) => {
      const match = b.match(/^(.*?)(r[a-zA-Z0-9]{18,})(.*?)$/)
      if (match) {
        Object.assign(a, {
          [match[2]]: (match[1].replace(/[,; ]*$/g, '') + ' ' + match[3].replace(/[,; ]*$/g, '')).trim()
        })
      }
      return a
    }, {})

    if (Object.keys(json).length < 50) {
      throw new Error('Invalid destination tag list repsonse (keylen)')
    }

    Object.assign(destinationTagData.accounts, json)
    destinationTagData.update = Math.round(+(new Date()) / 1000)
    destinationTagData.updating = false

    log(`Updated destination tag data: ${Object.keys(json).length} accounts`)

    return true
  } catch (e) {
    destinationTagData.updating = false
    log('Error destination tag data', (e as any).message)

    return false
  }
}

type Command = {
  id ?: any
}

const assignFakeResponseValue = (messageObject: Command, key: string, value: string) => {
  if (typeof messageObject?.id === 'undefined') {
    messageObject.id = '__fake_value_' + key + ':' + value
  } else if (typeof messageObject?.id !== 'object') {
    if (typeof messageObject?.id === 'string') {
      messageObject.id += '|__fake_value_' + key + ':' + value
    } else{
      messageObject.id = {
        __fake_value: key + ':' + value,
        __original_value: messageObject?.id
      }
    }
  } else if (typeof messageObject?.id === 'object' && typeof messageObject?.id !== null) {
    messageObject.id = {
      __fake_value: key + ':' + value,
      __original_value: messageObject?.id
    }
  }
}

export const Stats = {
  filteredCount: 0,
  filteredByIp,
  filteredByDestination,
  filteredByFee,
  filteredByDestinationTagMissing
}

type FilterCallbacks = {
  send: Function
  nonfh: Function
  path: Function
  reporting: Function
  submit: Function
  reject: Function
}

export default (
  message: string,
  clientState: Client | undefined,
  callback: FilterCallbacks
): boolean => {
  const messageObject: StringMapAny = {}
  const decodedTransaction: StringMapAny = {}
  let liveNotification = true

  const data = {
    messageString: message.toString().trim(),
    messageObject
  }

  try {
    if (data.messageString.slice(0, 1) === '{' && data.messageString.slice(-1) === '}') {
      // Basic check: valid JSON
      data.messageObject = JSON.parse(data.messageString)

      if (typeof data.messageObject === 'object' &&
        typeof data.messageObject.command !== 'undefined'
      ) {
        if (data.messageObject.command.toLowerCase() === 'submit' &&
          typeof data.messageObject.tx_blob === 'string'
        ) {
          const txHex = data.messageObject.tx_blob.toUpperCase()
          if (txHex.match(/^[A-F0-9]+$/)) {
            try {
              Object.assign(decodedTransaction, Codec.decode(txHex))
              if (clientState?.uplinkType !== 'submit') {
                SDLogger('TX Submit JSON', {
                  ip: clientState?.ip,
                  transaction: decodedTransaction
                }, SDLoggerSeverity.INFO)
              }
            } catch (e) {
              log(`Error decoding SUBMIT transaction hex: ${(e as any).message}`)
            }
          } else {
            log(`SUBMIT transaction hex is NOT HEX`)
          }
        } else {
          if (data.messageObject.command !== 'ping') {
            SDLogger('WS Command', {
              ip: clientState?.ip,
              data: data.messageObject
            }, SDLoggerSeverity.NOTICE)
          }
        }
      }
    }

    /**
     * Block blacklisted accounts (Advisory)
     */
    if (typeof decodedTransaction.Destination === 'string') {
      // It's a transaction TO someone (trying to send to a scammer)
      if (typeof advisoryAccounts[decodedTransaction.Destination] === 'object' &&
        advisoryAccounts[decodedTransaction.Destination] !== null &&
        typeof advisoryAccounts[decodedTransaction.Destination].address === 'string' &&
        typeof advisoryAccounts[decodedTransaction.Destination].status === 'number'
      ) {
        const address = advisoryAccounts[decodedTransaction.Destination].address
        const status = advisoryAccounts[decodedTransaction.Destination].status

        // Stats counter
        Object.assign(filteredByDestination, {
          [decodedTransaction.Destination]: typeof filteredByDestination[decodedTransaction.Destination] !== 'undefined'
            ? filteredByDestination[decodedTransaction.Destination] + 1
            : 1
        })

        if (status >= 3) {
          try {
            fetch('https://xrpl.ws-stats.com/reporting/scamblock', {
              headers: {'Content-type': 'application/json'},
              method: 'post', timeout: 5000, redirect: 'follow', follow: 3,
              body: JSON.stringify({
                decodedTransaction,
                headers: clientState?.headers
              })
            })
          } catch (e) {
            //
          }

          throw new Error(`DESTINATION ACCOUNT ${address} FOUND IN ADVISORY, level ${status}`)
        }
      }
    }

    if (typeof decodedTransaction.Account === 'string') {
      // It's a transaction FROM someone (scammer trying to send something)
      if (typeof advisoryAccounts[decodedTransaction.Account] === 'object' &&
        advisoryAccounts[decodedTransaction.Account] !== null &&
        typeof advisoryAccounts[decodedTransaction.Account].address === 'string' &&
        typeof advisoryAccounts[decodedTransaction.Account].status === 'number'
      ) {
        const address = advisoryAccounts[decodedTransaction.Account].address
        const status = advisoryAccounts[decodedTransaction.Account].status

        if (status >= 1) {
          // throw new Error(`ACCOUNT ${address} FOUND IN ADVISORY, level ${status}`)
          // Don't reject, allow, but log
          // TODO: move to separate counter (as this is not filtered but flagged/logged)
          Stats.filteredCount++
          SDLogger('Reject transaction', {
            ip: clientState?.ip,
            headers: clientState?.headers,
            transaction: decodedTransaction,
            reason: `SENDING ACCOUNT ${address} FOUND IN ADVISORY, level ${status}`,
            soft: true
          }, SDLoggerSeverity.CRITICAL)
        }
      }

      if (typeof decodedTransaction.Destination === 'string') {
        // It's a transaction TO someone
        if (
          typeof destinationTagData.accounts[decodedTransaction.Destination] !== 'undefined' &&
          (
            typeof decodedTransaction.DestinationTag === 'undefined' ||
            String(decodedTransaction.DestinationTag) === '0'
          )
        ) {
          const destinationAccount = decodedTransaction.Destination
          const destinationAccountName = destinationTagData.accounts[destinationAccount]
          if (Object.keys(Stats.filteredByDestinationTagMissing).indexOf(destinationAccountName) < 0) {
            Object.assign(Stats.filteredByDestinationTagMissing, {
              [destinationAccountName]: 1
            })
          } else {
            Stats.filteredByDestinationTagMissing[destinationAccountName]++
          }

          liveNotification = false
          const reason = `Destination Tag missing while required: ${destinationAccount} (${destinationAccountName})`
          SDLogger('Reject transaction', {
            ip: clientState?.ip,
            headers: clientState?.headers,
            reason,
            dtagMissing: {
              destination: destinationAccount,
              destinationName: destinationAccountName
            },
            transaction: decodedTransaction
          }, SDLoggerSeverity.NOTICE)
          try {
            fetch('https://xrpl.ws-stats.com/reporting/dtagfilter', {
              headers: {'Content-type': 'application/json'},
              method: 'post', timeout: 5000, redirect: 'follow', follow: 3,
              body: JSON.stringify({
                destinationAccount,
                destinationAccountName,
                decodedTransaction,
                headers: clientState?.headers
              })
            })
          } catch (e) {
            //
          }
          throw new Error(reason)
        }
      }
    }

    /**
     * Block fee > 1 XRP
     */
    if (typeof decodedTransaction.Fee === 'string') {
      let feeLimit: number = 2000000 // 2 XRP
      let feeDrops: number = 0
      try {
        feeDrops = Number(decodedTransaction.Fee)
      } catch (e) {
        //
      }

      if (typeof decodedTransaction.TransactionType === 'string') {
        if (decodedTransaction.TransactionType === 'AccountDelete') {
          feeLimit = 10000000 // 10 XRP
        }
      }

      if (decodedTransaction.TransactionType.match(/Check/i)) {
        throw new Error(`Submitting Check transactions currently disabled.`)
      }

      if (feeDrops > feeLimit) {
        if (clientState !== undefined) {
          Object.assign(filteredByFee, {
            [clientState.ip]: typeof filteredByFee[clientState.ip] !== 'undefined'
              ? filteredByFee[clientState.ip] + 1
              : 1
          })
        }

        throw new Error(`FEE ${feeDrops} EXCEEDS FEE LIMIT`)
      }
    }
  } catch (e) {
    Stats.filteredCount++
    if (clientState !== undefined) {
      Object.assign(filteredByIp, {
        [clientState.ip]: typeof filteredByIp[clientState.ip] !== 'undefined'
          ? filteredByIp[clientState.ip] + 1
          : 1
      })
    }

    log(`SUBMIT message filtered: ${(e as any).message}`)

    const mockedResponse = {
      result: {
        accepted: false,
        applied: false,
        broadcast: false,
        engine_result: 'telLOCAL_ERROR',
        engine_result_code: -399,
        engine_result_message: 'Local failure: ' + (e as any).message,
        kept: false,
        queued: false
      },
      status: 'success',
      type: 'response'
    }

    if (typeof data.messageObject === 'object' && data.messageObject !== null) {
      if (typeof data.messageObject.id !== 'undefined') {
        Object.assign(mockedResponse, {id: data.messageObject.id})
      }
      if (typeof data.messageObject.tx_blob !== 'undefined') {
        Object.assign(mockedResponse.result, {tx_blob: data.messageObject.tx_blob})
      }
    }

    // log('msg, mocked', mockedResponse)
    SDLogger('Reject transaction', {
      ip: clientState?.ip,
      headers: clientState?.headers,
      transaction: decodedTransaction,
      reason: (e as any).message,
      liveNotification
    }, SDLoggerSeverity.WARNING)

    callback.reject(JSON.stringify(mockedResponse))

    return false
  }

  // log(`_________ message:`, typeof message, `data.messageObject:`, typeof data.messageObject)

  const adminRejectionTemplate = {
    error: 'noPermission',
    error_code: 6,
    error_message: `You don't have permission for this command.`,
    generator: 'xrplcluster.com middleware',
    request: data.messageObject,
    id: data.messageObject?.id
  }

  if (data.messageObject?.command && data.messageObject?.command.match(/ledger/)) {
    if (data.messageObject?.full || data.messageObject?.accounts) {
      // Admin required
      callback.reject(JSON.stringify(adminRejectionTemplate))
      return false
    }
  }

  if (data.messageObject?.command === 'tx_history' && data.messageObject?.start) {
    if ((Number(data.messageObject?.start || 10000) || 10000) > 10000) {
      // Admin required
      callback.reject(JSON.stringify(adminRejectionTemplate))
      return false
    }
  }

  if (data.messageObject?.command === 'account_lines') {
    if (data.messageObject?.account === data.messageObject?.peer) {
      // TL to self doens't exist, prevent paging if issuer:

      // ASSIGN PASSHTROUGH RESPONSE VALUE IN ID TO REVERT IN RESPONSE

      assignFakeResponseValue(data.messageObject, 'account', data.messageObject.account)

      data.messageObject.account = 'rrrrrrrrrrrrrrrrrrrrBZbvji'
      // log(`\n\n\n\n\n\n\n\n`)
      log({REPLACE_ACCOUNT_AND_PEER_ACCOUT_LINES: data.messageObject})
      message = JSON.stringify(data.messageObject)
      // log(`\n\n\n\n\n\n\n\n`)
    }
  }

  // const timeBasedAdminCommands = []
  // if (Math.round(Number(new Date()) / 1000) > 1637105765 + 86400 * 1.1) {
  //   log('---------------UA', clientState?.headers?.userAgent)
  //   timeBasedAdminCommands.push()
  // }

  if ([
    'wallet_propose',
    'validation_create',
    'can_delete',
    'download_shard',
    'crawl_shards',
    'ledger_cleaner',
    'ledger_request',
    'log_level',
    'logrotate',
    'ledger_accept',
    'stop',
    'validation_seed',
    'sign',
    'sign_for',
    'connect',
    'peer_reservations_add',
    'peer_reservations_del',
    'peer_reservations_list',
    'peers',
    'consensus_info',
    'feature',
    'fetch_info',
    'print',
    'get_counts',
    'validator_info',
    'validator_list_sites',
    'validators',
    'ledger_closed'
    // 'gateway_balances', // Allow, actively being used by apps
    // 'account_currencies' // Allow, actively being used by apps
    // ...timeBasedAdminCommands
  ].indexOf(data.messageObject?.command) > -1) {
    // Admin required
    callback.reject(JSON.stringify(adminRejectionTemplate))
    return false
  }

  if (data.messageObject?.command === 'subscribe' && Array.isArray(data.messageObject?.streams)) {
    if (data.messageObject.streams.indexOf('peer_status') > -1) {
      // Admin required
      callback.reject(JSON.stringify(adminRejectionTemplate))
      return false
    }
  }

  if (data.messageObject?.secret
    || data.messageObject?.seed
    || data.messageObject?.seed_hex
    || data.messageObject?.passphrase
  ) {
    // Admin required
    callback.reject(JSON.stringify(adminRejectionTemplate))
    return false
  }

  // Limit results to 100
  if (data.messageObject?.limit) {
    const qLimit = 200
    if ((Number(data.messageObject?.limit || qLimit) || qLimit) > qLimit) {
      data.messageObject.limit = qLimit
      log({mo: data.messageObject})
      message = JSON.stringify(data.messageObject)
    }
  }

  if (
    (
      typeof decodedTransaction.TransactionType !== 'undefined'
      || (data.messageObject?.command || '').toLowerCase() === 'fee'
    )
    // Don't apply logic if connection is already of submit type (prevent endless recursion)
    && clientState?.uplinkType !== 'submit'
    && clientState?.uplinkType !== 'nonfh'
    && clientState?.uplinkType !== 'path'
    && clientState?.uplinkType !== 'reporting'
  ) {
    callback.submit(message)
  //  } else if (
  //    (data.messageObject?.command || '').toLowerCase()
  //      .match(/tx|lines|account_objects|ledger_data|ledger_entry/)
  //    && clientState?.uplinkType !== 'submit'
  //    && clientState?.uplinkType !== 'nonfh'
  //    && clientState?.uplinkType !== 'path'
  //    && clientState?.uplinkType !== 'reporting'
  //  ) {
  //    txroutelog('------- >>>>>> --- REPORTING:', data.messageObject?.command, data.messageObject)
  //    callback.reporting(message)
   } else if (
     (data.messageObject?.command || '').toLowerCase()
       .match(/path_/)
     && clientState?.uplinkType !== 'submit'
     && clientState?.uplinkType !== 'nonfh'
     && clientState?.uplinkType !== 'path'
     && clientState?.uplinkType !== 'reporting'
   ) {
     txroutelog('------- >>>>>> --- PATH:', data.messageObject?.command, data.messageObject)
     callback.path(message)
  } else if (
    (data.messageObject?.command || '').toLowerCase()
      .match(/^(account_.+|ledger|ledger_cl.+|gateway_b.+|ledger_.+|book_of.+|deposit_auth.+|.*path_.+)$/)
    && ([undefined, 'current', 'validated'].indexOf(data.messageObject?.ledger_index) > -1)
    && (data.messageObject?.command.toLowerCase() !== 'account_tx')
    // && (data.messageObject?.command.toLowerCase() !== 'account_info')
    && (typeof data.messageObject?.ledger_hash === 'undefined')
    && (typeof data.messageObject?.ledger_index_min === 'undefined')
    && (typeof data.messageObject?.ledger_index_max === 'undefined')
    && (typeof data.messageObject?.forward === 'undefined')
    && (typeof data.messageObject?.marker === 'undefined')
    // Don't apply logic if connection is already of submit type (prevent endless recursion)
    && clientState?.uplinkType !== 'submit'
    && clientState?.uplinkType !== 'nonfh'
    && clientState?.uplinkType !== 'path'
    && clientState?.uplinkType !== 'reporting'
  ) {
    txroutelog('------- >>>>>> --- NONFH:', data.messageObject?.command, data.messageObject)
    callback.nonfh(message)
  } else {
    // Send to FH server
    txroutelog('------- >>>>>> ---    FH:', data.messageObject?.command, data.messageObject)
    callback.send(message)
  }

  return true
}

updateAdvisory()
setInterval(updateAdvisory, 60 * 5 * 1000) // 5 minutes

updateDestinationTagRequired()
setInterval(updateDestinationTagRequired, 60 * 10 * 1000) // 10 minutes
