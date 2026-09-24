import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { JobStore } from '../src/db.js'
import { createProductJob } from '../src/api/routes/products.js'
import type { Config } from '../src/config.js'

describe('agent QA products', () => {
  let directory: string
  let store: JobStore
  const enqueue = vi.fn(async (_jobId: string) => undefined)
  const cfg: Config = {
    NODE_ENV: 'test',
    PORT: 3000,
    DATA_DIR: '.',
    SCREENSHOTS_DIR: '.',
    DB_PATH: ':memory:',
    PAYMENT_MODE: 'test',
    ENABLE_MAINNET_PAYMENTS: false,
    ENABLE_SOLANA_PAYMENTS: false,
    FACILITATOR_URL: undefined,
    CDP_API_KEY_ID: undefined,
    CDP_API_KEY_SECRET: undefined,
    CUSTOMER_HASH_SECRET: undefined,
    PAY_TO: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
    SOLANA_TEST_PAY_TO: 'AwnqYWr32DUJvk4XKxfUSpVVYcoUuMFNp8XoBShm5qSS',
    SOLANA_REVENUE_PAY_TO: 'EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk',
    PRICE_USDC: '0.08',
    VERIFY_PRICE_USDC: '0.10',
    COMPARE_PRICE_USDC: '0.12',
    RETENTION_DAYS: 7,
    MAX_STORAGE_GB: 1,
    WORKER_TIMEOUT_MS: 120000,
    LOG_LEVEL: 'info',
  }

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-products-'))
    store = new JobStore(path.join(directory, 'jobs.db'))
    store.init()
    enqueue.mockClear()
  })

  afterEach(async () => {
    store.close()
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('stores bounded assertion work and queues it', async () => {
    const created = await createProductJob({
      store,
      runner: { enqueue },
      cfg,
      kind: 'verify',
      url: 'https://example.com',
      assertions: [{ type: 'noConsoleErrors' }, { type: 'textVisible', value: 'Example' }],
    })

    const job = store.getJob(created.id)
    expect(job?.kind).toBe('verify')
    expect(job?.request.assertions).toHaveLength(2)
    expect(job?.status).toBe('queued')
    expect(enqueue).toHaveBeenCalledWith(created.id)
  })

  it('keeps MCP work inactive until settlement activates it', async () => {
    const created = await createProductJob({
      store,
      runner: { enqueue },
      cfg,
      kind: 'check',
      url: 'https://example.com',
      deferEnqueue: true,
    })

    expect(store.getJob(created.id)?.status).toBe('payment_pending')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('stores a baseline link for comparison jobs', async () => {
    const created = await createProductJob({
      store,
      runner: { enqueue },
      cfg,
      kind: 'compare',
      url: 'https://example.com/new',
      baselineJobId: '550e8400-e29b-41d4-a716-446655440000',
    })

    const job = store.getJob(created.id)
    expect(job?.kind).toBe('compare')
    expect(job?.baselineJobId).toBe('550e8400-e29b-41d4-a716-446655440000')
  })
})
