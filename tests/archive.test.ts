import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { v4 as uuidv4 } from 'uuid'
import { JobStore } from '../src/db.js'
import { ArchiveManager, archiveUrlKey, type ArchivedSnapshot } from '../src/archive.js'
import { RetentionManager } from '../src/retention.js'
import { createHistoryRouter } from '../src/api/routes/history.js'
import { validateConfig, type Config } from '../src/config.js'
import type { JobKind, QAReport, Viewport } from '../src/types.js'

const VIEWPORTS: Viewport[] = ['phonePortrait', 'phoneLandscape', 'desktop']
const DAY = 24 * 60 * 60 * 1000

let tmp: string
let store: JobStore
let screenshotsDir: string
let archiveDir: string
const servers: Server[] = []

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-archive-'))
  screenshotsDir = path.join(tmp, 'screenshots')
  archiveDir = path.join(tmp, 'archive')
  await fs.mkdir(screenshotsDir, { recursive: true })
  await fs.mkdir(archiveDir, { recursive: true })
  store = new JobStore(path.join(tmp, 'vw.db'))
  store.init()
})

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  )
  store.close()
  await fs.rm(tmp, { recursive: true, force: true })
})

function makeArchive(overrides: Partial<ConstructorParameters<typeof ArchiveManager>[1]> = {}) {
  return new ArchiveManager(store, {
    archiveDir,
    screenshotsDir,
    retentionDays: 90,
    maxStorageBytes: 1024 * 1024 * 1024,
    maxSnapshotsPerUrl: 30,
    ...overrides,
  })
}

// Creates a completed job with three screenshots on disk, as the worker would.
async function completedJob(
  url: string,
  { createdAt = Date.now(), kind = 'check' as JobKind, pngBytes = 64 } = {},
) {
  const id = uuidv4()
  store.createJob({ id, url, idempotencyKey: null, expiresAt: Date.now() + 7 * DAY, kind })
  const jobDir = path.join(screenshotsDir, id)
  await fs.mkdir(jobDir, { recursive: true })
  const viewports: QAReport['viewports'] = {}
  for (const viewport of VIEWPORTS) {
    const file = path.join(jobDir, `${viewport}.png`)
    await fs.writeFile(file, Buffer.alloc(pngBytes, 1))
    store.recordScreenshot(id, viewport, file, 'sha', pngBytes)
    viewports[viewport] = {
      viewport,
      screenshotUrl: `/v1/checks/${id}/screenshots/${viewport}`,
      screenshotBytes: pngBytes,
      assertions: [
        { assertion: { type: 'textVisible', value: 'secret' }, passed: true, detail: '' },
      ],
    } as unknown as QAReport['viewports'][Viewport]
  }
  const report = {
    id,
    url,
    kind,
    status: 'PASS',
    paymentMode: 'test',
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + 7 * DAY).toISOString(),
    checksPerformed: ['screenshot'],
    limitations: [],
    contentHash: 'abc',
    viewports,
    summary: { totalViolations: 0, criticalViolations: 0, totalErrors: 0, overallLoadStatus: 'ok' },
    verdict: {
      decision: 'safe_to_ship',
      blockingIssues: 0,
      warnings: 0,
      reasons: [],
      recommendedActions: [],
    },
    diagnosis: { overview: 'fine', findings: [] },
    assertions: { passed: 1, failed: 0, results: {} },
    comparison: { baselineJobId: 'other-job' },
  } as unknown as QAReport
  return { job: store.getJob(id)!, report }
}

describe('archiveUrlKey', () => {
  it('matches one exact public HTTPS page', () => {
    expect(archiveUrlKey('https://Example.COM:443/a?b=1#frag')).toBe('https://example.com/a?b=1')
    expect(archiveUrlKey('https://example.com')).toBe('https://example.com/')
    expect(archiveUrlKey('http://example.com')).toBeNull()
    expect(archiveUrlKey('https://user:pw@example.com')).toBeNull()
    expect(archiveUrlKey('https://example.com:8443/')).toBeNull()
    expect(archiveUrlKey('not a url')).toBeNull()
  })
})

