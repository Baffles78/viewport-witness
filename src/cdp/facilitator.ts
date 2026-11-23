import { HTTPFacilitatorClient } from '@x402/core/server'
import { createCdpAuth, type ApiCredentials } from './auth.js'

export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402'

/** Preserve the official x402 transport and its bounded control-plane reader. */
export function createCdpFacilitatorClient(options: ApiCredentials & { baseUrl?: string }) {
  let endpoint: URL
  try {
    const configured = options.baseUrl ?? CDP_FACILITATOR_URL
    if (configured.length > 2048) throw new Error('invalid_endpoint')
    endpoint = new URL(configured)
  } catch {
    throw new Error('CDP facilitator endpoint is invalid.')
  }
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('CDP facilitator endpoint is invalid.')
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '')
  const base = endpoint.href.replace(/\/+$/, '')
  const authenticate = createCdpAuth(options)
  return new HTTPFacilitatorClient({
    url: base,
    createAuthHeaders: async () => {
      const token = async (operation: string, method: string) => ({
        Authorization: `Bearer ${await authenticate(method, new URL(`${base}/${operation}`))}`,
      })
      const [verify, settle, supported] = await Promise.all([
        token('verify', 'POST'),
        token('settle', 'POST'),
        token('supported', 'GET'),
      ])
      return { verify, settle, supported }
    },
  })
}
