import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import type { Config } from '../../config.js'
import type { JobStore } from '../../db.js'
import { validatePublicHttpsUrl } from '../../ssrf.js'
import type { JobKind, PageAssertion } from '../../types.js'
import type { WorkerRunner } from '../../worker/runner.js'

interface ProductRunner {
  enqueue(jobId: string): Promise<void>
}

const assertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('textVisible'), value: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('selectorExists'), selector: z.string().min(1).max(300) }).strict(),
  z.object({ type: z.literal('selectorVisible'), selector: z.string().min(1).max(300) }).strict(),
  z.object({ type: z.literal('titleIncludes'), value: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('noHorizontalOverflow') }).strict(),
  z.object({ type: z.literal('noConsoleErrors') }).strict(),
])

const verifySchema = z
  .object({
    url: z.string().url().max(2048),
    assertions: z.array(assertionSchema).min(1).max(20),
  })
  .strict()

const compareSchema = z
  .object({
    url: z.string().url().max(2048),
    baselineJobId: z.string().uuid(),
  })
  .strict()

const REQUIRED_VIEWPORTS = ['phonePortrait', 'phoneLandscape', 'desktop'] as const

export function hasCompleteBaselineScreenshots(store: JobStore, jobId: string): boolean {
  return REQUIRED_VIEWPORTS.every((viewport) => store.getScreenshot(jobId, viewport) !== null)
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next): void => void handler(req, res, next).catch(next)
}

function readIdempotencyKey(req: Request): string | undefined {
  const value = req.headers['idempotency-key']
  return Array.isArray(value) ? value[0] : value
}

function paymentIdentity(
  req: Request,
  cfg: Config,
): { paymentId?: string; customerId?: string } | null {
  const result = req.paymentResult
  if (cfg.PAYMENT_MODE !== 'test' && (!result?.settled || !result.paymentId)) return null
  return {
    ...(result?.settled && result.paymentId ? { paymentId: result.paymentId } : {}),
    ...(result?.settled && result.customerId ? { customerId: result.customerId } : {}),
  }
}

export async function createProductJob(params: {
  store: JobStore
  runner: ProductRunner
  cfg: Config
  kind: JobKind
  url: string
  assertions?: PageAssertion[]
  baselineJobId?: string
  idempotencyKey?: string
  paymentId?: string
  customerId?: string
  deferEnqueue?: boolean
}): Promise<{ id: string; status: string; pollUrl: string; paymentMode: string }> {
  const existing =
    (params.idempotencyKey ? params.store.getJobByIdempotencyKey(params.idempotencyKey) : null) ??
    (params.paymentId ? params.store.getJobByPaymentId(params.paymentId) : null)
  if (existing) {
    return {
      id: existing.id,
      status: existing.status,
      pollUrl: `/v1/checks/${existing.id}`,
      paymentMode: params.cfg.PAYMENT_MODE,
    }
  }
  const id = uuidv4()
  try {
    params.store.createJob({
      id,
      url: params.url,
      idempotencyKey: params.idempotencyKey ?? null,
      ...(params.paymentId ? { paymentId: params.paymentId } : {}),
      ...(params.customerId ? { customerId: params.customerId } : {}),
      expiresAt: Date.now() + params.cfg.RETENTION_DAYS * 24 * 60 * 60 * 1000,
      kind: params.kind,
      request: params.assertions ? { assertions: params.assertions } : {},
      ...(params.baselineJobId ? { baselineJobId: params.baselineJobId } : {}),
      initialStatus: params.deferEnqueue ? 'payment_pending' : 'queued',
    })
  } catch (error) {
    const raced =
      (params.idempotencyKey ? params.store.getJobByIdempotencyKey(params.idempotencyKey) : null) ??
      (params.paymentId ? params.store.getJobByPaymentId(params.paymentId) : null)
    if (!raced) throw error
    return {
      id: raced.id,
      status: raced.status,
      pollUrl: `/v1/checks/${raced.id}`,
      paymentMode: params.cfg.PAYMENT_MODE,
    }
  }
  if (params.deferEnqueue) {
    // The pending state was written atomically with the row above. A restart
    // cannot recover this job until successful settlement claims it.
  } else {
    try {
      await params.runner.enqueue(id)
    } catch (error) {
      params.store.updateJobStatus(id, 'failed', {
        completedAt: Date.now(),
        error: error instanceof Error ? error.message.slice(0, 1000) : 'worker_unavailable',
      })
      throw error
    }
  }
  return { id, status: 'queued', pollUrl: `/v1/checks/${id}`, paymentMode: params.cfg.PAYMENT_MODE }
}

