import { promises as fs } from 'fs'
import type { Request, Response, Router, RequestHandler, NextFunction } from 'express'
import { Router as createRouter } from 'express'
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { validatePublicHttpsUrl } from '../../ssrf.js'
import type { JobStore } from '../../db.js'
import type { WorkerRunner } from '../../worker/runner.js'
import type { Config } from '../../config.js'
import type { Viewport } from '../../types.js'

const VALID_VIEWPORTS = new Set<string>(['phonePortrait', 'phoneLandscape', 'desktop'])

const createCheckSchema = z.object({ url: z.string().url().max(2048) }).strict()

export function createChecksRouter(
  store: JobStore,
  runner: WorkerRunner,
  cfg: Config,
  paymentMiddleware: RequestHandler,
): Router {
  const router = createRouter()

  const idempotencyPreflight = (req: Request, res: Response, next: NextFunction): void => {
    const rawKey = req.headers['idempotency-key']
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey
    if (!key) {
      next()
      return
    }
    if (key.length > 128) {
      res.status(400).json({
        error: 'invalid_idempotency_key',
        detail: 'Key too long',
        code: 'key_too_long',
      })
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
    next()
  }

  router.post(
    '/v1/checks',
    idempotencyPreflight,
    paymentMiddleware,
    async (req: Request, res: Response) => {
      // Parse and validate body
      const parsed = createCheckSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_error',
          detail: parsed.error.issues.map((i) => i.message).join('; '),
          code: 'invalid_body',
        })
        return
      }

      const { url } = parsed.data

      // Apply URL syntax, scheme, port, hostname, inline-IP, and DNS checks together.
      const urlCheck = await validatePublicHttpsUrl(url)
      if (!urlCheck.valid) {
        res.status(400).json({
          error: 'invalid_url',
          detail: `URL rejected: ${urlCheck.reason ?? 'blocked_destination'}`,
          code: urlCheck.reason ?? 'blocked_destination',
        })
        return
      }

      // Production mode: payment must have settled
      const paymentResult = (
        req as Request & { paymentResult?: { settled: boolean; mode: string } }
      ).paymentResult
      if (cfg.PAYMENT_MODE !== 'test' && (!paymentResult || !paymentResult.settled)) {
        res.status(402).json({
          error: 'payment_required',
          detail: 'A valid x402 payment is required in production mode.',
          code: 'payment_required',
        })
        return
      }

      const paymentId = paymentResult?.settled
        ? (paymentResult as { paymentId?: string }).paymentId
        : undefined
      if (cfg.PAYMENT_MODE !== 'test' && !paymentId) {
        res.status(503).json({
          error: 'payment_identity_unavailable',
          detail: 'The verified payment could not be bound to this job.',
          code: 'payment_identity_unavailable',
        })
        return
      }
      if (paymentId) {
        const existingPaymentJob = store.getJobByPaymentId(paymentId)
        if (existingPaymentJob) {
          res.status(202).json({
            id: existingPaymentJob.id,
            status: existingPaymentJob.status,
            pollUrl: `/v1/checks/${existingPaymentJob.id}`,
            paymentMode: cfg.PAYMENT_MODE,
            paymentReplay: true,
          })
          return
        }
      }

      // Idempotency key
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined
      if (idempotencyKey) {
        if (idempotencyKey.length > 128) {
          res.status(400).json({
            error: 'invalid_idempotency_key',
            detail: 'Key too long',
            code: 'key_too_long',
          })
          return
        }
        const existing = store.getJobByIdempotencyKey(idempotencyKey)
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
      }

      // Create job
      const jobId = uuidv4()
      const expiresAt = Date.now() + cfg.RETENTION_DAYS * 24 * 60 * 60 * 1000
      store.createJob({
        id: jobId,
        url,
        idempotencyKey: idempotencyKey ?? null,
        ...(paymentId ? { paymentId } : {}),
        expiresAt,
      })

      try {
        await runner.enqueue(jobId, url)
      } catch (err: unknown) {
        store.updateJobStatus(jobId, 'failed', {
          completedAt: Date.now(),
          error: (err as Error).message,
        })
        res.status(503).json({
          error: 'worker_unavailable',
          detail: 'Worker is not accepting new jobs.',
          code: 'worker_unavailable',
        })
        return
      }

      res.status(202).json({
        id: jobId,
        status: 'queued',
        pollUrl: `/v1/checks/${jobId}`,
        paymentMode: cfg.PAYMENT_MODE,
      })
    },
  )

  router.get('/v1/checks/:id', async (req: Request, res: Response) => {
    const { id } = req.params
    if (!id) {
      res.status(400).json({ error: 'missing_id', code: 'missing_id' })
      return
    }

    const job = store.getJob(id)
    if (!job) {
      res.status(404).json({ error: 'not_found', detail: 'Job not found', code: 'not_found' })
      return
    }

    if (job.status === 'complete' && job.reportPath) {
      try {
        const reportJson = await fs.readFile(job.reportPath, 'utf8')
        const report = JSON.parse(reportJson) as Record<string, unknown>
        res.json({ ...report, jobStatus: 'complete' })
        return
      } catch {
        res.status(500).json({
          error: 'report_unavailable',
          detail: 'Report file could not be read.',
          code: 'report_unavailable',
        })
        return
      }
    }

    if (job.status === 'failed') {
      res.json({
        id: job.id,
        status: 'failed',
        createdAt: new Date(job.createdAt).toISOString(),
        error: job.error ?? 'Job failed',
      })
      return
    }

    res.json({
      id: job.id,
      status: job.status,
      createdAt: new Date(job.createdAt).toISOString(),
      pollUrl: `/v1/checks/${job.id}`,
    })
  })

  router.get('/v1/checks/:id/screenshots/:viewport', async (req: Request, res: Response) => {
    const { id, viewport } = req.params
    if (!id || !viewport) {
      res.status(400).json({ error: 'missing_params', code: 'missing_params' })
      return
    }

    if (!VALID_VIEWPORTS.has(viewport)) {
      res.status(400).json({
        error: 'invalid_viewport',
        detail: `viewport must be one of: ${[...VALID_VIEWPORTS].join(', ')}`,
        code: 'invalid_viewport',
      })
      return
    }

    const job = store.getJob(id)
    if (!job) {
      res.status(404).json({ error: 'not_found', code: 'not_found' })
      return
    }

    const screenshot = store.getScreenshot(id, viewport as Viewport)
    if (!screenshot) {
      res.status(404).json({
        error: 'screenshot_not_found',
        detail: 'Screenshot not yet available or job not complete.',
        code: 'screenshot_not_found',
      })
      return
    }

    try {
      const data = await fs.readFile(screenshot.path)
      res
        .status(200)
        .set({
          'Content-Type': 'image/png',
          'Content-Security-Policy': "default-src 'none'",
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=3600',
          'Content-Disposition': `inline; filename="${viewport}-screenshot.png"`,
          'Content-Length': String(data.length),
        })
        .send(data)
    } catch {
      res.status(404).json({
        error: 'screenshot_file_missing',
        detail: 'Screenshot file not found on disk.',
        code: 'screenshot_file_missing',
      })
    }
  })

  return router
}
