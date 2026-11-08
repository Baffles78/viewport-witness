/**
 * Durable paid admission.
 *
 * The pinned x402 2.27.0 `upfront` flow skips facilitator /verify and settles
 * before the route handler runs. This module adds three guarantees around it:
 *
 * 1. Read-only facilitator verification runs before anything is stored. An
 *    invalid or unverifiable payment is rejected without reserving a key,
 *    consuming capacity, or calling settle.
 * 2. Only a verified payment is admitted, in one SQLite transaction, as a
 *    `payment_pending` job row carrying the exact intent, key and job id. The
 *    row is written before settle is dispatched, so a crash cannot lose it.
 * 3. Settlement success moves that same row to `queued` atomically. Any settle
 *    error, timeout, disconnect or crash leaves it `unknown`: it keeps its key,
 *    is never expired automatically and never asks the buyer to pay again.
 *    Only authoritative evidence (an operator reconciliation) resolves it.
 *
 * Hook context is carried by AsyncLocalStorage because x402 hooks only receive
 * the payload and requirements. Every hook fails closed: x402 swallows thrown
 * hook errors and would continue, so hooks return `abort` instead of throwing.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { x402ResourceServer } from '@x402/core/server'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import type { AdmissionRefusal, JobStore } from '../db.js'
import type { JobIntent } from '../idempotency-replay.js'
import type { JobRecord } from '../types.js'

export type AdmissionPhase =
  | 'start'
  | 'rejected' // proven before settle was dispatched; nothing stored
  | 'verified'
  | 'not_admitted' // settle never dispatched
  | 'admitted' // durable row written; settle may be in flight
  | 'settled'

export interface AdmissionContext {
  jobId: string
  paymentId: string
  intent: JobIntent
  idempotencyKey?: string
  customerId?: string
  /** Hash of the full signed payment; replays must match it. */
  paymentProof?: string
  /** Ids this payment may have been stored under before ids were unified. */
  paymentAliases?: string[]
  expiresAt: number
  phase: AdmissionPhase
  rejectReason?: string
  notAdmitted?: { reason: AdmissionRefusal | 'store_error'; existing?: JobRecord }
  settlement?: { network: string; transaction: string }
  settleFailure?: string
}

export const admissionStorage = new AsyncLocalStorage<AdmissionContext>()

interface VerifyingFacilitator {
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ isValid: boolean; invalidReason?: string | undefined }>
}

const installed = new WeakSet<object>()

