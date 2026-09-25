import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import { z } from 'zod'
import type { Config } from '../../config.js'
import type { JobStore } from '../../db.js'
import { validatePublicHttpsUrl } from '../../ssrf.js'
import type { WorkerRunner } from '../../worker/runner.js'
import { challengeIfUnsigned, createProductJob } from './products.js'

const extractSchema = z
  .object({
    url: z.string().url().max(2048),
    maxOutputTokens: z.number().int().min(500).max(12_000).optional(),
  })
  .strict()
const securitySchema = z.object({ url: z.string().url().max(2048) }).strict()

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next): void => void handler(req, res, next).catch(next)
}

function idempotencyKey(req: Request): string | undefined {
  const raw = req.headers['idempotency-key']
  return Array.isArray(raw) ? raw[0] : raw
}

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
        next()
      }),
      (req, res, next) => {
        const key = idempotencyKey(req)
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
        const key = idempotencyKey(req)
        const result = await createProductJob({
          store,
          runner,
          cfg,
          kind,
          url: input.url,
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
          ...(key ? { idempotencyKey: key } : {}),
          ...(settled?.settled && settled.paymentId ? { paymentId: settled.paymentId } : {}),
          ...(settled?.settled && settled.customerId ? { customerId: settled.customerId } : {}),
        })
        res.status(202).json(result)
      }),
    )
  }

  addRoute('/v1/extract', 'extract', extractSchema, extractPayment)
  addRoute('/v1/security-gate', 'security', securitySchema, securityPayment)
  return router
}
