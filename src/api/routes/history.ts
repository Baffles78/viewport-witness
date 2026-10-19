import { promises as fs } from 'fs'
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import { z } from 'zod'
import type { Config } from '../../config.js'
import type { JobStore } from '../../db.js'
import { archiveUrlKey, isSnapshotId, type ArchiveManager } from '../../archive.js'
import type { Viewport } from '../../types.js'
import { challengeIfUnsigned } from './products.js'

const VALID_VIEWPORTS = new Set<string>(['phonePortrait', 'phoneLandscape', 'desktop'])

const historySchema = z
  .object({
    url: z.string().url().max(2048),
    limit: z.number().int().min(1).optional(),
    before: z.string().datetime().optional(),
  })
  .strict()

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      historyQuery?: { urlKey: string; limit: number; beforeMs?: number }
    }
  }
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next): void => void handler(req, res, next).catch(next)
}

function invalidUrl(res: Response): void {
  res.status(400).json({
    error: 'invalid_url',
    detail: 'url must be an absolute public HTTPS URL without credentials or a custom port.',
    code: 'invalid_url',
  })
}

export function createHistoryRouter(
  store: JobStore,
  archive: ArchiveManager | null,
  cfg: Config,
  historyPayment: RequestHandler,
): Router {
  const router = createRouter()

  // Every archive route answers the same way while the archive is switched off,
  // and never issues a payment challenge for a product that cannot deliver.
  router.use('/v1/history', (_req, res, next) => {
    if (!cfg.ARCHIVE_ENABLED || !archive) {
      res.status(404).json({
        error: 'archive_disabled',
        detail: 'The page history archive is not enabled on this service.',
        code: 'archive_disabled',
      })
      return
    }
    next()
  })

  // Free: lets an agent see whether paying for history would return anything.
  router.get('/v1/history/availability', (req, res) => {
    const raw = typeof req.query['url'] === 'string' ? req.query['url'] : ''
    const urlKey = raw.length <= 2048 ? archiveUrlKey(raw) : null
    if (!urlKey) {
      invalidUrl(res)
      return
    }
    const availability = store.archiveAvailability(urlKey)
    res.json({
      url: urlKey,
      snapshots: availability.count,
      newestCapturedAt: availability.newest ? new Date(availability.newest).toISOString() : null,
      oldestCapturedAt: availability.oldest ? new Date(availability.oldest).toISOString() : null,
      retentionDays: cfg.ARCHIVE_RETENTION_DAYS,
      price: `$${cfg.HISTORY_PRICE_USDC} USDC`,
      paymentMode: cfg.PAYMENT_MODE,
    })
  })

  router.post(
    '/v1/history',
    challengeIfUnsigned(historyPayment, cfg),
    (req, res, next) => {
      const parsed = historySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_error',
          detail: parsed.error.issues.map((issue) => issue.message).join('; '),
          code: 'invalid_body',
        })
        return
      }
      const urlKey = archiveUrlKey(parsed.data.url)
      if (!urlKey) {
        invalidUrl(res)
        return
      }
      const beforeMs = parsed.data.before ? Date.parse(parsed.data.before) : undefined
      // Checked before settlement so a signed request never pays for an empty answer.
      if (
        store.listArchiveSnapshots(urlKey, { limit: 1, ...(beforeMs ? { beforeMs } : {}) })
          .length === 0
      ) {
        res.status(404).json({
          error: 'no_snapshots',
          detail: 'No archived snapshots exist for this exact URL. No payment was taken.',
          code: 'no_snapshots',
        })
        return
      }
      req.historyQuery = {
        urlKey,
        limit: Math.min(parsed.data.limit ?? cfg.HISTORY_MAX_RESULTS, cfg.HISTORY_MAX_RESULTS),
        ...(beforeMs ? { beforeMs } : {}),
      }
      next()
    },
    historyPayment,
    (req, res) => {
      const query = req.historyQuery
      if (!query) {
        res.status(500).json({ error: 'validation_state_missing', code: 'internal_error' })
        return
      }
      if (cfg.PAYMENT_MODE !== 'test' && !req.paymentResult?.settled) {
        res.status(402).json({ error: 'payment_required', code: 'payment_required' })
        return
      }
      // Fetch one extra row to know whether an older page exists.
      const rows = store.listArchiveSnapshots(query.urlKey, {
        limit: query.limit + 1,
        ...(query.beforeMs ? { beforeMs: query.beforeMs } : {}),
      })
      const page = rows.slice(0, query.limit)
      const last = page[page.length - 1]
      res.json({
        url: query.urlKey,
        paymentMode: cfg.PAYMENT_MODE,
        snapshots: page.map((row) => ({
          snapshotId: row.id,
          capturedAt: new Date(row.capturedAt).toISOString(),
          expiresAt: new Date(row.expiresAt).toISOString(),
          status: row.status,
          decision: row.decision,
          contentHash: row.contentHash,
          snapshotUrl: `/v1/history/snapshots/${row.id}`,
        })),
        nextBefore:
          rows.length > query.limit && last ? new Date(last.capturedAt).toISOString() : null,
      })
    },
  )

  router.get(
    '/v1/history/snapshots/:id',
    asyncHandler(async (req, res) => {
      const id = req.params['id'] ?? ''
      const snapshot = isSnapshotId(id) && archive ? await archive.readSnapshot(id) : null
      if (!snapshot) {
        res
          .status(404)
          .json({ error: 'not_found', detail: 'Snapshot not found', code: 'not_found' })
        return
      }
      res.json(snapshot)
    }),
  )

  router.get(
    '/v1/history/snapshots/:id/screenshots/:viewport',
    asyncHandler(async (req, res) => {
      const id = req.params['id'] ?? ''
      const viewport = req.params['viewport'] ?? ''
      if (!VALID_VIEWPORTS.has(viewport)) {
        res.status(400).json({
          error: 'invalid_viewport',
          detail: `viewport must be one of: ${[...VALID_VIEWPORTS].join(', ')}`,
          code: 'invalid_viewport',
        })
        return
      }
      const record = isSnapshotId(id) ? store.getArchiveSnapshot(id) : null
      const file = record && archive ? archive.screenshotPath(id, viewport as Viewport) : null
      if (!record || !file || record.expiresAt <= Date.now()) {
        res.status(404).json({ error: 'not_found', code: 'not_found' })
        return
      }
      try {
        const data = await fs.readFile(file)
        res
          .status(200)
          .set({
            'Content-Type': 'image/png',
            'Content-Security-Policy': "default-src 'none'",
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=86400',
            'Content-Disposition': `inline; filename="${viewport}-snapshot.png"`,
            'Content-Length': String(data.length),
          })
          .send(data)
      } catch {
        res.status(404).json({ error: 'screenshot_not_found', code: 'screenshot_not_found' })
      }
    }),
  )

  return router
}
