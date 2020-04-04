'use strict'

import Debug from 'debug'
import {Client} from './types'
import fetch from 'node-fetch'
import Codec from 'ripple-binary-codec'

const log = Debug('app').extend('msg:filter')

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
    Object.assign(advisoryData.accounts, {
      ra5nK24KXen9AHvsdFTKHSANinZseWnPcX: {
        address: 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX',
        status: 3
      }
    })

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

export default (message: string, clientState: Client | undefined, send: Function): boolean => {
  try {
    const messageObject: StringMapAny = {}
    const decodedTransaction: StringMapAny = {}
    const data = {
      messageString: message.toString().trim(),
      messageObject
    }

    if (data.messageString.slice(0, 1) === '{' && data.messageString.slice(-1) === '}') {
      // Basic check: valid JSON
      data.messageObject = JSON.parse(data.messageString)

      if (typeof data.messageObject === 'object' &&
        typeof data.messageObject.command !== 'undefined' &&
        data.messageObject.command.toLowerCase() === 'submit' &&
        typeof data.messageObject.tx_blob === 'string'
      ) {
        const txHex = data.messageObject.tx_blob.toUpperCase()
        if (txHex.match(/^[A-F0-9]+$/)) {
          try {
            Object.assign(decodedTransaction, Codec.decode(txHex))
          } catch (e) {
            log(`Error decoding SUBMIT transaction hex: ${e.message}`)
          }
        } else {
          log(`SUBMIT transaction hex is NOT HEX`)
        }
      }
    }

    /**
     * Block blacklisted accounts (Advisory)
     */
    if (typeof decodedTransaction.Destination === 'string') {
      // It's a transaction TO someone.
      if (typeof advisoryAccounts[decodedTransaction.Destination] === 'object' &&
        advisoryAccounts[decodedTransaction.Destination] !== null &&
        typeof advisoryAccounts[decodedTransaction.Destination].address === 'string' &&
        typeof advisoryAccounts[decodedTransaction.Destination].status === 'number'
      ) {
        const address = advisoryAccounts[decodedTransaction.Destination].address
        const status = advisoryAccounts[decodedTransaction.Destination].status

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

    log('Relaying filtered (but apparently OK) UplinkClient Data')
    send(message)

    return true
  } catch (e) {
    Stats.filteredCount++
    if (clientState !== undefined) {
      Object.assign(filteredByIp, {
        [clientState.ip]: typeof filteredByIp[clientState.ip] !== 'undefined'
          ? filteredByIp[clientState.ip] + 1
          : 1
      })
    }

    log(`Message Filter Error: ${e.message}`)

    const fakeMessage = {
      ProxyMessageFiltered: true,
      Reason: e.message
    }

    send(JSON.stringify(fakeMessage))
  }

  return false
}

updateAdvisory()
setTimeout(updateAdvisory, 60 * 5 * 1000)
