import type { Request } from 'express'
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
export function canReplayJob(
  existing: JobRecord,
  req: Request,
  cfg: Config,
  intent: JobIntent,
): boolean {
  if (existing.kind !== intent.kind || existing.url !== intent.url) return false
  if ((existing.baselineJobId ?? null) !== (intent.baselineJobId ?? null)) return false
  if ((existing.request.maxOutputTokens ?? null) !== (intent.maxOutputTokens ?? null)) return false
  if (JSON.stringify(existing.request.assertions ?? []) !== JSON.stringify(intent.assertions ?? []))
    return false
  if (cfg.PAYMENT_MODE === 'test') return true
  const fingerprint = paymentFingerprint(req)
  return Boolean(fingerprint && existing.paymentId && fingerprint === existing.paymentId)
}
