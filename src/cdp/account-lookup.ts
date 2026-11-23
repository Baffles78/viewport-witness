import { createCdpAuth, type ApiCredentials } from './auth.js'
import { CDP_API_ORIGIN, requestCdpJson } from './request.js'

/** API-key-only read. Never constructs signing capability or uses a Wallet Secret. */
export async function lookupCdpAccount(
  credentials: ApiCredentials,
  address: string,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('CDP account address is invalid.')
  const endpoint = new URL(`/platform/v2/evm/accounts/${address}`, CDP_API_ORIGIN)
  const token = await createCdpAuth(credentials)('GET', endpoint)
  const account = await requestCdpJson(
    endpoint,
    'GET',
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    undefined,
    options.fetchFn,
    options.timeoutMs,
  )
  if (
    typeof account.address !== 'string' ||
    account.address.toLowerCase() !== address.toLowerCase()
  )
    throw new Error('CDP returned a different account; signing refused')
  return { address }
}
