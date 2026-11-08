/**
 * Payment identity: one id per spendable authorization, independent of how
 * the envelope is encoded or which transport (HTTP header or MCP _meta)
 * carried it, so a re-encoded copy of one payment cannot be admitted or
 * settled twice.
 */

import { createHash, createHmac } from 'node:crypto'
import { PaymentPayloadSchema } from '@x402/core/schemas'
import { decodeTransactionFromPayload, getTokenPayerFromTransaction } from '@x402/svm'

const MAX_ENVELOPE_BYTES = 64 * 1024

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function signedPaymentIdentity(
  paymentPayload: unknown,
): { network: string; scheme: string; signedIdentity: Record<string, unknown> } | undefined {
  const parsed = PaymentPayloadSchema.safeParse(paymentPayload)
  if (!parsed.success) return undefined
  const envelope = parsed.data
  const network = envelope.x402Version === 1 ? envelope.network : envelope.accepted.network
  const scheme = envelope.x402Version === 1 ? envelope.scheme : envelope.accepted.scheme
  const payload = envelope.payload
  let signedIdentity: Record<string, unknown>
  if (network.startsWith('solana:') && typeof payload['transaction'] === 'string') {
    signedIdentity = { transaction: payload['transaction'] }
  } else if (
    network.startsWith('eip155:') &&
    payload['permit2Authorization'] &&
    typeof payload['permit2Authorization'] === 'object' &&
    typeof payload['signature'] === 'string'
  ) {
    const authorization = payload['permit2Authorization'] as Record<string, unknown>
    const permitted = authorization['permitted']
    const witness = authorization['witness']
    if (
      typeof authorization['from'] !== 'string' ||
      !permitted ||
      typeof permitted !== 'object' ||
      typeof (permitted as Record<string, unknown>)['token'] !== 'string' ||
      typeof (permitted as Record<string, unknown>)['amount'] !== 'string' ||
      typeof authorization['spender'] !== 'string' ||
      typeof authorization['nonce'] !== 'string' ||
      typeof authorization['deadline'] !== 'string' ||
      !witness ||
      typeof witness !== 'object' ||
      typeof (witness as Record<string, unknown>)['to'] !== 'string' ||
      typeof (witness as Record<string, unknown>)['validAfter'] !== 'string'
    )
      return undefined
    signedIdentity = {
      permit2Authorization: {
        from: authorization['from'],
        permitted: {
          token: (permitted as Record<string, unknown>)['token'],
          amount: (permitted as Record<string, unknown>)['amount'],
        },
        spender: authorization['spender'],
        nonce: authorization['nonce'],
        deadline: authorization['deadline'],
        witness: {
          to: (witness as Record<string, unknown>)['to'],
          validAfter: (witness as Record<string, unknown>)['validAfter'],
        },
      },
      signature: payload['signature'],
    }
  } else if (
    network.startsWith('eip155:') &&
    payload['authorization'] &&
    typeof payload['authorization'] === 'object' &&
    typeof payload['signature'] === 'string'
  ) {
    const authorization = payload['authorization'] as Record<string, unknown>
    const fields = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const
    if (!fields.every((field) => typeof authorization[field] === 'string')) return undefined
    signedIdentity = {
      authorization: Object.fromEntries(fields.map((field) => [field, authorization[field]])),
      signature: payload['signature'],
    }
  } else return undefined
  return { network, scheme, signedIdentity }
}

function bigintText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  try {
    const n = BigInt(value)
    return n >= 0n ? n.toString(16) : undefined
  } catch {
    return undefined
  }
}

export interface PaymentDescription {
  /** One id per spendable authorization, whatever its encoding or transport. */
  id: string
  /** The wallet that pays, as verification checks it. */
  payer: string
}

/**
 * Identifies the authorization that settlement would spend. EVM payments are
 * keyed on (network, asset, payer, nonce): the token contract or Permit2 lets a
 * nonce be spent once, so two envelopes with the same key can never both
 * settle, however their other fields are written. The variant is chosen the
 * way x402 chooses it (Permit2 when `permit2Authorization` is present). Solana
 * payments are keyed on the signed transaction message. Anything else returns
 * undefined, and the caller refuses the payment before verification.
 */
export function describePayment(paymentPayload: unknown): PaymentDescription | undefined {
  const parsed = PaymentPayloadSchema.safeParse(paymentPayload)
  if (!parsed.success) return undefined
  const envelope = parsed.data
  const network = envelope.x402Version === 1 ? envelope.network : envelope.accepted.network
  const scheme = envelope.x402Version === 1 ? envelope.scheme : envelope.accepted.scheme
  const asset = envelope.x402Version === 1 ? '' : String(envelope.accepted.asset ?? '')
  const payload = envelope.payload as Record<string, unknown>
  let key: Record<string, string>
  let payer: string
  if (network.startsWith('solana:')) {
    if (typeof payload['transaction'] !== 'string') return undefined
    try {
      const transaction = decodeTransactionFromPayload({ transaction: payload['transaction'] })
      payer = getTokenPayerFromTransaction(transaction)
      if (!payer) return undefined
      key = {
        kind: 'svm',
        message: createHash('sha256').update(Uint8Array.from(transaction.messageBytes)).digest('hex'),
      }
    } catch {
      return undefined
    }
  } else if (network.startsWith('eip155:')) {
    const isPermit2 = 'permit2Authorization' in payload
    const authorization = (isPermit2 ? payload['permit2Authorization'] : payload['authorization']) as
      | Record<string, unknown>
      | undefined
    if (!authorization || typeof authorization !== 'object') return undefined
    const from = authorization['from']
    const nonce = bigintText(authorization['nonce'])
    if (typeof from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(from) || nonce === undefined) return undefined
    payer = from.toLowerCase()
    key = { kind: isPermit2 ? 'permit2' : 'eip3009', asset: asset.toLowerCase(), from: payer, nonce }
  } else {
    return undefined
  }
  const canonical = canonicalJson({ network, scheme, ...key })
  return { id: `pid_${createHash('sha256').update(canonical).digest('hex')}`, payer }
}

export function paymentIdentity(paymentPayload: unknown): string | undefined {
  return describePayment(paymentPayload)?.id
}

/** Keyed, one-way label for a verified payer; the raw address is never stored. */
export function payerCustomerId(payer: string, secret: string | undefined): string | undefined {
  if (!secret || secret.length < 32) return undefined
  return `cust_${createHmac('sha256', secret).update(payer).digest('hex')}`
}

export function decodePaymentHeader(header: string | undefined): unknown {
  if (!header || header.length > MAX_ENVELOPE_BYTES) return undefined
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Id used by MCP rows created before payment identities were unified. */
export function legacyMcpPaymentId(paymentPayload: unknown): string | undefined {
  const identity = signedPaymentIdentity(paymentPayload)
  if (!identity) return undefined
  const canonical = canonicalJson(identity)
  if (canonical.length > MAX_ENVELOPE_BYTES) return undefined
  return `mcp_${createHash('sha256').update(canonical).digest('hex')}`
}

/** Id used by HTTP rows created before payment identities were unified. */
export function legacyHeaderPaymentId(header: string | undefined): string | undefined {
  return header ? createHash('sha256').update(header).digest('hex') : undefined
}
