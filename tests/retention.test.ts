import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RetentionManager } from '../src/retention.js'
import type { JobStore } from '../src/db.js'
import type { JobRecord } from '../src/types.js'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'

function makeJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-normal',
    url: 'https://example.com',
    status: 'complete',
    idempotencyKey: null,
    paymentId: null,
    customerId: null,
    createdAt: Date.now() - 10_000,
    startedAt: null,
    completedAt: null,
    expiresAt: Date.now() - 1_000,
    reportPath: null,
    error: null,
    retryCount: 0,
    kind: 'check',
    request: {},
    baselineJobId: null,
    ...overrides,
  }
}

function makeStore(expired: JobRecord[]): { store: JobStore; deletedIds: string[] } {
  const deletedIds: string[] = []
  const store = {
    listExpiredJobs: () => expired,
    deleteJob: (id: string) => {
      deletedIds.push(id)
    },
  } as unknown as JobStore
  return { store, deletedIds }
}

describe('RetentionManager - path containment', () => {
  let screenshotsDir: string
  let outsideDir: string

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    screenshotsDir = path.join(os.tmpdir(), `vw-shots-${suffix}`)
    outsideDir = path.join(os.tmpdir(), `vw-outside-${suffix}`)
    await fs.mkdir(screenshotsDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(screenshotsDir, { recursive: true, force: true })
    await fs.rm(outsideDir, { recursive: true, force: true })
  })

  it('traversal job ID does not remove a directory outside screenshotsDir', async () => {
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(path.join(outsideDir, 'sentinel.txt'), 'do not delete')

    const escapingId = `../${path.basename(outsideDir)}`
    const { store, deletedIds } = makeStore([makeJobRecord({ id: escapingId })])
    const manager = new RetentionManager(store, screenshotsDir, 100 * 1024 * 1024)

    await manager.runCleanup()

    const sentinel = await fs.readFile(path.join(outsideDir, 'sentinel.txt'), 'utf8')
    expect(sentinel).toBe('do not delete')
    expect(deletedIds).toContain(escapingId)
  })

  it('absolute-path job ID does not remove a directory outside screenshotsDir', async () => {
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(path.join(outsideDir, 'sentinel.txt'), 'do not delete')

    const { store, deletedIds } = makeStore([makeJobRecord({ id: outsideDir })])
    const manager = new RetentionManager(store, screenshotsDir, 100 * 1024 * 1024)

    await manager.runCleanup()

    const sentinel = await fs.readFile(path.join(outsideDir, 'sentinel.txt'), 'utf8')
    expect(sentinel).toBe('do not delete')
    expect(deletedIds).toContain(outsideDir)
  })

  it('empty job ID is skipped safely and DB record is purged', async () => {
    const { store, deletedIds } = makeStore([makeJobRecord({ id: '' })])
    const manager = new RetentionManager(store, screenshotsDir, 100 * 1024 * 1024)

    await expect(manager.runCleanup()).resolves.toMatchObject({ deletedJobs: 1 })
    expect(deletedIds).toContain('')
  })

  it('legitimate expired job directory is removed and bytes are counted', async () => {
    const jobId = 'job-abc123'
    const jobDir = path.join(screenshotsDir, jobId)
    await fs.mkdir(jobDir)
    await fs.writeFile(path.join(jobDir, 'shot.png'), Buffer.alloc(256))

    const { store, deletedIds } = makeStore([makeJobRecord({ id: jobId })])
    const manager = new RetentionManager(store, screenshotsDir, 100 * 1024 * 1024)

    const result = await manager.runCleanup()

    const exists = await fs
      .access(jobDir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
    expect(result.deletedJobs).toBe(1)
    expect(result.freedBytes).toBe(256)
    expect(deletedIds).toContain(jobId)
  })

  it('storage ceiling removes oldest real job dir and does not affect outside dirs', async () => {
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(path.join(outsideDir, 'sentinel.txt'), 'do not delete')

    const jobId = 'job-heavy'
    const jobDir = path.join(screenshotsDir, jobId)
    await fs.mkdir(jobDir)
    await fs.writeFile(path.join(jobDir, 'shot.png'), Buffer.alloc(1024))

    const { store } = makeStore([])
    const manager = new RetentionManager(store, screenshotsDir, 10)

    await manager.runCleanup()

    const jobDirExists = await fs
      .access(jobDir)
      .then(() => true)
      .catch(() => false)
    expect(jobDirExists).toBe(false)

    const sentinel = await fs.readFile(path.join(outsideDir, 'sentinel.txt'), 'utf8')
    expect(sentinel).toBe('do not delete')
  })

  it('multiple expired jobs are all purged from DB even when some IDs are malformed', async () => {
    const goodId = 'job-good'
    await fs.mkdir(path.join(screenshotsDir, goodId))

    const { store, deletedIds } = makeStore([
      makeJobRecord({ id: `../${path.basename(outsideDir)}` }),
      makeJobRecord({ id: goodId }),
      makeJobRecord({ id: '' }),
    ])
    const manager = new RetentionManager(store, screenshotsDir, 100 * 1024 * 1024)

    const result = await manager.runCleanup()

    expect(result.deletedJobs).toBe(3)
    expect(deletedIds).toHaveLength(3)
    expect(deletedIds).toContain(goodId)
  })
})