export function installAdmissionHooks(
  server: x402ResourceServer,
  facilitator: VerifyingFacilitator,
  store: JobStore,
  unresolvedLimit: number,
  { preverify = true, payerUnresolvedLimit }: { preverify?: boolean; payerUnresolvedLimit?: number } = {},
): void {
  if (installed.has(server)) return
  installed.add(server)

  // Flows that already call facilitator /verify (the MCP authorization flow)
  // only need the result recorded; the upfront HTTP flow skips /verify, so we
  // call it ourselves.
  server.onAfterVerify(async ({ result }) => {
    const ctx = admissionStorage.getStore()
    if (ctx && ctx.phase === 'start' && result.isValid) ctx.phase = 'verified'
  })

  server.onBeforeVerify(async ({ paymentPayload, requirements }) => {
    const ctx = admissionStorage.getStore()
    if (!ctx) {
      return { abort: true as const, reason: 'payment_admission_unavailable' }
    }
    if (!preverify) return undefined
    try {
      const result = await facilitator.verify(
        paymentPayload as unknown as PaymentPayload,
        requirements as unknown as PaymentRequirements,
      )
      if (!result.isValid) {
        ctx.phase = 'rejected'
        ctx.rejectReason = result.invalidReason ?? 'invalid_payment'
        return { abort: true as const, reason: ctx.rejectReason }
      }
      ctx.phase = 'verified'
      return undefined
    } catch {
      // Verify is read-only and settle has not been called, so nothing can
      // have been charged. The buyer may safely retry.
      ctx.phase = 'rejected'
      ctx.rejectReason = 'payment_verification_unavailable'
      return {
        abort: true as const,
        reason: 'payment_verification_unavailable',
        message: 'Payment could not be verified. Nothing was charged; retry later.',
      }
    }
  })

  server.onBeforeSettle(async ({ requirements }) => {
    const ctx = admissionStorage.getStore()
    if (!ctx || ctx.phase !== 'verified') {
      return { abort: true as const, reason: 'payment_admission_unavailable' }
    }
    if (payerUnresolvedLimit !== undefined && !ctx.customerId) {
      // The per-payer bound cannot be applied, so the attempt is refused.
      ctx.phase = 'not_admitted'
      ctx.notAdmitted = { reason: 'store_error' }
      return { abort: true as const, reason: 'payment_admission_unavailable' }
    }
    try {
      const result = store.admitPaymentAttempt({
        id: ctx.jobId,
        url: ctx.intent.url,
        kind: ctx.intent.kind,
        request: {
          ...(ctx.intent.assertions ? { assertions: ctx.intent.assertions } : {}),
          ...(ctx.intent.maxOutputTokens ? { maxOutputTokens: ctx.intent.maxOutputTokens } : {}),
        },
        ...(ctx.intent.baselineJobId ? { baselineJobId: ctx.intent.baselineJobId } : {}),
        ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
        paymentId: ctx.paymentId,
        ...(ctx.paymentProof ? { paymentProof: ctx.paymentProof } : {}),
        ...(ctx.paymentAliases?.length ? { paymentAliases: ctx.paymentAliases } : {}),
        ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
        network: String(requirements.network),
        expiresAt: ctx.expiresAt,
        unresolvedLimit,
        ...(payerUnresolvedLimit !== undefined ? { payerUnresolvedLimit } : {}),
      })
      if (!result.admitted) {
        ctx.phase = 'not_admitted'
        ctx.notAdmitted = { reason: result.reason, ...(result.existing ? { existing: result.existing } : {}) }
        return { abort: true as const, reason: `payment_not_admitted_${result.reason}` }
      }
      ctx.phase = 'admitted'
      return undefined
    } catch {
      ctx.phase = 'not_admitted'
      ctx.notAdmitted = { reason: 'store_error' }
      return { abort: true as const, reason: 'payment_admission_unavailable' }
    }
  })

  server.onAfterSettle(async ({ result }) => {
    const ctx = admissionStorage.getStore()
    if (!ctx || ctx.phase !== 'admitted') return
    if (!result.success) return
    ctx.settlement = { network: String(result.network), transaction: String(result.transaction ?? '') }
    ctx.phase = 'settled'
    try {
      store.recordSettlement(ctx.jobId, ctx.settlement)
    } catch {
      // The caller retries from ctx.settlement; a crash leaves the row
      // `settling`, which startup recovery turns into `unknown`.
    }
  })

  server.onSettleFailure(async ({ error }) => {
    const ctx = admissionStorage.getStore()
    if (!ctx || ctx.phase !== 'admitted') return undefined
    ctx.settleFailure = error instanceof Error ? error.message.slice(0, 300) : 'settle_failed'
    return undefined
  })
}

/**
 * Called after the x402 flow returns. Returns the settled job id when the
 * payment is confirmed, or marks the attempt unknown when settle may have run.
 */
export function finalizeAdmission(store: JobStore, ctx: AdmissionContext, note: string): 'settled' | 'unknown' | 'none' {
  if (ctx.phase === 'settled' && ctx.settlement) {
    try {
      if (store.recordSettlement(ctx.jobId, ctx.settlement)) return 'settled'
    } catch {
      /* fall through: unproven locally, keep the row unresolved */
    }
    console.error(
      `[payment] settled ${ctx.settlement.network} ${ctx.settlement.transaction} for job ${ctx.jobId} could not be recorded; reconcile`,
    )
    try { store.markSettlementUnknown(ctx.jobId, 'settled_but_not_recorded') } catch { /* startup recovery */ }
    return 'unknown'
  }
  if (ctx.phase === 'admitted') {
    try {
      store.markSettlementUnknown(ctx.jobId, (ctx.settleFailure ?? note).slice(0, 300))
    } catch {
      /* startup recovery turns settling into unknown */
    }
    return 'unknown'
  }
  return 'none'
}

export const UNRESOLVED_PAYMENT_DETAIL =
  'The payment outcome is being confirmed. Do not send another payment for this request. ' +
  'Poll pollUrl, or repeat the original request with the same payment to see its status.'

export function unresolvedPaymentBody(jobId: string, paymentMode: string): Record<string, unknown> {
  return {
    id: jobId,
    status: 'payment_pending',
    jobStatus: 'payment_pending',
    nextAction: 'poll_same_job',
    retryAfterSeconds: 60,
    pollUrl: `/v1/checks/${jobId}`,
    paymentMode,
    paymentOutcome: 'unresolved',
    detail: UNRESOLVED_PAYMENT_DETAIL,
  }
}

/** Key replay of an attempt whose payment is not yet proven. */
export function unresolvedReplayBody(
  job: JobRecord,
  paymentMode: string,
): Record<string, unknown> | null {
  if (job.status !== 'payment_pending' || job.settlementState === 'rejected') return null
  return { ...unresolvedPaymentBody(job.id, paymentMode), idempotent: true }
}

export const PAYER_BUSY_DETAIL =
  'Nothing was charged for this request. Earlier payments from this payer are still being confirmed; retry this same request in a minute.'
