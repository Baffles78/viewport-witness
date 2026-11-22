import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { JobStore } from '../src/db.js'
import { WorkerRunner } from '../src/worker/runner.js'
import { buildComparison } from '../src/worker/comparison.js'
import { runViewportCheck } from '../src/worker/browser.js'
import { VIEWPORT_NAMES, type QAReport } from '../src/types.js'
import { makeReport, makeViewport } from './helpers/qa-report-fixtures.js'

vi.mock('../src/worker/browser.js', () => ({ runViewportCheck: vi.fn() }))
const directories: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

function image(changes: number[] = []) {
  const png = new PNG({ width: 10, height: 10 })
  for (let pixel = 0; pixel < 100; pixel++) {
    png.data.set(changes.includes(pixel) ? [255, 255, 255, 255] : [0, 0, 0, 255], pixel * 4)
  }
  return PNG.sync.write(png)
}

async function fixture(changes = [0]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-hosted-worker-'))
  directories.push(dir)
  const dbPath = path.join(dir, 'qa.db'),
    store = new JobStore(dbPath)
  store.init()
  const baseline = makeReport({ id: 'base' }),
    current = makeReport({ id: 'current', kind: 'compare' })
  const reportPath = path.join(dir, 'baseline.json')
  await fs.mkdir(path.join(dir, 'current'))
  store.createJob({
    id: 'base',
    url: baseline.url,
    idempotencyKey: null,
    expiresAt: Date.now() + 100000,
  })
  store.updateJobStatus('base', 'complete', { reportPath })
  store.createJob({
    id: 'current',
    url: baseline.url,
    kind: 'compare',
    baselineJobId: 'base',
    idempotencyKey: null,
    request: { visualExclusions: { desktop: [{ x: 0, y: 0, width: 1, height: 1 }] } },
    expiresAt: Date.now() + 100000,
  })
  for (const viewport of VIEWPORT_NAMES) {
    for (const [id, bytes] of [
      ['base', image()],
      ['current', image(viewport === 'desktop' ? changes : [])],
    ] as const) {
      const file = path.join(dir, `${id}-${viewport}.png`)
      await fs.writeFile(file, bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      store.recordScreenshot(id, viewport, file, sha256, bytes.length)
      const result = (id === 'base' ? baseline : current).viewports[viewport]!
      result.screenshotBytes = bytes.length
      result.screenshotSha256 = sha256
    }
  }
  await fs.writeFile(reportPath, JSON.stringify(baseline))
  return { dir, dbPath, store, baseline, current }
}

describe('hosted worker exclusions and evidence', () => {
  it('executes stored exclusions after reopening and warns when all differences are excluded', async () => {
    const setup = await fixture()
    setup.store.close()
    const store = new JobStore(setup.dbPath)
    store.init()
    try {
      vi.mocked(runViewportCheck).mockImplementation(async (_browser, viewport) => {
        const screenshot = store.getScreenshot('current', viewport)!
        return {
          ...makeViewport(viewport),
          ...setup.current.viewports[viewport]!,
          screenshotPath: screenshot.path,
        }
      })
      const worker = new WorkerRunner(store, setup.dir, 10000, 'test')
      const internal = worker as unknown as {
        browser: object
        runJob(item: { jobId: string; paymentMode: string }, signal: AbortSignal): Promise<QAReport>
      }
      internal.browser = {}
      const original = await fs.readFile(store.getScreenshot('current', 'desktop')!.path)
      const report = await internal.runJob(
        { jobId: 'current', paymentMode: 'test' },
        new AbortController().signal,
      )
      expect(report.comparison?.visual.desktop).toMatchObject({
        changedPixels: 0,
        rawChangedPixels: 1,
        excludedPixels: 1,
        includedPixels: 99,
        exclusions: [{ x: 0, y: 0, width: 1, height: 1 }],
      })
      expect(report.verdict.decision).toBe('review')
      expect(report.verdict.reasons.join(' ')).toContain('inside excluded regions')
      expect(report.limitations.join(' ')).toContain(
        'zero filtered differences do not prove a repair',
      )
      expect(
        report.comparison?.repairVerification?.findings.some(
          (finding) => finding.state === 'fixed',
        ),
      ).toBe(false)
      expect(await fs.readFile(store.getScreenshot('current', 'desktop')!.path)).toEqual(original)
      expect(report.comparison?.visual.desktop?.currentScreenshotSha256).toBe(
        createHash('sha256').update(original).digest('hex'),
      )
      const derivative = PNG.sync.read(
        await fs.readFile(path.join(setup.dir, 'current', 'diff-desktop.png')),
      )
      expect([...derivative.data.subarray(0, 4)]).toEqual([0, 120, 255, 255])
    } finally {
      store.close()
    }
  })

  it('retains outside changes and identical nonvisual/repair outcomes with or without exclusions', async () => {
    const setup = await fixture([0, 9])
    try {
      setup.current.viewports.desktop!.consoleErrors = ['observed error']
      setup.current.viewports.desktop!.overflowDetected = true
      setup.current.viewports.desktop!.accessibility.violations = [
        {
          id: 'button-name',
          impact: 'serious',
          description: 'Missing name',
          helpUrl: 'https://example.com',
          nodes: [{ html: '[redacted]', failureSummary: 'missing', locator: 'button' }],
          count: 1,
        },
      ]
      const raw = await buildComparison(
        setup.store,
        setup.dir,
        'current',
        'base',
        setup.current.viewports,
      )
      const masked = await buildComparison(
        setup.store,
        setup.dir,
        'current',
        'base',
        setup.current.viewports,
        { desktop: [{ x: 0, y: 0, width: 1, height: 1 }] },
      )
      expect(raw.visual.desktop).toMatchObject({ changedPixels: 2, changedPercent: 2 })
      expect(raw.visual.desktop).not.toHaveProperty('exclusions')
      expect(masked.visual.desktop).toMatchObject({
        changedPixels: 1,
        changedPercent: 1.0101,
        rawChangedPixels: 2,
        rawChangedPercent: 2,
      })
      expect(masked.accessibility).toEqual(raw.accessibility)
      expect(masked.errors).toEqual(raw.errors)
      expect(masked.repairVerification).toEqual(raw.repairVerification)
      expect(masked.repairVerification?.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'desktop:console-errors', state: 'newly_broken' }),
          expect.objectContaining({ key: 'desktop:responsive-layout', state: 'newly_broken' }),
          expect.objectContaining({
            key: 'desktop:accessibility:button-name',
            state: 'newly_broken',
          }),
        ]),
      )
    } finally {
      setup.store.close()
    }
  })
})
