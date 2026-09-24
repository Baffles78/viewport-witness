import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { chromium, type Browser } from 'playwright'
import type { JobStore } from '../db.js'
import type { QAReport, Viewport, ViewportResult } from '../types.js'
import { runViewportCheck } from './browser.js'

const VIEWPORTS_ORDER: Viewport[] = ['phonePortrait', 'phoneLandscape', 'desktop']

interface QueueItem {
  jobId: string
  url: string
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
      this.queue.push({ jobId: job.id, url: job.url, paymentMode: this.paymentMode })
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

  async enqueue(jobId: string, url: string): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Worker is shutting down')
    }
    this.queue.push({ jobId, url, paymentMode: this.paymentMode })
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

  private async runJob(item: QueueItem, signal: AbortSignal): Promise<QAReport> {
    if (!this.browser) throw new Error('Browser not initialized')

    const job = this.store.getJob(item.jobId)
    if (!job) throw new Error(`Job ${item.jobId} not found`)

    const viewportResults: Partial<Record<Viewport, InternalViewportResult>> = {}
    const limitations: string[] = []

    for (const viewport of VIEWPORTS_ORDER) {
      if (signal.aborted) throw new Error('job_aborted')
      try {
        const result = await runViewportCheck(
          this.browser,
          viewport,
          item.url,
          this.screenshotsDir,
          item.jobId,
          signal,
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

    const reportObj: Omit<QAReport, 'contentHash'> = {
      id: job.id,
      url: job.url,
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
    }

    // Compute content hash (evidence of integrity, not a cryptographic signature)
    const reportJson = JSON.stringify(reportObj)
    const contentHash = crypto.createHash('sha256').update(reportJson).digest('hex')

    return { ...reportObj, contentHash }
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
