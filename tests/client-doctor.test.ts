import { describe, expect, it, vi } from 'vitest'
import { generateKeyPair, exportPKCS8 } from 'jose'
import { runDoctor } from '../src/client/doctor.js'
import { parseClientOptions } from '../src/client/options.js'
import { BASE_USDC } from '../src/client/balance.js'
import { SERVICE_ORIGIN, BASE_RPC } from '../src/client/network.js'

const address = `0x${'11'.repeat(20)}`
const recipient = `0x${'22'.repeat(20)}`
function transport(
  overrides: {
    amount?: string
    asset?: string
    network?: string
    payTo?: string
    balance?: bigint
    chain?: string
    account?: string
    rpcError?: boolean
  } = {},
) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input),
      headers = new Headers(init?.headers)
    expect(init?.redirect).toBe('error')
    expect(headers.has('payment-signature')).toBe(false)
    expect(headers.has('x-wallet-auth')).toBe(false)
    if (url === `${SERVICE_ORIGIN}/health`) return new Response('{"status":"ok"}')
    if (url === `${SERVICE_ORIGIN}/v1/checks`) {
      expect(headers.has('authorization')).toBe(false)
      const quote = {
        x402Version: 2,
        resource: { url },
        accepts: [
          {
            scheme: 'exact',
            network: overrides.network ?? 'eip155:8453',
            asset: overrides.asset ?? BASE_USDC,
            amount: overrides.amount ?? '80000',
            payTo: overrides.payTo ?? recipient,
            maxTimeoutSeconds: 60,
          },
        ],
      }
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': Buffer.from(JSON.stringify(quote)).toString('base64') },
      })
    }
    if (url.startsWith('https://api.cdp.coinbase.com/platform/v2/evm/accounts/')) {
      expect(init?.method).toBe('GET')
      expect(url).toBe(`https://api.cdp.coinbase.com/platform/v2/evm/accounts/${address}`)
      return new Response(JSON.stringify({ address: overrides.account ?? address }))
    }
    expect(url).toBe(`${BASE_RPC}/`)
    const request = JSON.parse(String(init?.body))
    if (overrides.rpcError) throw new Error('SENTINEL_PROVIDER_SECRET')
    if (request.method === 'eth_chainId')
      return Response.json({ jsonrpc: '2.0', id: request.id, result: overrides.chain ?? '0x2105' })
    expect(request.method).toBe('eth_call')
    expect(request.params[0].to).toBe(BASE_USDC)
    expect(request.params[0].data).toBe(`0x70a08231${address.slice(2).padStart(64, '0')}`)
    return Response.json({
      jsonrpc: '2.0',
      id: request.id,
      result: `0x${(overrides.balance ?? 80000n).toString(16).padStart(64, '0')}`,
    })
  }) as unknown as typeof fetch
}
const dependencies = (fetchFn = transport()) => ({
  fetchFn,
  validateTarget: async () => ({ valid: true }),
  osLookup: async () => true,
  nodeVersion: '22.12.0',
})
const options = () => parseClientOptions(['--url', 'https://example.com', '--recipient', recipient])