describe('ArchiveManager', () => {
  it('stores a public copy of the report and screenshots without job or caller data', async () => {
    const archive = makeArchive()
    const { job, report } = await completedJob('https://example.com/pricing#top')
    const record = await archive.capture(job, report)
    expect(record).not.toBeNull()
    expect(record!.url).toBe('https://example.com/pricing')

    const snapshot = (await archive.readSnapshot(record!.id)) as ArchivedSnapshot
    const text = JSON.stringify(snapshot)
    expect(text).not.toContain(job.id)
    expect(text).not.toContain('secret')
    expect(snapshot).not.toHaveProperty('assertions')
    expect(snapshot).not.toHaveProperty('comparison')
    expect(snapshot.viewports.desktop?.screenshotUrl).toBe(
      `/v1/history/snapshots/${record!.id}/screenshots/desktop`,
    )
    const png = await fs.readFile(archive.screenshotPath(record!.id, 'desktop')!)
    expect(png.length).toBe(64)
  })

  it('archives each job once and skips non-browser products', async () => {
    const archive = makeArchive()
    const { job, report } = await completedJob('https://example.com')
    expect(await archive.capture(job, report)).not.toBeNull()
    expect(await archive.capture(job, report)).toBeNull()
    const extract = await completedJob('https://example.com', { kind: 'extract' })
    expect(await archive.capture(extract.job, extract.report)).toBeNull()
    expect(store.archiveAvailability('https://example.com/').count).toBe(1)
  })

  it('keeps only the newest snapshots per URL', async () => {
    const archive = makeArchive({ maxSnapshotsPerUrl: 2 })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const { job, report } = await completedJob('https://example.com', {
        createdAt: Date.now() - (4 - i) * 1000,
      })
      ids.push((await archive.capture(job, report))!.id)
    }
    const kept = store.listArchiveSnapshots('https://example.com/', { limit: 10 }).map((r) => r.id)
    expect(kept).toEqual([ids[3], ids[2]])
    await expect(fs.stat(path.join(archiveDir, ids[0]!))).rejects.toThrow()
  })

  it('enforces the storage ceiling oldest first', async () => {
    const archive = makeArchive({ maxStorageBytes: 5000 })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const { job, report } = await completedJob(`https://example.com/${i}`, {
        createdAt: Date.now() - (3 - i) * 1000,
        pngBytes: 1000,
      })
      ids.push((await archive.capture(job, report))!.id)
    }
    expect(store.archiveTotalBytes()).toBeLessThanOrEqual(5000)
    expect(store.getArchiveSnapshot(ids[0]!)).toBeNull()
    expect(store.getArchiveSnapshot(ids[2]!)).not.toBeNull()
  })

  it('deletes expired snapshots on cleanup', async () => {
    const archive = makeArchive({ retentionDays: 1 })
    const { job, report } = await completedJob('https://example.com')
    const record = (await archive.capture(job, report))!
    const result = await archive.runCleanup(Date.now() + 2 * DAY)
    expect(result.deletedSnapshots).toBe(1)
    expect(store.getArchiveSnapshot(record.id)).toBeNull()
    await expect(fs.stat(path.join(archiveDir, record.id))).rejects.toThrow()
  })

  it('outlives the seven-day job cleanup', async () => {
    const archive = makeArchive()
    const { job, report } = await completedJob('https://example.com')
    const record = (await archive.capture(job, report))!
    store.updateJobStatus(job.id, 'complete')
    // Force the job to expire, then run normal job retention.
    ;(store as unknown as { conn: { prepare(sql: string): { run(...a: unknown[]): void } } }).conn
      .prepare('UPDATE jobs SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, job.id)
    await new RetentionManager(store, screenshotsDir, 10 * 1024 ** 3).runCleanup()
    expect(store.getJob(job.id)).toBeNull()
    expect(await archive.readSnapshot(record.id)).not.toBeNull()
    expect((await fs.readFile(archive.screenshotPath(record.id, 'phonePortrait')!)).length).toBe(64)
  })

  it('rejects snapshot IDs that are not UUIDs', async () => {
    const archive = makeArchive()
    expect(archive.screenshotPath('../etc', 'desktop')).toBeNull()
    expect(await archive.readSnapshot('../../vw.db')).toBeNull()
  })
})

function historyConfig(overrides: Partial<Config> = {}): Config {
  return {
    PAYMENT_MODE: 'test',
    ARCHIVE_ENABLED: true,
    ARCHIVE_RETENTION_DAYS: 90,
    HISTORY_MAX_RESULTS: 2,
    HISTORY_PRICE_USDC: '0.02',
    ...overrides,
  } as Config
}

