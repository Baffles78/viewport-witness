import { afterEach, describe, expect, it, vi } from 'vitest'
import { address } from '@solana/kit'
import { BASE_NETWORK, SOLANA_NETWORK, createX402PaymentAdapter } from '../src/x402-adapter.js'
import type { PaymentAdapter, Requirement } from '../src/release-check.js'

const ENDPOINT = 'https://qa.honeygate.app/v1/checks'
const PAYEE = `0x${'22'.repeat(20)}`
const requirement = (): Requirement => ({
  scheme: 'exact',
  network: BASE_NETWORK,
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  payTo: PAYEE,
  amount: '80000',
  maxTimeoutSeconds: 60,
  extra: { name: 'USD Coin', version: '2' },
})
function input(
  approved = requirement(),
  key = 'release-test-0',
  signal = new AbortController().signal,
): Parameters<PaymentAdapter>[0] {
  return {
    url: ENDPOINT,
    request: {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'idempotency-key': key },
      body: JSON.stringify({ url: 'https://example.com' }),
    },
    challenge: { x402Version: 2, resource: { url: ENDPOINT }, accepts: [approved] },
    approvedRequirement: approved,
    maximumAtomic: '80000',
  }
}
function base(maxTotalUsdc = '0.16') {
  const sign = vi.fn(async () => `0x${'11'.repeat(65)}` as `0x${string}`)
  const send = vi.fn<typeof fetch>(async () => new Response('{}', { status: 202 }))
  const adapter = createX402PaymentAdapter({
    network: BASE_NETWORK,
    payTo: PAYEE,
    maxTotalUsdc,
    signer: { address: `0x${'11'.repeat(20)}`, signTypedData: sign },
    fetchFn: send,
  })
  return { adapter, sign, send }
}
afterEach(() => vi.unstubAllGlobals())