describe('read-only doctor', () => {
  it('keeps operator quotes excluded with allowlisted source and no run token or files', async () => {
    for (const source of ['monitor', 'test-client', 'SENTINEL_SOURCE']) {
      const fetchFn = transport()
      await runDoctor(options(), { VW_USAGE_SOURCE: source }, dependencies(fetchFn))
      const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
      const headers = new Headers(
        calls.find((call) => String(call[0]).endsWith('/v1/checks'))?.[1].headers,
      )
      expect(headers.get('x-viewportwitness-source')).toBe(
        source === 'SENTINEL_SOURCE' ? 'agent-client' : source,
      )
      expect(headers.has('x-viewportwitness-quickstart-run')).toBe(false)
    }
  })
  it('previews without files, signer, credential use or account requests', async () => {
    const fetchFn = transport()
    const result = await runDoctor(
      options(),
      { CDP_WALLET_SECRET: 'SENTINEL_WALLET_SECRET', CDP_API_KEY_SECRET: 'SENTINEL_API_SECRET' },
      dependencies(fetchFn),
    )
    expect(result.readyForPreview).toBe(true)
    expect(result.spendingApproved).toBe(false)
    expect(result.signingTested).toBe(false)
    expect(result.walletSecretValidated).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
  })
  it('reports strict resolver refusal despite diagnostic OS lookup working, without quote/account calls', async () => {
    const fetchFn = transport()
    const result = await runDoctor(
      options(),
      {},
      {
        ...dependencies(fetchFn),
        validateTarget: async () => ({ valid: false, reason: 'dns_error:resolver_failed' }),
      },
    )
    expect(result.readyForPreview).toBe(false)
    expect(result.stages.find((stage) => stage.stage === 'target_dns')?.code).toBe(
      'TARGET_DNS_FAILED',
    )
    expect(result.stages.find((stage) => stage.stage === 'os_dns')?.code).toBe(
      'OS_LOOKUP_OK_DIAGNOSTIC_ONLY',
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('does not recommend alternate DNS for a private target', async () => {
    const result = await runDoctor(
      options(),
      {},
      {
        ...dependencies(),
        validateTarget: async () => ({ valid: false, reason: 'target_private_address' }),
      },
    )
    const stage = result.stages.find((row) => row.stage === 'target_dns')!
    expect(stage.code).toBe('TARGET_NOT_PUBLIC')
    expect(stage.fix).not.toContain('--dns-servers')
  })
  it.each([
    { asset: `0x${'33'.repeat(20)}` },
    { network: 'eip155:1' },
    { amount: '1' },
    { amount: '90000' },
    { payTo: address },
  ])('rejects wrong asset/network/price/recipient before credential use: %j', async (override) => {
    const result = await runDoctor(options(), {}, dependencies(transport(override)))
    expect(result.readyForPreview).toBe(false)
    expect(result.stages.find((row) => row.stage === 'quote')?.status).toBe('fail')
  })
  it('uses only API-key GET for the exact nominated account, leaving signing and Wallet Secret untested', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const env = {
      CDP_API_KEY_ID: 'SENTINEL_ID',
      CDP_API_KEY_SECRET: await exportPKCS8(pair.privateKey),
      CDP_WALLET_SECRET: 'not-a-valid-wallet-key',
      VW_PAYER_ADDRESS: address,
    }
    const result = await runDoctor({ ...options(), checkAccount: true }, env, dependencies())
    expect(result.stages.find((row) => row.stage === 'account')?.code).toBe(
      'CDP_ACCOUNT_GET_OK_SIGNING_UNTESTED',
    )
    expect(result.paymentPreconditionsObserved).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/SENTINEL|PRIVATE KEY|not-a-valid/)
    expect(result.signingTested).toBe(false)
  })
  it('distinguishes observed insufficient balance from unavailable RPC and wrong chain', async () => {
    const input = { ...options(), payer: address }
    const low = await runDoctor(input, {}, dependencies(transport({ balance: 0n })))
    expect(low.stages.find((row) => row.stage === 'base_usdc')).toMatchObject({
      status: 'fail',
      code: 'BASE_USDC_INSUFFICIENT',
    })
    const missing = await runDoctor(input, {}, dependencies(transport({ rpcError: true })))
    expect(missing.stages.find((row) => row.stage === 'base_usdc')).toMatchObject({
      status: 'unknown',
      code: 'BASE_RPC_UNAVAILABLE',
    })
    const wrong = await runDoctor(input, {}, dependencies(transport({ chain: '0x1' })))
    expect(wrong.stages.find((row) => row.stage === 'base_usdc')?.code).toBe('BASE_CHAIN_MISMATCH')
  })
})
