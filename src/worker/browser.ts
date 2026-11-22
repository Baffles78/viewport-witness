import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import type { Browser, Page } from 'playwright'
import { validatePublicHttpsUrl } from '../ssrf.js'
import { observeInteraction } from './interaction.js'
import { observeLayout } from './layout.js'
import { runAccessibilityCheck } from './accessibility.js'
import { evaluatePageAssertions } from './page-assertions.js'
import { withTimeout } from './timeout.js'
import { installPerformanceObservers, collectPerformanceEvidence } from './performance.js'
import { createScreenshotAnnotations, type ScreenshotAnnotations } from './annotations.js'
import type { Viewport, ViewportResult, PageAssertion } from '../types.js'
import { VIEWPORTS as VP } from '../types.js'

const MAX_REQUESTS = 100
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024 // 15 MB
const MAX_CONSOLE_ERRORS = 50
const MAX_FAILED_REQUESTS = 50
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return `${u.protocol}//${u.hostname}`
  } catch {
    return '[redacted]'
  }
}

export async function runViewportCheck(
  browser: Browser,
  viewport: Viewport,
  targetUrl: string,
  screenshotsDir: string,
  jobId: string,
  signal?: AbortSignal,
  assertions: PageAssertion[] = [],
): Promise<ViewportResult & { screenshotPath: string }> {
  const dimensions = VP[viewport]
  const context = await browser.newContext({
    viewport: dimensions,
    userAgent: 'Mozilla/5.0 (compatible; ViewportWitness/0.1)',
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
  })

  const abortHandler = (): void => {
    void context.close().catch(() => undefined)
  }
  signal?.addEventListener('abort', abortHandler, { once: true })
  if (signal?.aborted) {
    await context.close()
    throw new Error('job_aborted')
  }

  try {
    const page: Page = await context.newPage()
    await installPerformanceObservers(page)
    const consoleErrors: string[] = []
    let pageCrash = false
    const failedRequests: Array<{ url: string; status: number | null; reason: string }> = []
    let requestCount = 0
    let responseBytes = 0
    let redirectCount = 0
    let loadStatus: 'success' | 'timeout' | 'error' = 'error'
    let loadTimeMs = 0
    let finalUrl = targetUrl
    const startTime = Date.now()

    // Track actual transferred bytes without using route.fetch(). route.fetch()
    // follows redirects internally and can bypass per-request destination checks.
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    cdp.on('Network.dataReceived', (event) => {
      responseBytes += event.encodedDataLength
      if (responseBytes > MAX_RESPONSE_BYTES) {
        void page.close({ runBeforeUnload: false }).catch(() => undefined)
      }
    })

    // Console error listener
    page.on('console', (msg) => {
      if (msg.type() === 'error' && consoleErrors.length < MAX_CONSOLE_ERRORS) {
        // Redact any URLs in console messages
        const text = msg
          .text()
          .slice(0, 500)
          .replace(/https?:\/\/[^\s"')]+/g, '[url]')
        consoleErrors.push(text)
      }
    })

    page.on('pageerror', () => {
      pageCrash = true
    })

    page.on('crash', () => {
      pageCrash = true
    })

    page.on('response', (response) => {
      const status = response.status()
      if (status >= 400 && failedRequests.length < MAX_FAILED_REQUESTS) {
        failedRequests.push({
          url: redactUrl(response.url()),
          status,
          reason: `http_${status}`,
        })
      }
    })

    // Request interception for SSRF and resource limiting
    await page.route('**/*', async (route) => {
      const request = route.request()
      const reqUrl = request.url()

      requestCount++
      if (requestCount > MAX_REQUESTS) {
        await route.abort('blockedbyclient')
        return
      }

      if (responseBytes > MAX_RESPONSE_BYTES) {
        await route.abort('blockedbyclient')
        return
      }

      // Apply the complete URL policy to the initial navigation, redirects, and
      // every subrequest. This includes schemes, ports, URL credentials, local
      // names, inline IPs, and DNS-resolved IPs.
      try {
        const urlCheck = await validatePublicHttpsUrl(reqUrl)
        if (!urlCheck.valid) {
          await route.abort('blockedbyclient')
          if (failedRequests.length < MAX_FAILED_REQUESTS) {
            failedRequests.push({
              url: redactUrl(reqUrl),
              status: null,
              reason: urlCheck.reason ?? 'blocked_url',
            })
          }
          return
        }
      } catch {
        await route.abort('blockedbyclient')
        return
      }

      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        let redirect = request.redirectedFrom()
        let depth = 0
        while (redirect) {
          depth++
          redirect = redirect.redirectedFrom()
        }
        if (depth > 5) {
          await route.abort('blockedbyclient')
          return
        }
      }

      await route.continue()
    })

    // Navigation
    try {
      const response = await page.goto(targetUrl, {
        timeout: 30000,
        waitUntil: 'networkidle',
      })

      loadTimeMs = Date.now() - startTime
      loadStatus = 'success'
      finalUrl = page.url()

      // Count redirects
      if (response) {
        const chain = response.request().redirectedFrom()
        let r = chain
        while (r) {
          redirectCount++
          r = r.redirectedFrom()
        }
      }
    } catch (err: unknown) {
      loadTimeMs = Date.now() - startTime
      const msg = (err as Error).message ?? ''
      if (msg.includes('timeout') || msg.includes('Timeout')) {
        loadStatus = 'timeout'
        // Try to capture partial page
        try {
          finalUrl = page.url()
        } catch {
          // ignore
        }
      } else {
        loadStatus = 'error'
      }
    }

    // Accessibility check
    const accessibilityResult = await runAccessibilityCheck(page)

    // Layout checks
    const layoutData = await observeLayout(page)
    const { overflowDetected, offscreenElements, layoutLocatorHints, layoutObservation } =
      layoutData

    const performanceEvidence = await collectPerformanceEvidence(page, {
      requestCount: Math.min(requestCount, MAX_REQUESTS + 1),
      transferredBytes: Math.min(MAX_RESPONSE_BYTES, Math.max(0, Math.round(responseBytes))),
    })

    // Declarative, read-only assertions (src/worker/page-assertions.ts).
    const assertionResults = await evaluatePageAssertions(
      page,
      assertions,
      layoutData,
      consoleErrors,
    )

    // Interaction observations
    let interactionObservations: ViewportResult['interactionObservations'] = {
      visibleControls: 0,
      focusableControls: 0,
      keyboardReachable: false,
      keyboardObservation: 'unavailable',
    }

    try {
      const interactionData = await withTimeout(
        observeInteraction(page),
        5_000,
        'interaction_timeout',
      )
      interactionObservations = {
        visibleControls: interactionData.visible,
        focusableControls: interactionData.focusable,
        keyboardReachable: interactionData.anyFocusable,
        keyboardObservation: 'focusability_heuristic',
      }
    } catch {
      // Observation unavailable; no Tab traversal or activation is claimed.
    }

    // Screenshot
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error('invalid_job_id')
    const screenshotsRoot = path.resolve(screenshotsDir)
    const jobScreenshotsDir = path.resolve(screenshotsRoot, jobId)
    if (path.dirname(jobScreenshotsDir) !== screenshotsRoot) throw new Error('invalid_job_path')
    await fs.mkdir(jobScreenshotsDir, { recursive: true })

    const screenshotFilename = `${viewport}-${Date.now()}.png`
    const screenshotPath = path.join(jobScreenshotsDir, screenshotFilename)

    let annotations: ScreenshotAnnotations | undefined
    let screenshotBytes = 0
    let screenshotSha256 = ''
    let screenshotDimensions = { w: dimensions.width, h: dimensions.height }

    try {
      await page.screenshot({
        path: screenshotPath,
        fullPage: false,
        type: 'png',
      })

      const fileData = await fs.readFile(screenshotPath)
      screenshotBytes = fileData.length
      screenshotSha256 = crypto.createHash('sha256').update(fileData).digest('hex')

      // Get actual dimensions from viewport
      screenshotDimensions = { w: dimensions.width, h: dimensions.height }
      try {
        const hints = [
          ...layoutLocatorHints.map((selector) => ({
            code: 'responsive-layout',
            selector,
            explanation: 'Content extends beyond the tested viewport.',
          })),
          ...accessibilityResult.violations.flatMap((violation) =>
            violation.nodes.flatMap((node) =>
              node.locator
                ? [
                    {
                      code: `accessibility:${violation.id}`,
                      selector: node.locator,
                      explanation: violation.description,
                    },
                  ]
                : [],
            ),
          ),
        ]
        if (hints.length > 0) {
          annotations = await createScreenshotAnnotations(
            page,
            fileData,
            path.join(jobScreenshotsDir, `annotations-${viewport}.png`),
            `/v1/checks/${jobId}/annotations/${viewport}`,
            hints,
          )
        }
      } catch {
        // Derivative failure never discards the original screenshot evidence.
      }
    } catch {
      // Screenshot failed - create placeholder path
    }

    return {
      viewport,
      dimensions,
      loadStatus,
      loadTimeMs,
      finalUrl: redactUrl(finalUrl),
      redirectCount,
      screenshotPath,
      screenshotUrl: `/v1/checks/${jobId}/screenshots/${viewport}`,
      screenshotDimensions,
      screenshotBytes,
      screenshotSha256,
      ...(annotations ? { annotations } : {}),
      consoleErrors,
      pageCrash,
      failedRequests,
      overflowDetected,
      offscreenElements,
      layoutLocatorHints,
      layoutObservation,
      performance: performanceEvidence,
      accessibility: accessibilityResult,
      interactionObservations,
      ...(assertionResults ? { assertions: assertionResults } : {}),
    }
  } finally {
    signal?.removeEventListener('abort', abortHandler)
    await context.close().catch(() => undefined)
  }
}