describe('customer x402 adapter', () => {
  it('uses the official Base SDK, binds the recipient and sends one signed request', async () => {
    const { adapter, sign, send } = base()
    sign.mockImplementation(async (...args: unknown[]) => {
      expect(args[0]).toMatchObject({ domain: { name: 'USD Coin', version: '2', chainId: 8453 } })
      return `0x${'11'.repeat(65)}` as `0x${string}`
    })
    expect((await adapter(input())).status).toBe(202)
    expect(sign).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    const request = send.mock.calls[0]![1]!
    const signature = new Headers(request.headers).get('payment-signature')!
    const payload = JSON.parse(Buffer.from(signature, 'base64').toString())
    expect(payload.accepted).toEqual(requirement())
    expect(payload.payload.authorization.to).toBe(PAYEE)
    expect(payload.payload.authorization.value).toBe('80000')
    expect(request.redirect).toBe('error')
  })
  it.each(['network', 'asset', 'payTo', 'amount', 'maxTimeoutSeconds'] as const)(
    'rejects a changed %s before signing',
    async (field) => {
      const { adapter, sign, send } = base()
      const changed = {
        ...requirement(),
        [field]: field === 'maxTimeoutSeconds' ? 301 : field === 'amount' ? '80001' : 'unexpected',
      }
      await expect(adapter(input(changed))).rejects.toThrow()
      expect(sign).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    },
  )
  it('rejects a different resource and Permit2 approval before signing', async () => {
    const { adapter, sign } = base()
    const wrong = input()
    wrong.challenge.resource.url = 'https://attacker.example/v1/checks'
    await expect(adapter(wrong)).rejects.toThrow()
    await expect(
      adapter(
        input({
          ...requirement(),
          extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' },
        }),
      ),
    ).rejects.toThrow()
    expect(sign).not.toHaveBeenCalled()
  })
  it('rejects a wrong Base token domain before wallet authorization', async () => {
    const { adapter, sign, send } = base()
    await expect(
      adapter(input({ ...requirement(), extra: { name: 'USDC', version: '2' } })),
    ).rejects.toThrow('EIP-3009')
    expect(sign).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('reserves budget before concurrent signing and forbids repeated attempts', async () => {
    const { adapter, sign } = base('0.08')
    const results = await Promise.allSettled([
      adapter(input()),
      adapter(input(requirement(), 'release-test-1')),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(sign).toHaveBeenCalledOnce()
    await expect(adapter(input())).rejects.toThrow('fresh release')
  })
  it('never retries an uncertain send or prints wallet secrets', async () => {
    const { adapter, sign, send } = base()
    send.mockRejectedValue(new Error('private RPC secret'))
    await expect(adapter(input())).rejects.toThrow('outcome is uncertain')
    expect(send).toHaveBeenCalledOnce()
    await expect(adapter(input())).rejects.toThrow('fresh release')
    const second = base()
    second.sign.mockRejectedValue(new Error('private wallet secret'))
    await expect(second.adapter(input())).rejects.toThrow(
      'Wallet authorization failed or is uncertain',
    )
    expect(second.send).not.toHaveBeenCalled()
    expect(sign).toHaveBeenCalledOnce()
  })
  it('does not sign an already aborted request', async () => {
    const { adapter, sign } = base()
    const abort = new AbortController()
    abort.abort()
    await expect(adapter(input(requirement(), 'release-test-0', abort.signal))).rejects.toThrow()
    expect(sign).not.toHaveBeenCalled()
  })
  it('uses the official Solana SDK with mocked mint RPC and a fake partial signature', async () => {
    const mint = Buffer.alloc(82)
    mint[44] = 6
    mint[45] = 1
    const rpc = vi.fn<typeof fetch>(async (_url, request) => {
      const call = JSON.parse(String(request?.body))
      expect(call.method).toBe('getAccountInfo')
      return Response.json({
        jsonrpc: '2.0',
        id: call.id,
        result: {
          context: { slot: 1 },
          value: {
            data: [mint.toString('base64'), 'base64'],
            executable: false,
            lamports: 1,
            owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            rentEpoch: 0,
            space: 82,
          },
        },
      })
    })
    vi.stubGlobal('fetch', rpc)
    const signerAddress = address('So11111111111111111111111111111111111111112')
    const sign = vi.fn(async (transactions: readonly unknown[]) =>
      transactions.map(() => ({ [signerAddress]: new Uint8Array(64) })),
    )
    const send = vi.fn<typeof fetch>(async () => new Response('{}', { status: 202 }))
    const feePayer = '11111111111111111111111111111111'
    const payTo = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const adapter = createX402PaymentAdapter({
      network: SOLANA_NETWORK,
      payTo,
      feePayer,
      maxTotalUsdc: '0.08',
      signer: { address: signerAddress, signTransactions: sign },
      fetchFn: send,
    })
    const quote = {
      ...requirement(),
      network: SOLANA_NETWORK,
      asset: payTo,
      payTo,
      extra: { feePayer, recentBlockhash: feePayer, lastValidBlockHeight: '1000' },
    }
    await expect(
      adapter(input({ ...quote, extra: { ...quote.extra, feePayer: signerAddress } })),
    ).rejects.toThrow('fee payer')
    expect(sign).not.toHaveBeenCalled()
    expect((await adapter(input(quote))).status).toBe(202)
    expect(rpc).toHaveBeenCalledOnce()
    expect(sign).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    const payload = JSON.parse(
      Buffer.from(
        new Headers(send.mock.calls[0]![1]!.headers).get('payment-signature')!,
        'base64',
      ).toString(),
    )
    expect(payload.accepted).toEqual(quote)
    expect(typeof payload.payload.transaction).toBe('string')
  })
  it('stops promptly on abort and prevents late Solana signing after a delayed RPC', async () => {
    let release!: (response: Response) => void
    const delayed = new Promise<Response>((resolve) => {
      release = resolve
    })
    const rpc = vi.fn<typeof fetch>(async () => delayed)
    vi.stubGlobal('fetch', rpc)
    const signerAddress = address('So11111111111111111111111111111111111111112')
    const sign = vi.fn(async (transactions: readonly unknown[]) =>
      transactions.map(() => ({ [signerAddress]: new Uint8Array(64) })),
    )
    const send = vi.fn<typeof fetch>()
    const feePayer = '11111111111111111111111111111111'
    const asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const adapter = createX402PaymentAdapter({
      network: SOLANA_NETWORK,
      payTo: asset,
      feePayer,
      maxTotalUsdc: '0.08',
      signer: { address: signerAddress, signTransactions: sign },
      fetchFn: send,
    })
    const quote = {
      ...requirement(),
      network: SOLANA_NETWORK,
      asset,
      payTo: asset,
      extra: { feePayer, recentBlockhash: feePayer, lastValidBlockHeight: '1000' },
    }
    const abort = new AbortController()
    const request = adapter(input(quote, 'release-test-0', abort.signal))
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
    const stopped = expect(request).rejects.toThrow('Wallet authorization failed or is uncertain')
    abort.abort()
    await stopped
    const mint = Buffer.alloc(82)
    mint[44] = 6
    mint[45] = 1
    const call = JSON.parse(String(rpc.mock.calls[0]![1]?.body))
    release(
      Response.json({
        jsonrpc: '2.0',
        id: call.id,
        result: {
          context: { slot: 1 },
          value: {
            data: [mint.toString('base64'), 'base64'],
            executable: false,
            lamports: 1,
            owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            rentEpoch: 0,
            space: 82,
          },
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sign).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
