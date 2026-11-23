import { describe, expect, it } from 'vitest'
import { generateKeyPair, exportPKCS8, exportJWK, jwtVerify } from 'jose'
import { createHash } from 'node:crypto'
import { createCdpAuth, createCdpWalletAuth } from '../src/cdp/auth.js'
import { serializeCdpJson } from '../src/cdp/json.js'
import { createCdpFacilitatorClient } from '../src/cdp/facilitator.js'

async function apiKeys(alg: 'ES256' | 'EdDSA') {
  const pair = await generateKeyPair(alg, { extractable: true })
  if (alg === 'ES256') return { ...pair, secret: await exportPKCS8(pair.privateKey) }
  const jwk = await exportJWK(pair.privateKey)
  return {
    ...pair,
    secret: Buffer.concat([
      Buffer.from(jwk.d!, 'base64url'),
      Buffer.from(jwk.x!, 'base64url'),
    ]).toString('base64'),
  }
}

describe('local Coinbase authentication parity', () => {
  for (const alg of ['ES256', 'EdDSA'] as const)
    it(`cryptographically verifies ${alg} API tokens with exact URI, TTL and fresh nonce`, async () => {
      const pair = await apiKeys(alg)
      const credentials = { apiKeyId: 'synthetic-project/key', apiKeySecret: pair.secret }
      const auth = createCdpAuth(credentials)
      credentials.apiKeyId = 'changed-after-construction'
      const endpoint = new URL('https://api.cdp.coinbase.com/platform/v2/x402/verify')
      const first = await jwtVerify(await auth('POST', endpoint), pair.publicKey)
      const second = await jwtVerify(await auth('POST', endpoint), pair.publicKey)
      expect(first.protectedHeader).toMatchObject({ alg, kid: 'synthetic-project/key', typ: 'JWT' })
      expect(first.protectedHeader.nonce).toMatch(/^[a-f0-9]{32}$/)
      expect(second.protectedHeader.nonce).not.toBe(first.protectedHeader.nonce)
      expect(first.payload).toMatchObject({
        sub: 'synthetic-project/key',
        iss: 'cdp',
        uris: ['POST api.cdp.coinbase.com/platform/v2/x402/verify'],
      })
      expect(first.payload.exp! - first.payload.iat!).toBe(120)
      expect(first.payload.nbf).toBe(first.payload.iat)
      await expect(auth('POST', new URL('https://user:secret@example.test/path'))).rejects.toThrow(
        'CDP request authentication failed',
      )
      await expect(
        createCdpAuth({ apiKeyId: 'id', apiKeySecret: 'secret-invalid' })('POST', endpoint),
      ).rejects.toThrow('CDP request authentication failed')
    })

  it('binds wallet JWT cryptographically to complete canonical body and exact URI', async () => {
    const pair = await apiKeys('ES256')
    const der = pair.secret.replace(/-----[^-]+-----|\s/g, '')
    const wallet = createCdpWalletAuth(der)
    const endpoint = new URL(
      'https://api.cdp.coinbase.com/platform/v2/evm/accounts/0x1111111111111111111111111111111111111111/sign/typed-data',
    )
    const request = {
      types: { EIP712Domain: [{ type: 'uint256', name: 'chainId' }] },
      message: { value: 80000n, nested: ['b', 'a'] },
      domain: { chainId: 8453 },
      primaryType: 'TransferWithAuthorization',
    }
    const verified = await jwtVerify(await wallet('POST', endpoint, request), pair.publicKey)
    expect(verified.payload.uris).toEqual([`POST ${endpoint.host}${endpoint.pathname}`])
    const expected =
      '{"domain":{"chainId":8453},"message":{"nested":["b","a"],"value":"80000"},"primaryType":"TransferWithAuthorization","types":{"EIP712Domain":[{"name":"chainId","type":"uint256"}]}}'
    expect(verified.payload.reqHash).toBe(createHash('sha256').update(expected).digest('hex'))
    expect(verified.payload.jti).toMatch(/^[a-f0-9]{32}$/)
    expect(verified.payload.reqHash).not.toBe(
      serializeCdpJson({ ...request, message: { ...request.message, nested: ['a', 'b'] } }).hash,
    )
  })

  it('uses per-operation facilitator auth for custom configured host and path', async () => {
    const pair = await apiKeys('ES256')
    const facilitator = createCdpFacilitatorClient({
      apiKeyId: 'fixture',
      apiKeySecret: pair.secret,
      baseUrl: 'https://configured.example.test/custom/root/',
    })
    for (const [operation, method] of [
      ['verify', 'POST'],
      ['settle', 'POST'],
      ['supported', 'GET'],
    ] as const) {
      const result = await facilitator.createAuthHeaders(operation)
      const token = result.headers.Authorization!.slice('Bearer '.length)
      const verified = await jwtVerify(token, pair.publicKey)
      expect(verified.payload.uris).toEqual([
        `${method} configured.example.test/custom/root/${operation}`,
      ])
    }
  })
})

describe('bounded canonical signing JSON', () => {
  it('preserves array order, sorts object keys and decimalizes BigInts', () => {
    expect(serializeCdpJson({ z: 1n, a: [2, 1] }).body).toBe('{"a":[2,1],"z":"1"}')
    expect(serializeCdpJson({ a: [2, 1], z: 1n }).hash).toBe(
      serializeCdpJson({ z: 1n, a: [2, 1] }).hash,
    )
  })
  it('rejects unsafe representations rather than invoking or dropping them', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throw new Error('must not invoke')
      },
    })
    const hiddenToJson = Object.defineProperty({}, 'toJSON', { value: () => 'changed' })
    const arrayExtra = Object.assign([1], { extra: 2 })
    const sparseExtra = Object.assign(Array(2), { 1: 'b', x: 'c' })
    const hiddenGetter = Object.defineProperty({}, 'value', {
      get() {
        throw new Error('must not invoke')
      },
    })
    for (const value of [
      cycle,
      accessor,
      hiddenGetter,
      hiddenToJson,
      arrayExtra,
      sparseExtra,
      new Date(),
      { value: undefined },
      { value: Infinity },
      { value: NaN },
      { value: () => 1 },
      { value: Symbol('x') },
      { toJSON: () => 'changed' },
      [1, , 3],
    ]) {
      expect(() => serializeCdpJson(value)).toThrow()
    }
  })
  it('enforces depth, nodes and escaped byte limits', () => {
    let deep: unknown = 1
    for (let n = 0; n < 22; n++) deep = { deep }
    expect(() => serializeCdpJson(deep)).toThrow('limit')
    expect(() => serializeCdpJson(Array.from({ length: 4096 }, () => 1))).toThrow('limit')
    expect(() => serializeCdpJson({ value: '\n'.repeat(40000) })).toThrow('limit')
    expect(() => serializeCdpJson({ value: 'x'.repeat(65537) })).toThrow('limit')
    expect(() => serializeCdpJson({ value: 10n ** 1024n })).toThrow('limit')
  })
})
