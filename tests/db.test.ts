import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { JobStore } from '../src/db.js'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'

let store: JobStore
let tmpFile: string

beforeEach(async () => {
  tmpFile = path.join(
    os.tmpdir(),
    `vw-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )
  store = new JobStore(tmpFile)
  store.init()
})

afterEach(async () => {
  store.close()
  try {
    await fs.unlink(tmpFile)
    await fs.unlink(`${tmpFile}-wal`).catch(() => {})
    await fs.unlink(`${tmpFile}-shm`).catch(() => {})
  } catch {
    // ignore
  }
})

function makeJob(overrides: Partial<Parameters<JobStore['createJob']>[0]> = {}) {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    url: 'https://example.com',
    idempotencyKey: null,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  }
}

describe('JobStore - createJob and getJob', () => {
  it('creates and retrieves a job', () => {
    const params = makeJob()
    store.createJob(params)
    const job = store.getJob(params.id)
    expect(job).toBeDefined()
    expect(job?.id).toBe(params.id)
    expect(job?.url).toBe(params.url)
    expect(job?.status).toBe('queued')
  })

  it('returns null for non-existent job', () => {
    expect(store.getJob('nonexistent')).toBeNull()
  })

  it('stores idempotency key', () => {
    const params = makeJob({ idempotencyKey: 'my-key-123' })
    store.createJob(params)
    const job = store.getJobByIdempotencyKey('my-key-123')
    expect(job).toBeDefined()
    expect(job?.id).toBe(params.id)
  })

  it('returns null for missing idempotency key', () => {
    expect(store.getJobByIdempotencyKey('missing-key')).toBeNull()
  })

  it('binds one payment fingerprint to one job', () => {
    const params = makeJob({ paymentId: 'payment-fingerprint' })
    store.createJob(params)
    expect(store.getJobByPaymentId('payment-fingerprint')?.id).toBe(params.id)
    expect(() => {
      store.createJob({ ...makeJob(), paymentId: 'payment-fingerprint' })
    }).toThrow()
  })

  it('lists recoverable jobs by status in creation order', () => {
    const queued = makeJob()
    const failed = makeJob()
    store.createJob(queued)
    store.createJob(failed)
    store.updateJobStatus(failed.id, 'failed')
    expect(store.listJobsByStatuses(['queued']).map((job) => job.id)).toEqual([queued.id])
  })
})

describe('JobStore - status transitions', () => {
  it('transitions queued -> running -> complete', () => {
    const params = makeJob()
    store.createJob(params)

    store.updateJobStatus(params.id, 'running', { startedAt: Date.now() })
    let job = store.getJob(params.id)
    expect(job?.status).toBe('running')
    expect(job?.startedAt).toBeDefined()

    store.updateJobStatus(params.id, 'complete', {
      completedAt: Date.now(),
      reportPath: '/data/report.json',
    })
    job = store.getJob(params.id)
    expect(job?.status).toBe('complete')
    expect(job?.completedAt).toBeDefined()
    expect(job?.reportPath).toBe('/data/report.json')
  })

  it('transitions queued -> running -> failed', () => {
    const params = makeJob()
    store.createJob(params)

    store.updateJobStatus(params.id, 'running', { startedAt: Date.now() })
    store.updateJobStatus(params.id, 'failed', {
      completedAt: Date.now(),
      error: 'browser crash',
    })

    const job = store.getJob(params.id)
    expect(job?.status).toBe('failed')
    expect(job?.error).toBe('browser crash')
  })

  it('markJobRetryable sets status to retryable and increments retryCount', () => {
    const params = makeJob()
    store.createJob(params)
    store.updateJobStatus(params.id, 'running', { startedAt: Date.now() })
    store.markJobRetryable(params.id)

    const job = store.getJob(params.id)
    expect(job?.status).toBe('retryable')
    expect(job?.retryCount).toBe(1)
    expect(job?.startedAt).toBeNull()
  })
})

describe('JobStore - expiry and deletion', () => {
  it('listExpiredJobs returns jobs past expiry', () => {
    const pastExpiry = Date.now() - 1000
    const futureExpiry = Date.now() + 1000 * 60 * 60

    const expired = makeJob({ expiresAt: pastExpiry })
    const notExpired = makeJob({ expiresAt: futureExpiry })

    store.createJob(expired)
    store.createJob(notExpired)

    const expiredList = store.listExpiredJobs(Date.now())
    const ids = expiredList.map((j) => j.id)
    expect(ids).toContain(expired.id)
    expect(ids).not.toContain(notExpired.id)
  })

  it('deleteJob removes job and idempotency key', () => {
    const params = makeJob({ idempotencyKey: 'delete-test-key' })
    store.createJob(params)
    store.deleteJob(params.id)

    expect(store.getJob(params.id)).toBeNull()
    expect(store.getJobByIdempotencyKey('delete-test-key')).toBeNull()
  })
})

describe('JobStore - screenshots', () => {
  it('records and retrieves screenshot', () => {
    const params = makeJob()
    store.createJob(params)
    store.recordScreenshot(params.id, 'phonePortrait', '/data/img.png', 'abc123', 12345)

    const shot = store.getScreenshot(params.id, 'phonePortrait')
    expect(shot).toBeDefined()
    expect(shot?.path).toBe('/data/img.png')
    expect(shot?.sha256).toBe('abc123')
    expect(shot?.bytes).toBe(12345)
  })

  it('returns null for missing screenshot', () => {
    expect(store.getScreenshot('no-job', 'desktop')).toBeNull()
  })
})

describe('JobStore - idempotency entries', () => {
  it('setIdempotencyEntry and getIdempotencyEntry round-trip', () => {
    store.setIdempotencyEntry('key-abc', 'job-xyz')
    const entry = store.getIdempotencyEntry('key-abc')
    expect(entry?.jobId).toBe('job-xyz')
  })

  it('returns null for missing idempotency entry', () => {
    expect(store.getIdempotencyEntry('missing')).toBeNull()
  })

  it('idempotency key is unique', () => {
    const params = makeJob({ idempotencyKey: 'unique-key' })
    store.createJob(params)
    expect(() => {
      store.createJob({ ...makeJob(), idempotencyKey: 'unique-key' })
    }).toThrow()
  })
})