export function createProductsRouter(
  store: JobStore,
  runner: WorkerRunner,
  cfg: Config,
  verifyPayment: RequestHandler,
  comparePayment: RequestHandler,
): Router {
  const router = createRouter()
  const inFlightIdempotencyKeys = new Set<string>()
  const idempotencyPreflight = (req: Request, res: Response, next: NextFunction): void => {
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
      res.status(202).json({
        id: existing.id,
        status: existing.status,
        pollUrl: `/v1/checks/${existing.id}`,
        paymentMode: cfg.PAYMENT_MODE,
        idempotent: true,
      })
      return
    }
    if (inFlightIdempotencyKeys.has(key)) {
      res.setHeader('Retry-After', '1')
      res.status(409).json({ error: 'idempotency_in_progress', code: 'idempotency_in_progress' })
      return
    }
    inFlightIdempotencyKeys.add(key)
    const release = (): void => {
      inFlightIdempotencyKeys.delete(key)
    }
    res.once('finish', release)
    res.once('close', release)
    next()
  }

  router.post(
    '/v1/verify',
    asyncHandler(async (req, res, next) => {
      const parsed = verifySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_error',
          code: 'invalid_body',
          detail: parsed.error.issues.map((i) => i.message).join('; '),
        })
        return
      }
      const urlCheck = await validatePublicHttpsUrl(parsed.data.url)
      if (!urlCheck.valid) {
        res
          .status(400)
          .json({ error: 'invalid_url', code: urlCheck.reason ?? 'blocked_destination' })
        return
      }
      ;(req as Request & { productInput?: unknown }).productInput = parsed.data
      next()
    }),
    idempotencyPreflight,
    verifyPayment,
    asyncHandler(async (req, res) => {
      const input = (req as Request & { productInput: z.infer<typeof verifySchema> }).productInput
      const identity = paymentIdentity(req, cfg)
      if (!identity) {
        res.status(402).json({ error: 'payment_required', code: 'payment_required' })
        return
      }
      const key = readIdempotencyKey(req)
      const result = await createProductJob({
        store,
        runner,
        cfg,
        kind: 'verify',
        url: input.url,
        assertions: input.assertions,
        ...(key ? { idempotencyKey: key } : {}),
        ...identity,
      })
      res.status(202).json(result)
    }),
  )

  router.post(
    '/v1/compare',
    asyncHandler(async (req, res, next) => {
      const parsed = compareSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_error',
          code: 'invalid_body',
          detail: parsed.error.issues.map((i) => i.message).join('; '),
        })
        return
      }
      const urlCheck = await validatePublicHttpsUrl(parsed.data.url)
      if (!urlCheck.valid) {
        res
          .status(400)
          .json({ error: 'invalid_url', code: urlCheck.reason ?? 'blocked_destination' })
        return
      }
      const baseline = store.getJob(parsed.data.baselineJobId)
      if (
        !baseline ||
        baseline.status !== 'complete' ||
        !baseline.reportPath ||
        baseline.expiresAt <= Date.now() ||
        !hasCompleteBaselineScreenshots(store, baseline.id)
      ) {
        res.status(400).json({
          error: 'baseline_unavailable',
          code: 'baseline_unavailable',
          detail: 'Baseline must be a completed, unexpired ViewportWitness job.',
        })
        return
      }
      ;(req as Request & { productInput?: unknown }).productInput = parsed.data
      next()
    }),
    idempotencyPreflight,
    comparePayment,
    asyncHandler(async (req, res) => {
      const input = (req as Request & { productInput: z.infer<typeof compareSchema> }).productInput
      const identity = paymentIdentity(req, cfg)
      if (!identity) {
        res.status(402).json({ error: 'payment_required', code: 'payment_required' })
        return
      }
      const key = readIdempotencyKey(req)
      const result = await createProductJob({
        store,
        runner,
        cfg,
        kind: 'compare',
        url: input.url,
        baselineJobId: input.baselineJobId,
        ...(key ? { idempotencyKey: key } : {}),
        ...identity,
      })
      res.status(202).json(result)
    }),
  )

  return router
}
