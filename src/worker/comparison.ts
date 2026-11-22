import { promises as fs } from 'fs'
import path from 'path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import type { JobStore } from '../db.js'
import type { QAReport, Viewport, ViewportResult, VisualComparisonResult } from '../types.js'
import { VIEWPORT_NAMES } from '../types.js'
import { buildRepairVerification } from './repair-verification.js'
import { normalizeVisualExclusions, type VisualExclusions } from '../visual-exclusions.js'
import { compareWithExclusions } from './visual-exclusions.js'

// Compares a finished job with its baseline: pixel diffs per viewport (diff PNGs are
// written next to the job's screenshots), accessibility ids added/resolved, error counts.
export async function buildComparison(
  store: JobStore,
  screenshotsDir: string,
  jobId: string,
  baselineJobId: string,
  currentViewports: Partial<Record<Viewport, ViewportResult>>,
  requestedExclusions: VisualExclusions = {},
): Promise<NonNullable<QAReport['comparison']>> {
  const exclusions = normalizeVisualExclusions(requestedExclusions)
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
    let before: Buffer
    let after: Buffer
    try {
      before = await fs.readFile(baselineShot.path)
      after = await fs.readFile(currentShot.path)
      baselinePng = PNG.sync.read(before)
      currentPng = PNG.sync.read(after)
    } catch {
      evidenceLimitations.push(`${viewport}: screenshot evidence could not be decoded.`)
      continue
    }
    if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
      evidenceLimitations.push(`${viewport}: screenshot dimensions are incompatible.`)
      continue
    }
    const diff = new PNG({ width: currentPng.width, height: currentPng.height })
    let changedPixels = pixelmatch(
      baselinePng.data,
      currentPng.data,
      diff.data,
      currentPng.width,
      currentPng.height,
      { threshold: 0.1 },
    )
    let diffBytes = PNG.sync.write(diff)
    let exclusionEvidence: Partial<VisualComparisonResult> = {}
    if (exclusions[viewport]?.length) {
      try {
        const filtered = compareWithExclusions(before, after, exclusions[viewport])
        changedPixels = filtered.summary.changedPixels
        diffBytes = filtered.diff
        const { exclusions: applied, excludedPixels, includedPixels, rawChangedPixels, rawChangedPercent } = filtered.summary
        exclusionEvidence = { exclusions: applied, excludedPixels, includedPixels, rawChangedPixels, rawChangedPercent }
      } catch {
        evidenceLimitations.push(`${viewport}: exclusions could not be applied to the screenshot evidence.`)
        continue
      }
    }
    const diffPath = path.join(screenshotsDir, jobId, `diff-${viewport}.png`)
    await fs.writeFile(diffPath, diffBytes)
    visual[viewport] = {
      viewport,
      changedPixels,
      changedPercent: Number(
        ((changedPixels / (exclusionEvidence.includedPixels ?? (currentPng.width * currentPng.height))) * 100).toFixed(4),
      ),
      ...exclusionEvidence,
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
    repairVerification: buildRepairVerification(baseline, {
      url: store.getJob(jobId)?.url ?? '',
      viewports: currentViewports,
    }),
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
