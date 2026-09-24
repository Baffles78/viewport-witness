import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { JobStore } from '../src/db.js'

let store: JobStore
let tmpFile: string

beforeEach(async () => {
  tmpFile = path.join(os.tmpdir(), `vw-idm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  store = new JobStore(tmpFile)
  store.init()
})

afterEach(async () => {
  store.close()
  try {
    await fs.unlink(tmpFile).catch(() => {})
    await fs.unlink(`${tmpFile}-wal`).catch(() => {})
    await fs.unlink(`${tmpFile}-shm`).catch(() => {})
  } catch {
    // ignore
  }
})

describe('Idempotency - job store layer', () => {
  it('same idempotency key returns same job', () => {
    const jobId = 'job-idem-1'
    store.createJob({
      id: jobId,
      url: 'https://example.com',
      idempotencyKey: 'my-key',
      expiresAt: Date.now() + 86400000,
    })

    const found = store.getJobByIdempotencyKey('my-key')
    expect(found?.id).toBe(jobId)
  })

  it('different keys create different jobs', () => {
    store.createJob({
      id: 'job-idem-a',
      url: 'https://example.com',
      idempotencyKey: 'key-a',
      expiresAt: Date.now() + 86400000,
    })
    store.createJob({
      id: 'job-idem-b',
      url: 'https://example.com',
      idempotencyKey: 'key-b',
      expiresAt: Date.now() + 86400000,
    })

    const a = store.getJobByIdempotencyKey('key-a')
    const b = store.getJobByIdempotencyKey('key-b')

    expect(a?.id).toBe('job-idem-a')
    expect(b?.id).toBe('job-idem-b')
    expect(a?.id).not.toBe(b?.id)
  })

  it('no idempotency key creates new job each time', () => {
    store.createJob({
      id: 'job-no-key-1',
      url: 'https://example.com',
      idempotencyKey: null,
      expiresAt: Date.now() + 86400000,
    })
    store.createJob({
      id: 'job-no-key-2',
      url: 'https://example.com',
      idempotencyKey: null,
      expiresAt: Date.now() + 86400000,
    })

    const j1 = store.getJob('job-no-key-1')
    const j2 = store.getJob('job-no-key-2')
    expect(j1).toBeDefined()
    expect(j2).toBeDefined()
    expect(j1?.id).not.toBe(j2?.id)
  })

  it('duplicate idempotency key throws (DB constraint)', () => {
    store.createJob({
      id: 'job-dup-1',
      url: 'https://example.com',
      idempotencyKey: 'dup-key',
      expiresAt: Date.now() + 86400000,
    })

    expect(() =>
      store.createJob({
        id: 'job-dup-2',
        url: 'https://example.com',
        idempotencyKey: 'dup-key',
        expiresAt: Date.now() + 86400000,
      }),
    ).toThrow()
  })
})
