import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { createChecksRouter } from '../src/api/routes/checks.js'
import { createProductsRouter, createProductJob, JobReplayConflictError } from '../src/api/routes/products.js'
import { createWebProductsRouter } from '../src/api/routes/web-products.js'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import type { JobKind, JobRecord } from '../src/types.js'
import type { WorkerRunner } from '../src/worker/runner.js'

vi.mock('../src/ssrf.js', () => ({
  validatePublicHttpsUrl: vi.fn(async () => ({ valid: true })),
}))

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) =>
    new Promise<void>((resolve) => s.close(() => resolve())),
  ))
})

const id = '11111111-1111-4111-8111-111111111111'
const baselineId = '22222222-2222-4222-8222-222222222222'
const originalHeader = 'already-settled-synthetic-payment'

function paymentHeader(nonce: string): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:8453' },
    payload: { nonce },
  })).toString('base64')
}

function job(kind: JobKind): JobRecord {
  return {
    id,
    kind,
    url: 'https://example.com',
    status: 'queued',
    idempotencyKey: 'same-key',
    paymentId: createHash('sha256').update(paymentHeader(originalHeader)).digest('hex'),
    customerId: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    expiresAt: Date.now() + 60_000,
    reportPath: null,
    error: null,
    retryCount: 0,
    request: kind === 'verify'
      ? { assertions: [{ type: 'noConsoleErrors' }] }
      : kind === 'extract' ? { maxOutputTokens: 500 } : {},
    baselineJobId: kind === 'compare' ? baselineId : null,
  }
}

async function serve(kind: JobKind) {
  const existing = job(kind)
  const lookup = vi.fn(() => existing)
  const payment = vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next())
  const store = {
    getJobByIdempotencyKey: lookup,
    getJob: () => ({ id: baselineId, status: 'complete',
      reportPath: '/synthetic/report.json', expiresAt: Date.now() + 60_000 }),
    getScreenshot: () => ({ path: '/synthetic/image.png', sha256: 'abc', bytes: 1 }),
  } as unknown as JobStore
  const runner = { isHealthy: () => true } as WorkerRunner
  const cfg = { PAYMENT_MODE: 'production', RETENTION_DAYS: 7 } as Config
  const app = express()
  app.use(express.json())
  app.use(createChecksRouter(store, runner, cfg, payment))
  app.use(createProductsRouter(store, runner, cfg, payment, payment))
  app.use(createWebProductsRouter(store, runner, cfg, payment, payment))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, payment, lookup }
}

const cases = [
  { kind: 'check', route: '/v1/checks', body: { url: 'https://example.com' } },
  { kind: 'verify', route: '/v1/verify', body: {
    url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }],
  } },
  { kind: 'compare', route: '/v1/compare', body: {
    url: 'https://example.com', baselineJobId: baselineId,
  } },
  { kind: 'extract', route: '/v1/extract', body: {
    url: 'https://example.com', maxOutputTokens: 500,
  } },
  { kind: 'security', route: '/v1/security-gate', body: { url: 'https://example.com' } },
] as const

async function post(port: number, route: string, body: unknown, header: string) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-key',
      'Payment-Signature': paymentHeader(header) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

describe('paid idempotency replay boundary', () => {
  for (const { kind, route, body } of cases) {
    it(`${kind} rejects a different payment header before settlement or job disclosure`, async () => {
      const { port, payment, lookup } = await serve(kind)
      const result = await post(port, route, body, 'unsettled-or-other-payment')
      expect(result.status).toBe(409)
      expect(result.body).toMatchObject({ error: 'idempotency_key_conflict' })
      expect(result.body).not.toHaveProperty('id')
      expect(lookup).toHaveBeenCalled()
      expect(payment).not.toHaveBeenCalled()
    })

    it(`${kind} reuses the original settled payload only for the same intent`, async () => {
      const { port, payment } = await serve(kind)
      const result = await post(port, route, body, originalHeader)
      expect(result.status).toBe(202)
      expect(result.body).toMatchObject({ id, idempotent: true })
      expect(payment).not.toHaveBeenCalled()
    })
  }

  it('rejects a conflicting paid product replay discovered after preflight', async () => {
    const existing = job('verify')
    const store = {
      getJobByIdempotencyKey: () => existing,
      getJobByPaymentId: () => null,
    } as unknown as JobStore
    await expect(createProductJob({
      store,
      runner: { enqueue: vi.fn(), isHealthy: () => true },
      cfg: { PAYMENT_MODE: 'production', RETENTION_DAYS: 7 } as Config,
      kind: 'verify',
      url: existing.url,
      assertions: [{ type: 'noConsoleErrors' }],
      idempotencyKey: 'same-key',
      paymentId: 'another-settled-payment',
    })).rejects.toBeInstanceOf(JobReplayConflictError)
  })

  for (const changed of [
    { kind: 'verify' as const, route: '/v1/verify', body: {
      url: 'https://example.com', assertions: [{ type: 'textVisible', value: 'changed' }],
    } },
    { kind: 'compare' as const, route: '/v1/compare', body: {
      url: 'https://example.com', baselineJobId: '33333333-3333-4333-8333-333333333333',
    } },
    { kind: 'extract' as const, route: '/v1/extract', body: {
      url: 'https://example.com', maxOutputTokens: 600,
    } },
  ]) {
    it(`rejects changed ${changed.kind} work with the original payment payload`, async () => {
      const { port, payment } = await serve(changed.kind)
      const result = await post(port, changed.route, changed.body, originalHeader)
      expect(result.status).toBe(409)
      expect(result.body).not.toHaveProperty('id')
      expect(payment).not.toHaveBeenCalled()
    })
  }

  it('accepts a valid verify replay through a case and trailing-slash route variant', async () => {
    const { port, payment } = await serve('verify')
    const result = await post(port, '/v1/VERIFY/', {
      url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }],
    }, originalHeader)
    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ id, idempotent: true })
    expect(payment).not.toHaveBeenCalled()
  })

  it('rejects a cross-product key replay with the original payment payload', async () => {
    const { port, payment } = await serve('check')
    const result = await post(port, '/v1/verify', {
      url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }],
    }, originalHeader)
    expect(result.status).toBe(409)
    expect(result.body).not.toHaveProperty('id')
    expect(payment).not.toHaveBeenCalled()
  })

  it('returns a disclosed-ID-free conflict if another payment wins after preflight', async () => {
    const existing = job('verify')
    let lookups = 0
    const store = {
      getJobByIdempotencyKey: () => ++lookups === 1 ? null : existing,
      getJobByPaymentId: () => null,
      claimPaymentAdmission: () => true,
      releasePaymentAdmission: () => undefined,
    } as unknown as JobStore
    const payment = vi.fn((req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.paymentResult = { settled: true, mode: 'production', paymentId: 'different-payment' }
      next()
    })
    const app = express()
    app.use(express.json())
    app.use(createProductsRouter(store, { isHealthy: () => true } as WorkerRunner,
      { PAYMENT_MODE: 'production', RETENTION_DAYS: 7 } as Config, payment, payment))
    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const result = await post(port, '/v1/verify', {
      url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }],
    }, 'different-payment-header')
    expect(payment).toHaveBeenCalledOnce()
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: 'job_replay_conflict' })
    expect(result.body).not.toHaveProperty('id')
  })

  it('rejects changed work even with the original payment payload', async () => {
    const { port, payment } = await serve('check')
    const result = await post(port, '/v1/checks', { url: 'https://another.example.com' }, originalHeader)
    expect(result.status).toBe(409)
    expect(result.body).not.toHaveProperty('id')
    expect(payment).not.toHaveBeenCalled()
  })
})
