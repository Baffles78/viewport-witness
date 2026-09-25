import { afterEach, describe, expect, it, vi } from 'vitest'
import express, { type RequestHandler } from 'express'
import { promises as fs } from 'node:fs'
import http, { type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createChecksRouter } from '../src/api/routes/checks.js'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import type { JobRecord } from '../src/types.js'
import type { WorkerRunner } from '../src/worker/runner.js'

vi.mock('../src/ssrf.js', () => ({
  validatePublicHttpsUrl: vi.fn(async () => ({ valid: true })),
}))

const servers: Server[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function config(screenshotsDir: string, mode: Config['PAYMENT_MODE'] = 'test'): Config {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DATA_DIR: screenshotsDir,
    SCREENSHOTS_DIR: screenshotsDir,
    DB_PATH: path.join(screenshotsDir, 'vw.db'),
    PAYMENT_MODE: mode,
    ENABLE_MAINNET_PAYMENTS: mode === 'production',
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
    MAX_STORAGE_GB: 10,
    WORKER_TIMEOUT_MS: 120_000,
    LOG_LEVEL: 'info',
  }
}

async function listen(
  store: JobStore,
  cfg: Config,
  paymentMiddleware: RequestHandler,
): Promise<string> {
  const app = express()
  app.use(express.json())
  app.use(
    createChecksRouter(
      store,
      { enqueue: vi.fn(async () => undefined) } as unknown as WorkerRunner,
      cfg,
      paymentMiddleware,
    ),
  )
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('customer privacy boundary', () => {
  it('does not expose stored customer or payment identifiers in a completed report', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-customer-privacy-'))
    tempDirs.push(root)
    const jobId = 'customer-privacy-job'
    const jobDir = path.join(root, jobId)
    const reportPath = path.join(jobDir, 'report.json')
    await fs.mkdir(jobDir, { recursive: true })
    await fs.writeFile(
      reportPath,
      JSON.stringify({
        id: jobId,
        url: 'https://example.com',
        status: 'PASS',
        paymentMode: 'production',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        checksPerformed: [],
        limitations: [],
        contentHash: 'abc',
        viewports: {},
        summary: {
          totalViolations: 0,
          criticalViolations: 0,
          totalErrors: 0,
          overallLoadStatus: 'ok',
        },
        customerId: `cust_${'a'.repeat(64)}`,
        paymentId: 'private-payment-id',
      }),
    )

    const job: JobRecord = {
      id: jobId,
      url: 'https://example.com',
      status: 'complete',
      idempotencyKey: null,
      paymentId: 'private-payment-id',
      customerId: `cust_${'a'.repeat(64)}`,
      createdAt: Date.now(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      reportPath,
      error: null,
      retryCount: 0,
    }
    const store = { getJob: vi.fn(() => job) } as unknown as JobStore
    const baseUrl = await listen(store, config(root), (_req, _res, next) => next())

    const response = await fetch(`${baseUrl}/v1/checks/${jobId}`)
    const body = (await response.json()) as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(body).not.toHaveProperty('customerId')
    expect(body).not.toHaveProperty('paymentId')
    expect(body).not.toHaveProperty('paymentSignature')
  })

  it('delivers a paid job when optional customer attribution is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-customer-missing-'))
    tempDirs.push(root)
    const store = {
      getJobByIdempotencyKey: vi.fn(() => null),
      getJobByPaymentId: vi.fn(() => null),
      createJob: vi.fn(),
    } as unknown as JobStore
    const paymentMiddleware: RequestHandler = (req, _res, next) => {
      req.paymentResult = { settled: true, mode: 'production', paymentId: 'verified-payment' }
      next()
    }
    const baseUrl = await listen(store, config(root, 'production'), paymentMiddleware)

    const response = await fetch(`${baseUrl}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    const body = (await response.json()) as { error?: string }
    expect(response.status).toBe(202)
    expect(body.error).toBeUndefined()
    expect(store.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'verified-payment' }),
    )
  })

  it('creates a paid job when verified Solana attribution is present', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-customer-solana-'))
    tempDirs.push(root)
    const store = {
      getJobByIdempotencyKey: vi.fn(() => null),
      getJobByPaymentId: vi.fn(() => null),
      createJob: vi.fn(),
    } as unknown as JobStore
    const paymentMiddleware: RequestHandler = (req, _res, next) => {
      req.paymentResult = {
        settled: true,
        mode: 'production',
        paymentId: 'verified-solana-payment',
        customerId: `cust_${'c'.repeat(64)}`,
      }
      next()
    }
    const baseUrl = await listen(store, config(root, 'production'), paymentMiddleware)

    const response = await fetch(`${baseUrl}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })

    expect(response.status).toBe(202)
    expect(store.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'verified-solana-payment',
        customerId: `cust_${'c'.repeat(64)}`,
      }),
    )
  })
})
