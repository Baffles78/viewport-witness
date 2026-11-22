import http from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import {
  collectPerformanceEvidence,
  installPerformanceObservers,
} from '../src/worker/performance.js'
import { createScreenshotAnnotations } from '../src/worker/annotations.js'

describe('browser evidence enrichment', () => {
  it('observes resource sizes and renders numbered boxes without activating controls', async () => {
    // This is a local test of observation helpers, not an exception to service URL validation.
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/asset.js')) {
        res.writeHead(200, { 'Content-Type': 'text/javascript' })
        res.end('window.fixtureLoaded=true;' + ' '.repeat(2000))
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<!doctype html><html><head><title>Evidence fixture</title><script src="/asset.js?secret=hide"></script></head><body><button id="problem" onclick="window.activated=true" style="width:120px;height:40px"></button></body></html>',
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing_fixture_port')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-enrichment-e2e-'))
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
      await installPerformanceObservers(page)
      await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle' })
      const evidence = await collectPerformanceEvidence(page, {
        requestCount: 2,
        transferredBytes: 2000,
      })
      expect(evidence.resourceDetails.observation).toBe('measured')
      expect(
        evidence.resourceDetails.largest.some(
          (entry) => entry.type === 'script' && entry.encodedBodyBytes > 2000,
        ),
      ).toBe(true)
      expect(JSON.stringify(evidence)).not.toContain('secret')
      const source = await page.screenshot()
      const originalHash = createHash('sha256').update(source).digest('hex')
      const annotations = await createScreenshotAnnotations(
        page,
        source,
        path.join(dir, 'annotations.png'),
        '/annotations/phonePortrait',
        [
          {
            code: 'accessibility:button-name',
            selector: '#problem',
            explanation: 'Button has no accessible name.',
          },
        ],
      )
      expect(annotations.boxes).toHaveLength(1)
      expect(annotations.boxes[0]).toMatchObject({
        number: 1,
        selector: '#problem',
        width: 120,
        height: 40,
      })
      expect(annotations.sha256).not.toBe(originalHash)
      expect(createHash('sha256').update(source).digest('hex')).toBe(originalHash)
      expect(
        await page.evaluate(() => Boolean((window as Window & { activated?: boolean }).activated)),
      ).toBe(false)
    } finally {
      await browser.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