async function serve(
  archive: ArchiveManager | null,
  cfg: Config,
  payment: express.RequestHandler = (_req, _res, next) => next(),
): Promise<string> {
  const app = express()
  app.use(express.json())
  app.use(createHistoryRouter(store, archive, cfg, payment))
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('history API', () => {
  it('is fully off unless enabled', async () => {
    const payment = vi.fn()
    const base = await serve(null, historyConfig({ ARCHIVE_ENABLED: false }), payment)
    const listed = await post(base, { url: 'https://example.com' })
    expect(listed.status).toBe(404)
    expect((await listed.json()).code).toBe('archive_disabled')
    expect((await fetch(`${base}/v1/history/availability?url=https://example.com`)).status).toBe(
      404,
    )
    expect(payment).not.toHaveBeenCalled()
  })

  it('reports availability, pages history newest first and serves snapshots', async () => {
    const archive = makeArchive()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const { job, report } = await completedJob('https://example.com/', {
        createdAt: Date.now() - (3 - i) * 60_000,
      })
      ids.push((await archive.capture(job, report))!.id)
    }
    const base = await serve(archive, historyConfig())

    const availability = await (
      await fetch(
        `${base}/v1/history/availability?url=${encodeURIComponent('https://example.com')}`,
      )
    ).json()
    expect(availability.snapshots).toBe(3)
    expect(availability.price).toBe('$0.02 USDC')

    const first = await (await post(base, { url: 'https://example.com', limit: 50 })).json()
    expect(first.snapshots.map((s: { snapshotId: string }) => s.snapshotId)).toEqual([
      ids[2],
      ids[1],
    ])
    expect(first.nextBefore).not.toBeNull()
    const second = await (
      await post(base, { url: 'https://example.com', before: first.nextBefore })
    ).json()
    expect(second.snapshots.map((s: { snapshotId: string }) => s.snapshotId)).toEqual([ids[0]])
    expect(second.nextBefore).toBeNull()

    const snapshot = await fetch(`${base}${first.snapshots[0].snapshotUrl}`)
    expect(snapshot.status).toBe(200)
    expect((await snapshot.json()).schema).toBe('viewport-witness-snapshot/v1')
    const png = await fetch(`${base}/v1/history/snapshots/${ids[2]}/screenshots/desktop`)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect((await fetch(`${base}/v1/history/snapshots/${ids[2]}/screenshots/tv`)).status).toBe(400)
    expect((await fetch(`${base}/v1/history/snapshots/not-a-uuid`)).status).toBe(404)
  })

  it('rejects bad input', async () => {
    const base = await serve(makeArchive(), historyConfig())
    expect((await post(base, { url: 'http://example.com' })).status).toBe(400)
    expect((await post(base, { url: 'https://example.com', extra: 1 })).status).toBe(422)
    expect((await post(base, { url: 'https://example.com', limit: 0 })).status).toBe(422)
  })

  it('challenges unsigned paid requests and never charges for an empty archive', async () => {
    const payment = vi.fn((_req, res) => {
      res.status(402).json({ error: 'payment_required' })
    })
    const base = await serve(makeArchive(), historyConfig({ PAYMENT_MODE: 'production' }), payment)
    expect((await post(base, { url: 'https://example.com' })).status).toBe(402)
    expect(payment).toHaveBeenCalledOnce()

    const signed = await post(base, { url: 'https://example.com' }, { 'payment-signature': 'x' })
    expect(signed.status).toBe(404)
    expect((await signed.json()).code).toBe('no_snapshots')
    expect(payment).toHaveBeenCalledOnce()
  })

  it('requires settlement in paid modes', async () => {
    const archive = makeArchive()
    const { job, report } = await completedJob('https://example.com/')
    await archive.capture(job, report)
    const settled = vi.fn((req, _res, next) => {
      req.paymentResult = { settled: true, mode: 'production', paymentId: 'p1' }
      next()
    })
    const base = await serve(archive, historyConfig({ PAYMENT_MODE: 'production' }), settled)
    const response = await post(base, { url: 'https://example.com' }, { 'payment-signature': 'x' })
    expect(response.status).toBe(200)
    expect((await response.json()).snapshots).toHaveLength(1)

    const unsettled = await serve(
      archive,
      historyConfig({ PAYMENT_MODE: 'production' }),
      (_req, _res, next) => next(),
    )
    expect(
      (await post(unsettled, { url: 'https://example.com' }, { 'payment-signature': 'x' })).status,
    ).toBe(402)
  })
})

describe('archive configuration', () => {
  it('refuses an archive directory that job cleanup could delete', () => {
    const base = {
      PAYMENT_MODE: 'test',
      ARCHIVE_ENABLED: true,
      SCREENSHOTS_DIR: './data/screenshots',
    } as Config
    expect(() => validateConfig({ ...base, ARCHIVE_DIR: './data/screenshots/archive' })).toThrow(
      /ARCHIVE_DIR/,
    )
    expect(() => validateConfig({ ...base, ARCHIVE_DIR: './data' })).toThrow(/ARCHIVE_DIR/)
    expect(() => validateConfig({ ...base, ARCHIVE_DIR: './data/archive' })).not.toThrow()
  })
})
