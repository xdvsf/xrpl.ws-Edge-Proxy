'use strict'

import Debug from 'debug'
import {Client} from '../handler/types'
import fetch from 'node-fetch'
import Codec from 'ripple-binary-codec'
import {Severity as SDLoggerSeverity, Store as SDLogger} from '../logging/'

const log = Debug('app').extend('filter')

log('Init Proxy MessageFilter')

interface StringMapNumber { [key: string]: number }
interface StringMapString { [key: string]: string }
interface StringMapAny { [key: string]: any }

const filteredByIp: StringMapNumber = {}
const filteredByDestination: StringMapString = {}
const filteredByFee: StringMapNumber = {}
const advisoryAccounts: StringMapAny = {}

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
  advisoryData.updating = true

  try {
    const data = await fetch('https://api.xrplorer.com/v1/advisorylist', {
      headers: {},
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
    log('Error updating advisory data', e.message)

    return false
  }
}

export const Stats = {
  filteredCount: 0,
  filteredByIp,
  filteredByDestination,
  filteredByFee
}

type FilterCallbacks = {
  send: Function
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
              log(`Error decoding SUBMIT transaction hex: ${e.message}`)
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
            soft: true,
            liveNotification: true
          }, SDLoggerSeverity.CRITICAL)
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

      if (feeDrops >= feeLimit) {
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

    log(`SUBMIT message filtered: ${e.message}`)

    const mockedResponse = {
      result: {
        accepted: false,
        applied: false,
        broadcast: false,
        engine_result: 'telLOCAL_ERROR',
        engine_result_code: -399,
        engine_result_message: 'Local failure: ' + e.message,
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
      reason: e.message,
      liveNotification: true
    }, SDLoggerSeverity.WARNING)

    callback.reject(JSON.stringify(mockedResponse))

    return false
  }

  if (
    typeof decodedTransaction.TransactionType !== 'undefined'
    // Don't apply logic if connection is already of submit type (prevent endless recursion)
    && clientState?.uplinkType !== 'submit'
  ) {
    // If decodedTransaction is filled, it's a Submit transaction
    // Send to Submit (sub proxy) logic

    // log(
    //   'Relaying filtered (but apparently OK) UplinkClient <<< TRANSACTION >>> Data',
    //   message,
    //   decodedTransaction
    // )

    callback.submit(message)
  } else {
    // Send to FH server

    // log(
    //   'Relaying filtered (but apparently OK) UplinkClient <<< NON-TRANSACTION (SUBMIT) >>> Data',
    //   message,
    //   decodedTransaction
    // )

    callback.send(message)
  }

  return true
}

updateAdvisory()
setInterval(updateAdvisory, 60 * 5 * 1000) // 5 minutes
