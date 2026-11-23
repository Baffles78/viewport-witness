import { describe, expect, it, vi } from 'vitest'
import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose'
import { createCdpLookupClient } from '../src/cdp/existing-account.js'
import { serializeCdpJson } from '../src/cdp/json.js'
import { requestCdpJson, CDP_RESPONSE_BYTES } from '../src/cdp/request.js'

const address = `0x${'11'.repeat(20)}` as const
const signature = `0x${'22'.repeat(65)}`
const typedData = {
  domain: {
    chainId: 8453,
    name: 'USD Coin',
    version: '2',
    verifyingContract: `0x${'33'.repeat(20)}` as const,
  },
  types: { TransferWithAuthorization: [{ name: 'value', type: 'uint256' }] },
  primaryType: 'TransferWithAuthorization',
  message: { value: 80000n },
}
async function fixture() {
  const pair = await generateKeyPair('ES256', { extractable: true })
  const pem = await exportPKCS8(pair.privateKey)
  return {
    pair,
    credentials: {
      apiKeyId: 'synthetic-key',
      apiKeySecret: pem,
      walletSecret: pem.replace(/-----[^-]+-----|\s/g, ''),
    },
  }
}

describe('existing Coinbase account only', () => {
  it('looks up without wallet authorization, then binds signing JWT to complete sent EIP712 body', async () => {
    const { pair, credentials } = await fixture()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(JSON.stringify(init?.method === 'GET' ? { address } : { signature }))
    }) as unknown as typeof fetch
    const client = createCdpLookupClient(credentials, { fetchFn })
    expect(Object.keys(client)).toEqual(['evm'])
    const account = await client.evm.getAccount({ address })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init.method).toBe('GET')
    expect(new Headers(calls[0]?.init.headers).has('x-wallet-auth')).toBe(false)
    expect(Object.keys(account).sort()).toEqual(['address', 'signTypedData'])
    expect(await account.signTypedData(typedData)).toBe(signature)
    expect(calls).toHaveLength(2)
    const signed = calls[1]!
    expect(signed.url).toBe(
      `https://api.cdp.coinbase.com/platform/v2/evm/accounts/${address}/sign/typed-data`,
    )
    expect(signed.init.redirect).toBe('error')
    expect(signed.init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(signed.init.body))
    expect(body.message.value).toBe('80000')
    expect(body.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ])
    const headers = new Headers(signed.init.headers)
    const api = await jwtVerify(headers.get('authorization')!.slice(7), pair.publicKey)
    const wallet = await jwtVerify(headers.get('x-wallet-auth')!, pair.publicKey)
    expect(api.payload.uris).toEqual([
      `POST api.cdp.coinbase.com/platform/v2/evm/accounts/${address}/sign/typed-data`,
    ])
    expect(wallet.payload.uris).toEqual(api.payload.uris)
    expect(wallet.payload.reqHash).toBe(serializeCdpJson(body).hash)
  })

  it('refuses identity mismatch and malformed signature, never retries signing', async () => {
    const { credentials } = await fixture()
    const mismatch = vi.fn(
      async () => new Response(JSON.stringify({ address: `0x${'44'.repeat(20)}` })),
    )
    await expect(
      createCdpLookupClient(credentials, {
        fetchFn: mismatch as unknown as typeof fetch,
      }).evm.getAccount({ address }),
    ).rejects.toThrow('different account')
    expect(mismatch).toHaveBeenCalledTimes(1)
    let attempts = 0
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify(++attempts === 1 ? { address } : { signature: 'private-provider-error' }),
        ),
    )
    const account = await createCdpLookupClient(credentials, {
      fetchFn: fetchFn as unknown as typeof fetch,
    }).evm.getAccount({ address })
    await expect(account.signTypedData(typedData)).rejects.toThrow(
      'CDP typed-data signing failed or is uncertain',
    )
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does not send malformed signing inputs or leak provider failures', async () => {
    const { credentials } = await fixture()
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ address })))
    const account = await createCdpLookupClient(credentials, {
      fetchFn: fetchFn as unknown as typeof fetch,
    }).evm.getAccount({ address })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(account.signTypedData({ ...typedData, message: cyclic })).rejects.toThrow(
      'CDP typed-data signing failed or is uncertain',
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const errorFetch = vi.fn(async () => {
      throw new Error('secret-wallet-credential')
    })
    await expect(
      createCdpLookupClient(credentials, {
        fetchFn: errorFetch as unknown as typeof fetch,
      }).evm.getAccount({ address }),
    ).rejects.toThrow('CDP account request failed or is uncertain')
    expect(errorFetch).toHaveBeenCalledTimes(1)
  })
})

