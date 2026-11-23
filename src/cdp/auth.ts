import { randomBytes } from 'node:crypto'
import { importJWK, importPKCS8, SignJWT } from 'jose'
import { serializeCdpJson } from './json.js'

export interface ApiCredentials {
  apiKeyId: string
  apiKeySecret: string
}
export interface WalletCredentials extends ApiCredentials {
  walletSecret: string
}

function uri(method: string, url: URL): string {
  if (
    !['GET', 'POST'].includes(method) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new Error('cdp_invalid_endpoint')
  return `${method} ${url.host}${url.pathname}`
}

/** Immutable, instance-scoped credentials; no token cache or global SDK state. */
export function createCdpAuth(credentials: ApiCredentials) {
  const { apiKeyId, apiKeySecret } = credentials
  if (!apiKeyId || !apiKeySecret || apiKeyId.length > 300 || apiKeySecret.length > 16_384)
    throw new Error('CDP authentication is not configured.')
  const load = async () => {
    try {
      if (apiKeySecret.startsWith('-----BEGIN PRIVATE KEY-----'))
        return { key: await importPKCS8(apiKeySecret, 'ES256'), alg: 'ES256' }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(apiKeySecret)) throw new Error('invalid_key')
      const bytes = Buffer.from(apiKeySecret, 'base64')
      if (bytes.length !== 64) throw new Error('invalid_key')
      return {
        key: await importJWK(
          {
            kty: 'OKP',
            crv: 'Ed25519',
            d: bytes.subarray(0, 32).toString('base64url'),
            x: bytes.subarray(32).toString('base64url'),
          },
          'EdDSA',
        ),
        alg: 'EdDSA',
      }
    } catch {
      throw new Error('CDP authentication key could not be loaded.')
    }
  }
  let loaded: ReturnType<typeof load> | undefined
  return async (method: string, endpoint: URL): Promise<string> => {
    try {
      const requestUri = uri(method, endpoint)
      loaded ??= load()
      const { key, alg } = await loaded
      const now = Math.floor(Date.now() / 1000)
      return await new SignJWT({ sub: apiKeyId, iss: 'cdp', uris: [requestUri] })
        .setProtectedHeader({
          alg,
          kid: apiKeyId,
          typ: 'JWT',
          nonce: randomBytes(16).toString('hex'),
        })
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 120)
        .sign(key)
    } catch {
      throw new Error('CDP request authentication failed.')
    }
  }
}

/** Wallet authorization binds the complete immutable JSON request, not a subset. */
export function createCdpWalletAuth(walletSecret: string) {
  let loaded: ReturnType<typeof importPKCS8> | undefined
  return async (method: string, endpoint: URL, request: unknown): Promise<string> => {
    try {
      const requestUri = uri(method, endpoint)
      const { hash } = serializeCdpJson(request)
      if (
        !walletSecret ||
        walletSecret.length > 16_384 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(walletSecret)
      )
        throw new Error('invalid_key')
      loaded ??= importPKCS8(
        `-----BEGIN PRIVATE KEY-----\n${walletSecret}\n-----END PRIVATE KEY-----`,
        'ES256',
      )
      const now = Math.floor(Date.now() / 1000)
      return await new SignJWT({ uris: [requestUri], reqHash: hash })
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
        .setIssuedAt(now)
        .setNotBefore(now)
        .setJti(randomBytes(16).toString('hex'))
        .sign(await loaded)
    } catch {
      throw new Error('CDP wallet request authentication failed.')
    }
  }
}
