import { getTypesForEIP712Domain, type Address } from 'viem'
import type { ClientEvmSigner } from '@x402/evm'
import { createCdpAuth, createCdpWalletAuth, type WalletCredentials } from './auth.js'
import { serializeCdpJson } from './json.js'
import { CDP_API_ORIGIN, requestCdpJson } from './request.js'
import { lookupCdpAccount } from './account-lookup.js'

export type CdpExistingAccount = ClientEvmSigner
export interface CdpLookupClient {
  evm: { getAccount(options: { address: Address }): Promise<CdpExistingAccount> }
}

/** Only lookup and typed-data signing capabilities. No account creation or transaction methods. */
export function createCdpLookupClient(
  credentials: WalletCredentials,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): CdpLookupClient {
  credentials = { ...credentials }
  const { fetchFn, timeoutMs } = options
  const apiAuth = createCdpAuth(credentials)
  const walletAuth = createCdpWalletAuth(credentials.walletSecret)
  const call = async (endpoint: URL, method: 'GET' | 'POST', request?: unknown) => {
    const serialized = request !== undefined ? serializeCdpJson(request) : undefined
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await apiAuth(method, endpoint)}`,
      'Content-Type': 'application/json',
    }
    if (serialized)
      headers['X-Wallet-Auth'] = await walletAuth(method, endpoint, JSON.parse(serialized.body))
    return requestCdpJson(endpoint, method, headers, serialized?.body, fetchFn, timeoutMs)
  }
  return {
    evm: {
      getAccount: async ({ address }) => {
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('CDP account address is invalid.')
        const endpoint = new URL(`/platform/v2/evm/accounts/${address}`, CDP_API_ORIGIN)
        await lookupCdpAccount(credentials, address, options)
        return {
          address,
          signTypedData: async (parameters) => {
            try {
              // Snapshot before field access, rejecting accessors/cycles/non-JSON values.
              const clean = JSON.parse(serializeCdpJson(parameters).body) as Parameters<
                ClientEvmSigner['signTypedData']
              >[0]
              const domain = clean.domain ?? {}
              const request = {
                domain,
                types: { EIP712Domain: getTypesForEIP712Domain({ domain }), ...clean.types },
                primaryType: clean.primaryType,
                message: clean.message,
              }
              const result = await call(
                new URL(`${endpoint.href}/sign/typed-data`),
                'POST',
                request,
              )
              if (
                typeof result.signature !== 'string' ||
                !/^0x[a-fA-F0-9]{130}$/.test(result.signature)
              )
                throw new Error('invalid_signature')
              return result.signature as `0x${string}`
            } catch {
              throw new Error(
                'CDP typed-data signing failed or is uncertain; reconcile before retrying.',
              )
            }
          },
        }
      },
    },
  }
}
