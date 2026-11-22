import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { JobStore } from '../../db.js'
import type { Config } from '../../config.js'
import { VIEWPORT_NAMES } from '../../types.js'
import { asyncHandler } from '../http-helpers.js'

/** Read-only derivative evidence; follows the existing job capability/retention model. */
export function createAnnotationsRouter(store: JobStore, cfg: Config): Router {
  const router = Router()
  router.get(
    '/v1/checks/:id/annotations/:viewport',
    asyncHandler(async (req, res) => {
      const { id, viewport } = req.params
      if (!viewport || !(VIEWPORT_NAMES as readonly string[]).includes(viewport)) {
        res.status(400).json({ error: 'invalid_viewport', code: 'invalid_viewport' })
        return
      }
      const job = id ? store.getJob(id) : null
      if (
        !job ||
        job.expiresAt <= Date.now() ||
        job.status !== 'complete' ||
        !['check', 'verify', 'compare'].includes(job.kind)
      ) {
        res.status(404).json({ error: 'not_found', code: 'not_found' })
        return
      }
      // Only the canonical directory and fixed filename are used; neither comes
      // from a report-supplied path or user-provided filename.
      const root = path.resolve(cfg.SCREENSHOTS_DIR)
      const jobRoot = path.resolve(root, job.id)
      if (path.dirname(jobRoot) !== root) {
        res.status(404).json({ error: 'not_found', code: 'not_found' })
        return
      }
      try {
        const data = await fs.readFile(path.join(jobRoot, `annotations-${viewport}.png`))
        res
          .status(200)
          .set({
            'Content-Type': 'image/png',
            'Content-Security-Policy': "default-src 'none'",
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=3600',
            'Content-Disposition': `inline; filename="${viewport}-annotations.png"`,
            'Content-Length': String(data.length),
          })
          .send(data)
      } catch {
        res.status(404).json({ error: 'annotations_unavailable', code: 'annotations_unavailable' })
      }
    }),
  )
  return router
}