describe('bounded fixed-origin CDP requests', () => {
  const endpoint = new URL(`https://api.cdp.coinbase.com/platform/v2/evm/accounts/${address}`)
  it('rejects new origins and methods before attaching credentials to a request', async () => {
    const fetchFn = vi.fn()
    await expect(
      requestCdpJson(
        new URL(`https://evil.example/platform/v2/evm/accounts/${address}`),
        'GET',
        { Authorization: 'synthetic' },
        undefined,
        fetchFn,
      ),
    ).rejects.toThrow('not supported')
    await expect(requestCdpJson(endpoint, 'POST', {}, '{}', fetchFn)).rejects.toThrow(
      'not supported',
    )
    await expect(
      requestCdpJson(endpoint, 'DELETE' as 'GET', {}, undefined, fetchFn),
    ).rejects.toThrow('not supported')
    await expect(
      requestCdpJson(
        new URL(`${endpoint.href}/sign/typed-data`),
        'POST',
        {},
        'x'.repeat(65537),
        fetchFn,
      ),
    ).rejects.toThrow('not supported')
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('rejects redirects without retrying or forwarding authentication to another host', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      return new Response(null, {
        status: 307,
        headers: { location: 'https://evil.example/collect' },
      })
    })
    await expect(
      requestCdpJson(
        endpoint,
        'GET',
        { Authorization: 'synthetic' },
        undefined,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow('CDP account request failed')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('bounds declared and chunked response bodies and rejects malformed JSON shapes', async () => {
    let cancelled = false
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CDP_RESPONSE_BYTES + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    for (const response of [
      new Response('{}', { headers: { 'content-length': String(CDP_RESPONSE_BYTES + 1) } }),
      new Response(chunked),
      new Response('[1,2]'),
      new Response('not json'),
      new Response('secret-provider-message', { status: 500 }),
    ]) {
      await expect(
        requestCdpJson(endpoint, 'GET', {}, undefined, (async () => response) as typeof fetch),
      ).rejects.toThrow('CDP account request failed or is uncertain')
    }
    expect(cancelled).toBe(true)
  })
  it('includes stalled chunk consumption and uncooperative fetch in the total deadline', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    await expect(
      requestCdpJson(endpoint, 'GET', {}, undefined, (async () => response) as typeof fetch, 10),
    ).rejects.toThrow('CDP account request failed')
    expect(cancelled).toBe(true)
    await expect(
      requestCdpJson(
        endpoint,
        'GET',
        {},
        undefined,
        (() => new Promise(() => undefined)) as typeof fetch,
        10,
      ),
    ).rejects.toThrow('CDP account request failed')
  })
  it('cancels a stalled body when an uncooperative fetch resolves after its deadline', async () => {
    let resolve!: (response: Response) => void
    let cancelled = false
    const fetchFn = () =>
      new Promise<Response>((complete) => {
        resolve = complete
      })
    await expect(
      requestCdpJson(endpoint, 'GET', {}, undefined, fetchFn as typeof fetch, 5),
    ).rejects.toThrow('CDP account request failed')
    resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
      ),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(cancelled).toBe(true)
  })
})
