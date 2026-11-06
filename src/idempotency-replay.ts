import type { Request, Response, RequestHandler } from 'express'
import type { JobStore } from './db.js'
import type { Config } from './config.js'
import type { JobKind, JobRecord, PageAssertion } from './types.js'
import { paymentFingerprint } from './payment/index.js'

export interface JobIntent {
  kind: JobKind
  url: string
  assertions?: PageAssertion[]
  maxOutputTokens?: number
  baselineJobId?: string
}

// A key is a deduplication hint, not proof of payment or ownership. A paid
// replay may return a stored job only with the exact payment payload that was
// already settled for that job, and only for the same validated work.
export function sameJobIntent(existing: JobRecord, intent: JobIntent): boolean {
  return existing.kind === intent.kind &&
    existing.url === intent.url &&
    (existing.baselineJobId ?? null) === (intent.baselineJobId ?? null) &&
    (existing.request.maxOutputTokens ?? null) === (intent.maxOutputTokens ?? null) &&
    JSON.stringify(existing.request.assertions ?? []) === JSON.stringify(intent.assertions ?? [])
}

export function canReplayJob(
  existing: JobRecord,
  req: Request,
  cfg: Config,
  intent: JobIntent,
): boolean {
  if (!sameJobIntent(existing, intent)) return false
  if (cfg.PAYMENT_MODE === 'test') return true
  const fingerprint = paymentFingerprint(req)
  return Boolean(fingerprint && existing.paymentId && fingerprint === existing.paymentId)
}

export function claimPaidAdmission(
  store: JobStore,
  key: string,
  res: Response,
  cfg: Config,
): boolean {
  if (cfg.PAYMENT_MODE === 'test') return true
  if (!store.claimPaymentAdmission(key)) {
    res.status(409).json({
      error: 'idempotency_outcome_unknown',
      code: 'idempotency_outcome_unknown',
      nextAction: 'stop',
    })
    return false
  }
  // A disconnected client may still have a settlement in flight. Release only
  // after a delivered accepted response; unresolved admissions survive restart
  // and require payment reconciliation before the key can be reused.
  res.once('finish', () => {
    if (res.statusCode !== 202) return
    try {
      store.releasePaymentAdmission(key)
    } catch (error) {
      // The job was accepted. Retain the durable claim for reconciliation if
      // cleanup fails instead of crashing after the response was sent.
      console.error('Failed to release paid idempotency admission', error)
    }
  })
  return true
}

/**
 * Cheap syntax gate only. The x402 middleware remains the authority for payment
 * validity and settlement. Reject obviously bogus signed headers before they can
 * consume durable admission space; never treat this as proof of payment.
 */
export const requirePaymentEnvelope: RequestHandler = (req, res, next) => {
  const raw = req.header('payment-signature') ?? req.header('x-payment')
  if (!raw) { next(); return }
  if (raw.length > 64 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    res.status(400).json({ error: 'invalid_payment_envelope', code: 'invalid_payment_envelope' })
    return
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    const envelope = parsed as {
      x402Version?: unknown
      accepted?: { scheme?: unknown; network?: unknown }
      payload?: unknown
    } | null
    if (!envelope || envelope.x402Version !== 2 ||
        envelope.accepted?.scheme !== 'exact' ||
        typeof envelope.accepted.network !== 'string' ||
        !envelope.payload || typeof envelope.payload !== 'object') {
      throw new Error('invalid_payment_envelope')
    }
  } catch {
    res.status(400).json({ error: 'invalid_payment_envelope', code: 'invalid_payment_envelope' })
    return
  }
  next()
}
