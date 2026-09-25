import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { JobStore } from '../src/db.js'
import { createProductJob, hasCompleteBaselineScreenshots } from '../src/api/routes/products.js'
import type { Config } from '../src/config.js'
import { mcpPaymentFingerprint } from '../src/mcp.js'

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
    const updateSpy = vi.spyOn(store, 'updateJobStatus')
    const created = await createProductJob({
      store,
      runner: { enqueue },
      cfg,
      kind: 'check',
      url: 'https://example.com',
      deferEnqueue: true,
    })

    expect(store.getJob(created.id)?.status).toBe('payment_pending')
    expect(updateSpy).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    expect(store.activatePaymentPendingJob(created.id)).toBe(true)
    expect(store.activatePaymentPendingJob(created.id)).toBe(false)
    expect(store.getJob(created.id)?.status).toBe('queued')
  })

  it('returns the original job when a durable payment fingerprint is replayed', async () => {
    const first = await createProductJob({
      store,
      runner: { enqueue },
      cfg,
      kind: 'check',
      url: 'https://example.com',
      paymentId: 'mcp_same_payment',
      deferEnqueue: true,
    })
    const replay = await createProductJob({
      store,
      runner: { enqueue },
      cfg,
      kind: 'check',
      url: 'https://example.com',
      paymentId: 'mcp_same_payment',
      deferEnqueue: true,
    })

    expect(replay.id).toBe(first.id)
    expect(store.listJobsByStatuses(['payment_pending'])).toHaveLength(1)
  })

  it('collapses concurrent payment replay to one durable job', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        createProductJob({
          store,
          runner: { enqueue },
          cfg,
          kind: 'check',
          url: 'https://example.com',
          paymentId: 'mcp_concurrent_payment',
          deferEnqueue: true,
        }),
      ),
    )
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(1)
    expect(store.listJobsByStatuses(['payment_pending'])).toHaveLength(1)
  })

  it('terminalizes failed settlement without clobbering activated work', async () => {
    const created = await createProductJob({
      store,
      runner: { enqueue },
      cfg,
      kind: 'check',
      url: 'https://example.com',
      paymentId: 'mcp_failed_payment',
      deferEnqueue: true,
    })
    expect(store.failPaymentPendingJob(created.id, 'payment_not_settled')).toBe(true)
    expect(store.failPaymentPendingJob(created.id, 'payment_not_settled')).toBe(false)
    expect(store.getJob(created.id)?.status).toBe('failed')

    const activated = await createProductJob({
      store,
      runner: { enqueue },
      cfg,
      kind: 'check',
      url: 'https://example.com',
      paymentId: 'mcp_settled_payment',
      deferEnqueue: true,
    })
    expect(store.activatePaymentPendingJob(activated.id)).toBe(true)
    expect(store.failPaymentPendingJob(activated.id, 'late_failure')).toBe(false)
    expect(store.getJob(activated.id)?.status).toBe('queued')
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

  it('requires all three baseline screenshots', () => {
    const baselineId = '550e8400-e29b-41d4-a716-446655440000'
    store.createJob({
      id: baselineId,
      url: 'https://example.com',
      idempotencyKey: null,
      expiresAt: Date.now() + 60_000,
    })
    expect(hasCompleteBaselineScreenshots(store, baselineId)).toBe(false)
    for (const viewport of ['phonePortrait', 'phoneLandscape', 'desktop']) {
      store.recordScreenshot(baselineId, viewport, `${viewport}.png`, `sha-${viewport}`, 100)
    }
    expect(hasCompleteBaselineScreenshots(store, baselineId)).toBe(true)
  })

  it('canonicalizes MCP payment payloads before fingerprinting', () => {
    const authorization = {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '100000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: `0x${'1'.repeat(64)}`,
    }
    const accepted = {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '100000',
      asset: '0x3333333333333333333333333333333333333333',
      payTo: '0x4444444444444444444444444444444444444444',
      maxTimeoutSeconds: 60,
    }
    const first = mcpPaymentFingerprint({
      x402Version: 2,
      accepted,
      payload: { authorization, signature: `0x${'a'.repeat(130)}` },
    })
    const semanticVariant = mcpPaymentFingerprint({
      x402Version: 2,
      ignoredTopLevel: 'does-not-change-payment',
      accepted: { ...accepted, ignoredAcceptedField: true },
      payload: {
        ignoredPayloadField: 'not-signed',
        signature: `0x${'a'.repeat(130)}`,
        authorization: { ignoredAuthorizationField: 123, ...authorization },
      },
    })
    expect(first).toMatch(/^mcp_[a-f0-9]{64}$/)
    expect(semanticVariant).toBe(first)
    expect(mcpPaymentFingerprint(undefined)).toBeUndefined()
  })
})
