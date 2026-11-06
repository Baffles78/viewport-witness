import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createChecksRouter } from '../src/api/routes/checks.js'
import { createProductsRouter } from '../src/api/routes/products.js'
import { createWebProductsRouter } from '../src/api/routes/web-products.js'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import type { WorkerRunner } from '../src/worker/runner.js'
import type { JobStatus } from '../src/types.js'

const servers: http.Server[] = []
const dirs: string[] = []
const id = '11111111-1111-4111-8111-111111111111'

async function getJobStatus(status: JobStatus | null, missingReport = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-reconcile-'))
  dirs.push(dir)
  let reportPath: string | null = null
  if (status === 'complete' && !missingReport) {
    const reportDir = path.join(dir, id)
    await fs.mkdir(reportDir)
    reportPath = path.join(reportDir, 'report.json')
    await fs.writeFile(reportPath, JSON.stringify({ id, kind: 'extract', status: 'PASS' }))
  }
  const store = {
    getJob: () => status ? {
      id,
      status,
      createdAt: Date.now(),
      reportPath,
    } : null,
  } as unknown as JobStore
  const runner = {} as WorkerRunner
  const cfg = { PAYMENT_MODE: 'test', SCREENSHOTS_DIR: dir, RETENTION_DAYS: 7 } as Config
  const app = express()
  app.use(createChecksRouter(store, runner, cfg, (_req, _res, next) => next()))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const response = await fetch(`http://127.0.0.1:${port}/v1/checks/${id}`)
  return { code: response.status, body: await response.json() as Record<string, unknown> }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve())),
  ))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('HTTP same-job reconciliation', () => {
  for (const status of ['payment_pending', 'queued', 'running', 'retryable'] as JobStatus[]) {
    it(`${status} keeps the original poll URL`, async () => {
      const response = await getJobStatus(status)
      expect(response.code).toBe(200)
      expect(response.body).toMatchObject({
        id,
        status,
        jobStatus: status,
        nextAction: 'poll_same_job',
        pollUrl: `/v1/checks/${id}`,
        retryAfterSeconds: 5,
      })
    })
  }

  it('completed report asks for inspection without another job', async () => {
    const response = await getJobStatus('complete')
    expect(response.code).toBe(200)
    expect(response.body).toMatchObject({
      id,
      status: 'PASS',
      jobStatus: 'complete',
      nextAction: 'inspect_report',
    })
  })

  it('completed job without a report stops', async () => {
    const response = await getJobStatus('complete', true)
    expect(response.code).toBe(500)
    expect(response.body).toMatchObject({ error: 'report_unavailable', nextAction: 'stop' })
  })

  it('permanent failure stops', async () => {
    const response = await getJobStatus('failed')
    expect(response.body).toMatchObject({
      id,
      status: 'failed',
      jobStatus: 'failed',
      nextAction: 'stop',
    })
  })

  it('missing or expired job ID stops without a repayment signal', async () => {
    const response = await getJobStatus(null)
    expect(response.code).toBe(404)
    expect(response.body).toMatchObject({ error: 'not_found', nextAction: 'stop' })
  })
})

describe('production unsigned creation recovery', () => {
  it('returns the payment challenge before idempotency lookup', async () => {
    const lookup = vi.fn()
    const store = { getJobByIdempotencyKey: lookup } as unknown as JobStore
    const cfg = { PAYMENT_MODE: 'production' } as Config
    const paymentChallenge = (_req: express.Request, res: express.Response) => {
      res.status(402).json({ error: 'payment_required' })
    }
    const app = express()
    app.use(express.json())
    app.use(createChecksRouter(store, { isHealthy: () => true } as WorkerRunner, cfg, paymentChallenge))
    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const response = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'uncertain-payment' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(response.status).toBe(402)
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('quarantined worker admission', () => {
  it('blocks every worker-backed POST before payment and keeps retrieval available', async () => {
    const payment = vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next())
    const worker = { isHealthy: () => false } as WorkerRunner
    const store = { getJob: () => null } as unknown as JobStore
    const cfg = { PAYMENT_MODE: 'production', RETENTION_DAYS: 7 } as Config
    const app = express()
    app.use(express.json())
    app.use(createChecksRouter(store, worker, cfg, payment))
    app.use(createProductsRouter(store, worker, cfg, payment, payment))
    app.use(createWebProductsRouter(store, worker, cfg, payment, payment))
    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    for (const route of ['/v1/checks', '/v1/verify', '/v1/compare', '/v1/extract', '/v1/security-gate']) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'synthetic' },
        body: JSON.stringify({ url: 'https://example.com' }),
      })
      expect(response.status, route).toBe(503)
      expect(await response.json()).toMatchObject({ error: 'worker_unavailable' })
    }
    expect(payment).not.toHaveBeenCalled()
    const retrieval = await fetch(`http://127.0.0.1:${port}/v1/checks/${id}`)
    expect(retrieval.status).toBe(404)
  })
})
