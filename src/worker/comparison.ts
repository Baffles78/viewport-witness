import { promises as fs } from 'fs'
import path from 'path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import type { JobStore } from '../db.js'
import type { QAReport, Viewport, ViewportResult, VisualComparisonResult } from '../types.js'
import { VIEWPORT_NAMES } from '../types.js'

// Compares a finished job with its baseline: pixel diffs per viewport (diff PNGs are
// written next to the job's screenshots), accessibility ids added/resolved, error counts.
export async function buildComparison(
  store: JobStore,
  screenshotsDir: string,
  jobId: string,
  baselineJobId: string,
  currentViewports: Partial<Record<Viewport, ViewportResult>>,
): Promise<NonNullable<QAReport['comparison']>> {
  const baselineJob = store.getJob(baselineJobId)
  if (!baselineJob?.reportPath || baselineJob.status !== 'complete') {
    throw new Error('baseline_unavailable')
  }
  const baseline = JSON.parse(await fs.readFile(baselineJob.reportPath, 'utf8')) as QAReport
  const visual: Partial<Record<Viewport, VisualComparisonResult>> = {}
  const evidenceLimitations: string[] = []
  for (const viewport of VIEWPORT_NAMES) {
    const baselineShot = store.getScreenshot(baselineJobId, viewport)
    const currentShot = store.getScreenshot(jobId, viewport)
    const current = currentViewports[viewport]
    if (!baselineShot || !currentShot || !current) {
      evidenceLimitations.push(`${viewport}: screenshot evidence is missing.`)
      continue
    }
    let baselinePng: PNG
    let currentPng: PNG
    try {
      baselinePng = PNG.sync.read(await fs.readFile(baselineShot.path))
      currentPng = PNG.sync.read(await fs.readFile(currentShot.path))
    } catch {
      evidenceLimitations.push(`${viewport}: screenshot evidence could not be decoded.`)
      continue
    }
    if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
      evidenceLimitations.push(`${viewport}: screenshot dimensions are incompatible.`)
      continue
    }
    const diff = new PNG({ width: currentPng.width, height: currentPng.height })
    const changedPixels = pixelmatch(
      baselinePng.data,
      currentPng.data,
      diff.data,
      currentPng.width,
      currentPng.height,
      { threshold: 0.1 },
    )
    const diffPath = path.join(screenshotsDir, jobId, `diff-${viewport}.png`)
    await fs.writeFile(diffPath, PNG.sync.write(diff))
    visual[viewport] = {
      viewport,
      changedPixels,
      changedPercent: Number(
        ((changedPixels / (currentPng.width * currentPng.height)) * 100).toFixed(4),
      ),
      diffImageUrl: `/v1/checks/${jobId}/diffs/${viewport}`,
      baselineScreenshotSha256: baselineShot.sha256,
      currentScreenshotSha256: currentShot.sha256,
    }
  }
  const baselineIds = new Set(
    Object.values(baseline.viewports).flatMap(
      (result) => result?.accessibility.violations.map((v) => v.id) ?? [],
    ),
  )
  const currentIds = new Set(
    Object.values(currentViewports).flatMap(
      (result) => result?.accessibility.violations.map((v) => v.id) ?? [],
    ),
  )
  const currentErrors = Object.values(currentViewports).reduce(
    (sum, result) =>
      sum + (result?.consoleErrors.length ?? 0) + (result?.failedRequests.length ?? 0),
    0,
  )
  return {
    baselineJobId,
    evidenceComplete:
      evidenceLimitations.length === 0 && Object.keys(visual).length === VIEWPORT_NAMES.length,
    evidenceLimitations,
    visual,
    accessibility: {
      newViolationIds: [...currentIds].filter((id) => !baselineIds.has(id)).sort(),
      resolvedViolationIds: [...baselineIds].filter((id) => !currentIds.has(id)).sort(),
    },
    errors: {
      baseline: baseline.summary.totalErrors,
      current: currentErrors,
      delta: currentErrors - baseline.summary.totalErrors,
    },
  }
}
