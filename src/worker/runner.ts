import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { chromium, type Browser } from 'playwright'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import type { JobStore } from '../db.js'
import type {
  MachineVerdict,
  QAReport,
  Viewport,
  ViewportResult,
  VisualComparisonResult,
  StoredReport,
} from '../types.js'
import { runViewportCheck } from './browser.js'
import { buildDiagnosis } from '../report-guidance.js'
import { fetchBoundedHtml, WEB_JOB_BUDGET_MS } from '../web-products.js'
import { runBoundedWebAnalysis } from '../web-analysis-runner.js'

const VIEWPORTS_ORDER: Viewport[] = ['phonePortrait', 'phoneLandscape', 'desktop']

interface QueueItem {
  jobId: string
  paymentMode: string
}

type InternalViewportResult = ViewportResult & { screenshotPath: string }

export class WorkerRunner {
  private queue: QueueItem[] = []
  private processing = false
  private browser: Browser | null = null
  private shuttingDown = false
  private currentJobId: string | null = null
  private currentAbortController: AbortController | null = null

  constructor(
    private readonly store: JobStore,
    private readonly screenshotsDir: string,
    private readonly timeoutMs: number,
    private readonly paymentMode: string,
  ) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    })

    const recoverable = this.store.listJobsByStatuses(['queued', 'running', 'retryable'])
    for (const job of recoverable) {
      if (job.status === 'running') this.store.markJobRetryable(job.id)
      this.queue.push({ jobId: job.id, paymentMode: this.paymentMode })
    }
    if (this.queue.length > 0) void this.processNext()
  }

  async stop(): Promise<void> {
    this.shuttingDown = true

    this.currentAbortController?.abort()
    if (this.currentJobId) {
      const current = this.store.getJob(this.currentJobId)
      if (current?.status === 'running') {
        this.store.markJobRetryable(this.currentJobId)
      }
    }

    // Mark any running jobs as retryable
    // (jobs in queue that haven't started yet remain 'queued' in DB - they can restart)
    // Find any 'running' jobs in the queue and mark them retryable
    for (const item of this.queue) {
      const job = this.store.getJob(item.jobId)
      if (job && job.status === 'running') {
        this.store.markJobRetryable(item.jobId)
      }
    }
    this.queue = []

    if (this.browser) {
      try {
        await this.browser.close()
      } catch {
        // ignore
      }
      this.browser = null
    }
  }

  isHealthy(): boolean {
    return !this.shuttingDown && this.browser !== null
  }

  async enqueue(jobId: string): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Worker is shutting down')
    }
    this.queue.push({ jobId, paymentMode: this.paymentMode })
    if (!this.processing) {
      void this.processNext()
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0 || this.shuttingDown) {
      return
    }

    this.processing = true
    const item = this.queue.shift()
    if (!item) {
      this.processing = false
      return
    }

    try {
      this.currentJobId = item.jobId
      await this.runJobWithTimeout(item)
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'unknown error'
      try {
        this.store.updateJobStatus(item.jobId, 'failed', {
          completedAt: Date.now(),
          error: msg.slice(0, 1000),
        })
      } catch {
        // ignore db errors during error handling
      }
    } finally {
      this.currentJobId = null
      this.currentAbortController = null
      this.processing = false
      if (this.queue.length > 0 && !this.shuttingDown) {
        void this.processNext()
      }
    }
  }

  private async runJobWithTimeout(item: QueueItem): Promise<void> {
    const job = this.store.getJob(item.jobId)
    if (!job) return

    this.store.updateJobStatus(item.jobId, 'running', { startedAt: Date.now() })

    const controller = new AbortController()
    this.currentAbortController = controller
    let timeoutHandle: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort()
        reject(new Error('job_timeout'))
      }, this.timeoutMs)
    })
    const workPromise = this.runJob(item, controller.signal)

    try {
      const report = await Promise.race([workPromise, timeoutPromise])

      const reportDir = path.join(this.screenshotsDir, item.jobId)
      await fs.mkdir(reportDir, { recursive: true })
      const reportPath = path.join(reportDir, 'report.json')
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')

      this.store.updateJobStatus(item.jobId, 'complete', {
        completedAt: Date.now(),
        reportPath,
      })
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'unknown'
      if (msg === 'job_timeout' || msg === 'job_aborted') {
        await workPromise.catch(() => undefined)
        if (this.store.getJob(item.jobId)?.status === 'running') {
          this.store.markJobRetryable(item.jobId)
        }
        const retryable = this.store.getJob(item.jobId)
        if (
          msg === 'job_timeout' &&
          !this.shuttingDown &&
          retryable?.status === 'retryable' &&
          retryable.retryCount <= 1
        ) {
          this.queue.push(item)
        }
      } else {
        this.store.updateJobStatus(item.jobId, 'failed', {
          completedAt: Date.now(),
          error: msg.slice(0, 1000),
        })
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private async runJob(item: QueueItem, signal: AbortSignal): Promise<StoredReport> {
    const job = this.store.getJob(item.jobId)
    if (!job) throw new Error(`Job ${item.jobId} not found`)

    if (job.kind === 'extract' || job.kind === 'security') {
      const startedAt = Date.now()
      const fetched = await fetchBoundedHtml(job.url, signal)
      const paymentMode = item.paymentMode as QAReport['paymentMode']
      return await runBoundedWebAnalysis(
        {
          kind: job.kind,
          id: job.id,
          createdAt: job.createdAt,
          expiresAt: job.expiresAt,
          paymentMode,
          fetched,
          maxOutputTokens: job.request.maxOutputTokens ?? 4000,
        },
        WEB_JOB_BUDGET_MS - (Date.now() - startedAt),
        signal,
      )
    }

    if (!this.browser) throw new Error('Browser not initialized')

    const viewportResults: Partial<Record<Viewport, InternalViewportResult>> = {}
    const limitations: string[] = []

    for (const viewport of VIEWPORTS_ORDER) {
      if (signal.aborted) throw new Error('job_aborted')
      try {
        const result = await runViewportCheck(
          this.browser,
          viewport,
          job.url,
          this.screenshotsDir,
          item.jobId,
          signal,
          job.request.assertions ?? [],
        )
        viewportResults[viewport] = result
        if (result.screenshotBytes > 0) {
          this.store.recordScreenshot(
            item.jobId,
            viewport,
            result.screenshotPath,
            result.screenshotSha256,
            result.screenshotBytes,
          )
        }
      } catch (err: unknown) {
        if (signal.aborted) throw new Error('job_aborted')
        limitations.push(
          `viewport:${viewport} check failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown'}`,
        )
      }
    }

    const status = this.computeReportStatus(viewportResults)

    const totalViolations = Object.values(viewportResults).reduce(
      (sum, vr) => sum + (vr?.accessibility.violations.length ?? 0),
      0,
    )
    const criticalViolations = Object.values(viewportResults).reduce(
      (sum, vr) =>
        sum +
        (vr?.accessibility.violations.filter(
          (v) => v.impact === 'critical' || v.impact === 'serious',
        ).length ?? 0),
      0,
    )
    const totalErrors = Object.values(viewportResults).reduce(
      (sum, vr) => sum + (vr?.consoleErrors.length ?? 0) + (vr?.failedRequests.length ?? 0),
      0,
    )

    const loadStatuses = Object.values(viewportResults)
      .map((vr) => vr?.loadStatus)
      .filter(Boolean)
    const overallLoadStatus =
      loadStatuses.length === 0
        ? 'no_data'
        : loadStatuses.every((s) => s === 'success')
          ? 'success'
          : loadStatuses.some((s) => s === 'success')
            ? 'partial'
            : 'failed'

    const publicViewportResults: Partial<Record<Viewport, ViewportResult>> = {}
    for (const [viewport, result] of Object.entries(viewportResults) as Array<
      [Viewport, InternalViewportResult]
    >) {
      const publicResult = { ...result } as Partial<InternalViewportResult>
      delete publicResult.screenshotPath
      publicViewportResults[viewport] = publicResult as ViewportResult
    }

    const reportObj: Omit<QAReport, 'contentHash' | 'diagnosis'> = {
      id: job.id,
      url: job.url,
      kind: job.kind,
      status,
      paymentMode: item.paymentMode as QAReport['paymentMode'],
      createdAt: new Date(job.createdAt).toISOString(),
      expiresAt: new Date(job.expiresAt).toISOString(),
      checksPerformed: [
        'screenshot',
        'accessibility:axe-core',
        'layout:overflow',
        'layout:offscreen',
        'network:failed-requests',
        'performance:navigation-and-paint',
        'interaction:visibility',
        'interaction:focusability',
      ],
      limitations,
      viewports: publicViewportResults,
      summary: {
        totalViolations,
        criticalViolations,
        totalErrors,
        overallLoadStatus,
      },
      verdict: this.buildVerdict(status, publicViewportResults),
    }

    if (job.kind === 'verify') {
      const results: NonNullable<QAReport['assertions']>['results'] = {}
      let passed = 0
      let failed = 0
      for (const [viewport, result] of Object.entries(publicViewportResults) as Array<
        [Viewport, ViewportResult]
      >) {
        const viewportAssertions = result.assertions ?? []
        results[viewport] = viewportAssertions
        passed += viewportAssertions.filter((assertion) => assertion.passed).length
        failed += viewportAssertions.filter((assertion) => !assertion.passed).length
      }
      reportObj.assertions = { passed, failed, results }
      if (failed > 0) {
        reportObj.status = 'FAIL'
        reportObj.verdict = this.buildVerdict('FAIL', publicViewportResults)
        reportObj.verdict.blockingIssues += failed
        reportObj.verdict.reasons.push(`${failed} explicit assertion(s) failed.`)
        reportObj.verdict.recommendedActions.unshift({
          code: 'assertions_failed',
          priority: 'high',
          detail: 'Review the failed assertions before shipping.',
        })
      }
    }

    if (job.kind === 'compare' && job.baselineJobId) {
      reportObj.comparison = await this.buildComparison(
        job.id,
        job.baselineJobId,
        publicViewportResults,
      )
      if (!reportObj.comparison.evidenceComplete) {
        reportObj.status = 'INCONCLUSIVE'
        reportObj.verdict = this.buildVerdict('INCONCLUSIVE', publicViewportResults)
        reportObj.verdict.reasons.unshift('The baseline comparison evidence is incomplete.')
        reportObj.verdict.recommendedActions.unshift({
          code: 'incomplete_comparison',
          priority: 'high',
          detail: 'Create a new complete baseline and run the comparison again.',
        })
      }
      const changed = Object.values(reportObj.comparison.visual).some(
        (entry) => entry && entry.changedPixels > 0,
      )
      if (changed) {
        reportObj.verdict.warnings += 1
        reportObj.verdict.reasons.push('Visual changes were detected against the baseline.')
        reportObj.verdict.recommendedActions.push({
          code: 'visual_change',
          priority: 'medium',
          detail: 'Inspect the three visual diff images before shipping.',
        })
        if (reportObj.verdict.decision === 'safe_to_ship') reportObj.verdict.decision = 'review'
      }
    }

    const reportWithDiagnosis: Omit<QAReport, 'contentHash'> = {
      ...reportObj,
      diagnosis: buildDiagnosis(reportObj.status, publicViewportResults, {
        ...(reportObj.assertions ? { assertions: reportObj.assertions } : {}),
        ...(reportObj.comparison ? { comparison: reportObj.comparison } : {}),
      }),
    }

    // Compute content hash (evidence of integrity, not a cryptographic signature)
    const reportJson = JSON.stringify(reportWithDiagnosis)
    const contentHash = crypto.createHash('sha256').update(reportJson).digest('hex')

    return { ...reportWithDiagnosis, contentHash }
  }

  private buildVerdict(
    status: QAReport['status'],
    viewports: Partial<Record<Viewport, ViewportResult>>,
  ): MachineVerdict {
    const actions: MachineVerdict['recommendedActions'] = []
    const reasons: string[] = []
    let blockingIssues = 0
    let warnings = 0
    for (const [viewport, result] of Object.entries(viewports) as Array<
      [Viewport, ViewportResult]
    >) {
      if (result.loadStatus !== 'success' || result.pageCrash) {
        blockingIssues++
        reasons.push(`${viewport}: page did not load cleanly.`)
        actions.push({
          code: 'load_failure',
          priority: 'high',
          viewport,
          detail: 'Fix the page load or crash.',
        })
      }
      const severe = result.accessibility.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious',
      ).length
      if (severe > 0) {
        blockingIssues += severe
        reasons.push(`${viewport}: ${severe} serious accessibility issue(s).`)
        actions.push({
          code: 'accessibility',
          priority: 'high',
          viewport,
          detail: 'Fix serious accessibility violations.',
        })
      }
      if (result.consoleErrors.length + result.failedRequests.length > 0) {
        blockingIssues++
        reasons.push(`${viewport}: browser or network errors were observed.`)
        actions.push({
          code: 'browser_errors',
          priority: 'high',
          viewport,
          detail: 'Review console errors and failed requests.',
        })
      }
      if (result.overflowDetected || result.offscreenElements > 0) {
        blockingIssues++
        reasons.push(`${viewport}: content overflow or off-screen elements detected.`)
        actions.push({
          code: 'layout',
          priority: 'high',
          viewport,
          detail: 'Correct the responsive layout.',
        })
      }
      const moderate = result.accessibility.violations.filter(
        (violation) => violation.impact === 'moderate' || violation.impact === 'minor',
      ).length
      warnings += moderate
    }
    if (status === 'INCONCLUSIVE') {
      warnings++
      reasons.push('The evidence set is incomplete.')
      actions.push({
        code: 'incomplete_evidence',
        priority: 'medium',
        detail: 'Retry the check before shipping.',
      })
    }
    if (reasons.length === 0) reasons.push('All required checks passed across all three viewports.')
    return {
      decision: status === 'PASS' ? 'safe_to_ship' : status === 'FAIL' ? 'failed' : 'review',
      blockingIssues,
      warnings,
      reasons: reasons.slice(0, 12),
      recommendedActions: actions.slice(0, 12),
    }
  }

  private async buildComparison(
    jobId: string,
    baselineJobId: string,
    currentViewports: Partial<Record<Viewport, ViewportResult>>,
  ): Promise<NonNullable<QAReport['comparison']>> {
    const baselineJob = this.store.getJob(baselineJobId)
    if (!baselineJob?.reportPath || baselineJob.status !== 'complete') {
      throw new Error('baseline_unavailable')
    }
    const baseline = JSON.parse(await fs.readFile(baselineJob.reportPath, 'utf8')) as QAReport
    const visual: Partial<Record<Viewport, VisualComparisonResult>> = {}
    const evidenceLimitations: string[] = []
    for (const viewport of VIEWPORTS_ORDER) {
      const baselineShot = this.store.getScreenshot(baselineJobId, viewport)
      const currentShot = this.store.getScreenshot(jobId, viewport)
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
      const diffPath = path.join(this.screenshotsDir, jobId, `diff-${viewport}.png`)
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
        evidenceLimitations.length === 0 && Object.keys(visual).length === VIEWPORTS_ORDER.length,
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

  private computeReportStatus(
    viewports: Partial<Record<Viewport, InternalViewportResult>>,
  ): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
    const results = Object.values(viewports).filter(
      (v): v is InternalViewportResult => v !== undefined,
    )

    if (results.length === 0) return 'INCONCLUSIVE'

    const hasLoadFailure = results.some((r) => r.loadStatus !== 'success')
    const hasCriticalViolations = results.some((r) =>
      r.accessibility.violations.some((v) => v.impact === 'critical' || v.impact === 'serious'),
    )

    const hasFunctionalFailure = results.some(
      (r) =>
        r.pageCrash ||
        r.consoleErrors.length > 0 ||
        r.failedRequests.length > 0 ||
        r.overflowDetected ||
        r.offscreenElements > 0,
    )

    if (hasLoadFailure || hasCriticalViolations || hasFunctionalFailure) return 'FAIL'

    const allViewportsCovered = VIEWPORTS_ORDER.every((v) => viewports[v] !== undefined)
    if (!allViewportsCovered) return 'INCONCLUSIVE'

    const evidenceComplete = results.every(
      (r) => r.screenshotBytes > 0 && r.accessibility.completed,
    )
    if (!evidenceComplete) return 'INCONCLUSIVE'

    return 'PASS'
  }
}
