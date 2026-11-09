import type { Request, RequestHandler, Router } from 'express'
import { unresolvedReplayBody } from '../../payment/admission.js'
import { Router as createRouter } from 'express'
import { z } from 'zod'
import type { Config } from '../../config.js'
import type { JobStore } from '../../db.js'
import { validatePublicHttpsUrl } from '../../ssrf.js'
import { canReplayJob } from '../../idempotency-replay.js'
import type { WorkerRunner } from '../../worker/runner.js'
import { challengeIfUnsigned, createProductJob, requireWorkerAvailable, sendProductJob } from './products.js'
import { asyncHandler, readIdempotencyKey } from '../http-helpers.js'

const extractSchema = z
  .object({
    url: z.string().url().max(2048),
    maxOutputTokens: z.number().int().min(500).max(12_000).optional(),
  })
  .strict()
const securitySchema = z.object({ url: z.string().url().max(2048) }).strict()

export function createWebProductsRouter(
  store: JobStore,
  runner: WorkerRunner,
  cfg: Config,
  extractPayment: RequestHandler,
  securityPayment: RequestHandler,
): Router {
  const router = createRouter()
  const inFlight = new Set<string>()

  const addRoute = (
    path: '/v1/extract' | '/v1/security-gate',
    kind: 'extract' | 'security',
    schema: typeof extractSchema | typeof securitySchema,
    payment: RequestHandler,
  ): void => {
    router.post(
      path,
      requireWorkerAvailable(runner),
      challengeIfUnsigned(payment, cfg),
      asyncHandler(async (req, res, next) => {
        const parsed = schema.safeParse(req.body)
        if (!parsed.success) {
          res
            .status(422)
            .json({
              error: 'validation_error',
              code: 'invalid_body',
              detail: parsed.error.issues.map((issue) => issue.message).join('; '),
            })
          return
        }
        const valid = await validatePublicHttpsUrl(parsed.data.url)
        if (!valid.valid) {
          res
            .status(400)
            .json({ error: 'invalid_url', code: valid.reason ?? 'blocked_destination' })
          return
        }
        ;(req as Request & { webProductInput?: unknown }).webProductInput = parsed.data
        const maxOutputTokens = (parsed.data as { maxOutputTokens?: number }).maxOutputTokens
        req.jobIntent = {
          kind,
          url: parsed.data.url,
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
        }
        next()
      }),
        (req, res, next) => {
        const key = readIdempotencyKey(req)
        if (!key) {
          next()
          return
        }
        if (key.length > 128) {
          res.status(400).json({ error: 'invalid_idempotency_key', code: 'key_too_long' })
          return
        }
        const existing = store.getJobByIdempotencyKey(key)
        if (existing) {
          const input = (req as Request & {
            webProductInput?: { url: string; maxOutputTokens?: number }
          }).webProductInput
          if (!canReplayJob(existing, req, cfg, {
            kind, url: input?.url ?? '',
            ...(input?.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
          })) {
            res.status(409).json({ error: 'idempotency_key_conflict', code: 'idempotency_key_conflict' })
            return
          }
          const unresolved = unresolvedReplayBody(existing, cfg.PAYMENT_MODE)
          if (unresolved) {
            res.status(202).json(unresolved)
            return
          }
          res
            .status(202)
            .json({
              id: existing.id,
              status: existing.status,
              pollUrl: `/v1/checks/${existing.id}`,
              paymentMode: cfg.PAYMENT_MODE,
              idempotent: true,
            })
          return
        }
            if (inFlight.has(key)) {
          res
            .status(409)
            .json({ error: 'idempotency_in_progress', code: 'idempotency_in_progress' })
          return
        }
        inFlight.add(key)
        const release = (): void => {
          inFlight.delete(key)
        }
        res.once('finish', release)
        res.once('close', release)
        next()
      },
      payment,
      asyncHandler(async (req, res) => {
        const input = (
          req as Request & { webProductInput: { url: string; maxOutputTokens?: number } }
        ).webProductInput
        const settled = req.paymentResult
        if (cfg.PAYMENT_MODE !== 'test' && (!settled?.settled || !settled.paymentId)) {
          res.status(402).json({ error: 'payment_required', code: 'payment_required' })
          return
        }
        const key = readIdempotencyKey(req)
        await sendProductJob(res, createProductJob({
          store,
          runner,
          cfg,
          kind,
          url: input.url,
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
          ...(key ? { idempotencyKey: key } : {}),
          ...(settled?.settled && settled.paymentId ? { paymentId: settled.paymentId } : {}),
          ...(settled?.settled && settled.customerId ? { customerId: settled.customerId } : {}),
          ...(settled?.settled && settled.admittedJobId ? { admittedJobId: settled.admittedJobId } : {}),
        }))
      }),
    )
  }

  addRoute('/v1/extract', 'extract', extractSchema, extractPayment)
  addRoute('/v1/security-gate', 'security', securitySchema, securityPayment)
  return router
}
