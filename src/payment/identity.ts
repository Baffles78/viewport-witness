/**
 * Payment identity: one id per signed payment, independent of how the
 * envelope is encoded or which transport (HTTP header or MCP _meta) carried
 * it. Unsigned fields, key order, whitespace, hex case and base64 variants do
 * not change the id, so a re-encoded copy of one payment cannot be admitted or
 * settled twice.
 */

import { createHash } from 'node:crypto'
import { PaymentPayloadSchema } from '@x402/core/schemas'
import { decodeTransactionFromPayload } from '@x402/svm'

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

function normalizeHex(value: unknown): unknown {
  if (typeof value === 'string') return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value
  if (Array.isArray(value)) return value.map(normalizeHex)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeHex(v)]))
  }
  return value
}

function solanaMessageDigest(transaction: string): string | undefined {
  try {
    const decoded = decodeTransactionFromPayload({ transaction })
    return createHash('sha256').update(Uint8Array.from(decoded.messageBytes)).digest('hex')
  } catch {
    return undefined
  }
}

/** Transport-independent id for a signed payment, or undefined if unusable. */
export function paymentIdentity(paymentPayload: unknown): string | undefined {
  const identity = signedPaymentIdentity(paymentPayload)
  if (!identity) return undefined
  let signed: unknown = normalizeHex(identity.signedIdentity)
  if (identity.network.startsWith('solana:')) {
    const transaction = identity.signedIdentity['transaction'] as string
    const digest = solanaMessageDigest(transaction)
    signed = digest ? { message: digest } : { transaction }
  }
  const canonical = canonicalJson({ network: identity.network, scheme: identity.scheme, signed })
  if (canonical.length > MAX_ENVELOPE_BYTES) return undefined
  return `pid_${createHash('sha256').update(canonical).digest('hex')}`
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
