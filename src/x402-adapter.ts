import { x402Client, x402HTTPClient } from '@x402/core/client'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { ExactSvmScheme } from '@x402/svm/exact/client'
import { usdcAtomic, type PaymentAdapter } from './release-check.js'

export const BASE_NETWORK = 'eip155:8453'
export const SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const ASSETS = {
  [BASE_NETWORK]: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  [SOLANA_NETWORK]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}
type EvmSigner = ConstructorParameters<typeof ExactEvmScheme>[0]
type SvmSigner = ConstructorParameters<typeof ExactSvmScheme>[0]
type Policy = { payTo: string; maxTotalUsdc: string; fetchFn?: typeof fetch }
export type X402AdapterOptions = Policy &
  (
    | { network: typeof BASE_NETWORK; signer: EvmSigner }
    | { network: typeof SOLANA_NETWORK; signer: SvmSigner; feePayer: string; rpcUrl?: string }
  )

/** Customer-side only. Accepts existing wallet capabilities, never keys or seed phrases. */
export function createX402PaymentAdapter(options: X402AdapterOptions): PaymentAdapter {
  const network = options.network,
    payTo = options.payTo
  const totalLimit = usdcAtomic(options.maxTotalUsdc)
  if (
    totalLimit <= 0n ||
    !Object.hasOwn(ASSETS, network) ||
    !(network === BASE_NETWORK
      ? /^0x[a-fA-F0-9]{40}$/.test(payTo)
      : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo))
  )
    throw new Error(
      'An explicit supported network, recipient and positive spending ceiling are required',
    )
  const feePayer = options.network === SOLANA_NETWORK ? options.feePayer : undefined
  if (network === SOLANA_NETWORK && (!feePayer || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(feePayer)))
    throw new Error('Solana requires an explicitly approved facilitator fee payer')
  if (options.network === SOLANA_NETWORK && options.rpcUrl) {
    const rpc = new URL(options.rpcUrl)
    if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.search || rpc.hash)
      throw new Error('RPC URL must be HTTPS without embedded credentials or query secrets')
  }
  if (
    !options.signer ||
    (options.network === BASE_NETWORK
      ? typeof options.signer.signTypedData !== 'function'
      : !('signTransactions' in options.signer) ||
        typeof options.signer.signTransactions !== 'function')
  )
    throw new Error('An existing customer wallet with signing-only capabilities is required')
  const send = options.fetchFn ?? fetch
  const attempted = new Set<string>()
  let reserved = 0n
  return async (input) => {
    const endpoint = 'https://qa.honeygate.app/v1/checks'
    if (
      input.url !== endpoint ||
      input.request.method !== 'POST' ||
      input.request.redirect !== 'error' ||
      !input.request.signal
    )
      throw new Error('Adapter only accepts bounded non-redirecting ViewportWitness check requests')
    input.request.signal.throwIfAborted()
    const headers = new Headers(input.request.headers)
    const idempotency = headers.get('idempotency-key')
    if (
      !idempotency ||
      !/^release-[-a-zA-Z0-9_]{1,150}$/.test(idempotency) ||
      attempted.has(idempotency) ||
      headers.has('payment-signature') ||
      headers.has('authorization')
    )
      throw new Error('A fresh release idempotency key and unsigned request are required')
    if (typeof input.request.body !== 'string' || input.request.body.length > 4096)
      throw new Error('Expected bounded JSON check request')
    let body: Record<string, unknown>
    try {
      body = JSON.parse(input.request.body) as Record<string, unknown>
    } catch {
      throw new Error('Invalid check request')
    }
    if (
      !body ||
      typeof body.url !== 'string' ||
      Object.keys(body).length !== 1 ||
      new URL(body.url).protocol !== 'https:'
    )
      throw new Error('Expected one public HTTPS target')
    const raw = JSON.stringify(input.challenge)
    if (!raw || raw.length > 65536) throw new Error('Payment challenge exceeds limit')
    const challenge = JSON.parse(raw) as PaymentRequired
    const approved = JSON.parse(JSON.stringify(input.approvedRequirement)) as PaymentRequirements
    if (
      challenge.x402Version !== 2 ||
      challenge.resource?.url !== endpoint ||
      !Array.isArray(challenge.accepts) ||
      !challenge.accepts.some((r) => JSON.stringify(r) === JSON.stringify(approved))
    )
      throw new Error('Approved payment requirement is not bound to the quoted resource')
    if (
      approved.scheme !== 'exact' ||
      approved.network !== network ||
      approved.payTo !== payTo ||
      (network === BASE_NETWORK ? approved.asset.toLowerCase() : approved.asset) !==
        ASSETS[network] ||
      !/^\d{1,14}$/.test(approved.amount) ||
      BigInt(approved.amount) <= 0n ||
      !/^\d{1,14}$/.test(input.maximumAtomic) ||
      BigInt(approved.amount) > BigInt(input.maximumAtomic) ||
      reserved + BigInt(approved.amount) > totalLimit ||
      !Number.isInteger(approved.maxTimeoutSeconds) ||
      approved.maxTimeoutSeconds < 1 ||
      approved.maxTimeoutSeconds > 300
    )
      throw new Error('Quote violates the customer-approved payment policy')
    if (
      network === BASE_NETWORK &&
      (approved.extra?.name !== 'USD Coin' ||
        approved.extra?.version !== '2' ||
        (approved.extra?.assetTransferMethod && approved.extra.assetTransferMethod !== 'eip3009'))
    )
      throw new Error('Only exact native USDC EIP-3009 authorization is supported on Base')
    if (network === SOLANA_NETWORK && approved.extra?.feePayer !== feePayer)
      throw new Error('Quote changed the approved Solana fee payer')
    // Capture request and limit before signing. No network retry or alternate challenge is authorized.
    attempted.add(idempotency)
    reserved += BigInt(approved.amount)
    const request = {
      ...input.request,
      headers,
      body: input.request.body,
      redirect: 'error' as const,
      signal: input.request.signal,
    }
    // Per-request guards also stop late signing after an aborted Solana RPC lookup.
    const client = new x402Client()
    if (options.network === BASE_NETWORK) {
      const signer = options.signer
      client.register(
        BASE_NETWORK,
        new ExactEvmScheme({
          address: signer.address,
          signTypedData: (data) => {
            request.signal.throwIfAborted()
            return signer.signTypedData(data)
          },
        }),
      )
    } else {
      const signer = options.signer
      if (!('signTransactions' in signer))
        throw new Error('A signing-only Solana wallet is required')
      client.register(
        SOLANA_NETWORK,
        new ExactSvmScheme(
          {
            address: signer.address,
            signTransactions: (transactions, config) => {
              request.signal.throwIfAborted()
              return signer.signTransactions(transactions, config)
            },
          },
          options.rpcUrl ? { rpcUrl: options.rpcUrl } : undefined,
        ),
      )
    }
    const http = new x402HTTPClient(client)
    let payload
    try {
      const signing = http.createPaymentPayload({ ...challenge, accepts: [approved] })
      payload = await new Promise<Awaited<typeof signing>>((resolve, reject) => {
        const abort = () => reject(new Error('Aborted'))
        request.signal.addEventListener('abort', abort, { once: true })
        if (request.signal.aborted) abort()
        signing
          .then(resolve, reject)
          .finally(() => request.signal.removeEventListener('abort', abort))
      })
    } catch {
      throw new Error(
        'Wallet authorization failed or is uncertain; reconcile the existing checkpoint before retrying',
      )
    }
    if (JSON.stringify(payload.accepted) !== JSON.stringify(approved))
      throw new Error('SDK changed the approved requirement; no request sent')
    for (const [key, value] of Object.entries(http.encodePaymentSignatureHeader(payload)))
      headers.set(key, value)
    request.signal.throwIfAborted()
    try {
      return await send(endpoint, request)
    } catch {
      throw new Error(
        'Paid request outcome is uncertain; reconcile the existing checkpoint, do not repay',
      )
    }
  }
}
