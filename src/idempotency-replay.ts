import type { Request, Response } from 'express'
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
  req: Request,
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
    if (res.statusCode === 202) store.releasePaymentAdmission(key)
  })
  return true
}
