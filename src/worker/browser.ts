import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import type { Browser, Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { validatePublicHttpsUrl } from '../ssrf.js'
import type { Viewport, ViewportResult, AccessibilityViolation } from '../types.js'
import { VIEWPORTS as VP } from '../types.js'

const MAX_REQUESTS = 100
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024 // 15 MB
const MAX_CONSOLE_ERRORS = 50
const MAX_FAILED_REQUESTS = 50
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
    let accessibilityResult: ViewportResult['accessibility'] = {
      completed: false,
      violations: [],
      passes: 0,
      incomplete: 0,
      impact: {},
    }

    try {
      const axeResults = await withTimeout(
        new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'])
          .analyze(),
        10_000,
        'accessibility_timeout',
      )

      const violations: AccessibilityViolation[] = axeResults.violations.slice(0, 50).map((v) => ({
        id: v.id,
        impact: (v.impact as AccessibilityViolation['impact']) ?? null,
        description: v.description,
        helpUrl: v.helpUrl,
        nodes: v.nodes.slice(0, 5).map((n) => ({
          html: '[redacted]',
          failureSummary: n.failureSummary?.slice(0, 500) ?? '',
        })),
        count: v.nodes.length,
      }))

      const impactCounts: Record<string, number> = {}
      for (const v of violations) {
        if (v.impact) {
          impactCounts[v.impact] = (impactCounts[v.impact] ?? 0) + 1
        }
      }

      accessibilityResult = {
        completed: true,
        violations,
        passes: axeResults.passes.length,
        incomplete: axeResults.incomplete.length,
        impact: impactCounts,
      }
    } catch {
      // axe failed - record as inconclusive
    }

    // Layout checks
    let overflowDetected = false
    let offscreenElements = 0

    try {
      const layoutData = await withTimeout(
        page.evaluate(() => {
          const overflow = document.body.scrollWidth > window.innerWidth
          const allElements = Array.from(document.querySelectorAll('*'))
          const offscreen = allElements.filter((el) => {
            const rect = el.getBoundingClientRect()
            return rect.right > window.innerWidth * 1.2 && rect.width > 10
          }).length
          return { overflow, offscreen }
        }),
        5_000,
        'layout_timeout',
      )
      overflowDetected = layoutData.overflow
      offscreenElements = layoutData.offscreen
    } catch {
      // ignore
    }

    // Interaction observations
    let interactionObservations: ViewportResult['interactionObservations'] = {
      visibleControls: 0,
      focusableControls: 0,
      keyboardReachable: false,
    }

    try {
      const interactionData = await withTimeout(
        page.evaluate(() => {
          const controls = Array.from(
            document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]'),
          )
          const isVisible = (el: Element): boolean => {
            const rect = el.getBoundingClientRect()
            const style = window.getComputedStyle(el)
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0'
            )
          }
          const visible = controls.filter(isVisible).length
          const focusable = Array.from(document.querySelectorAll('[tabindex]')).filter((el) => {
            const ti = el.getAttribute('tabindex')
            return ti !== null && parseInt(ti, 10) >= 0 && isVisible(el)
          }).length

          // Simple keyboard reachability: check if there are any focusable elements
          const anyFocusable = visible > 0 || focusable > 0
          return { visible, focusable, anyFocusable }
        }),
        5_000,
        'interaction_timeout',
      )
      interactionObservations = {
        visibleControls: interactionData.visible,
        focusableControls: interactionData.focusable,
        keyboardReachable: interactionData.anyFocusable,
      }
    } catch {
      // ignore
    }

    // Screenshot
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error('invalid_job_id')
    const screenshotsRoot = path.resolve(screenshotsDir)
    const jobScreenshotsDir = path.resolve(screenshotsRoot, jobId)
    if (path.dirname(jobScreenshotsDir) !== screenshotsRoot) throw new Error('invalid_job_path')
    await fs.mkdir(jobScreenshotsDir, { recursive: true })

    const screenshotFilename = `${viewport}-${Date.now()}.png`
    const screenshotPath = path.join(jobScreenshotsDir, screenshotFilename)

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
      consoleErrors,
      pageCrash,
      failedRequests,
      overflowDetected,
      offscreenElements,
      accessibility: accessibilityResult,
      interactionObservations,
    }
  } finally {
    signal?.removeEventListener('abort', abortHandler)
    await context.close().catch(() => undefined)
  }
}
