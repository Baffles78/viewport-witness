import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { JobStore } from '../src/db.js'
import { createChecksRouter } from '../src/api/routes/checks.js'
import { createProductsRouter } from '../src/api/routes/products.js'
import type { Config } from '../src/config.js'
import type { WorkerRunner } from '../src/worker/runner.js'

vi.mock('../src/ssrf.js', () => ({
  validatePublicHttpsUrl: vi.fn(async () => ({ valid: true })),
}))

const servers: http.Server[] = []
const stores: JobStore[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve())),
  ))
  for (const store of stores.splice(0)) store.close()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function databasePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-admission-'))
  dirs.push(dir)
  return path.join(dir, 'jobs.db')
}

function openStore(dbPath: string) {
  const store = new JobStore(dbPath)
  store.init()
  stores.push(store)
  return store
}

describe('durable paid admission', () => {
  it('claims one key across two store instances and retains uncertainty after restart', async () => {
    const dbPath = await databasePath()
    const first = openStore(dbPath)
    const second = openStore(dbPath)
    expect(first.claimPaymentAdmission('same-key')).toBe(true)
    expect(second.claimPaymentAdmission('same-key')).toBe(false)
    first.close()
    stores.splice(stores.indexOf(first), 1)
    const restarted = openStore(dbPath)
    expect(restarted.claimPaymentAdmission('same-key')).toBe(false)
    restarted.releasePaymentAdmission('same-key')
    expect(second.claimPaymentAdmission('same-key')).toBe(true)
  })

  it('blocks cross-route settlement when the first client disconnects mid-payment', async () => {
    const store = openStore(await databasePath())
    const runner = { isHealthy: () => true } as WorkerRunner
    const cfg = { PAYMENT_MODE: 'production', RETENTION_DAYS: 7 } as Config
    let signalPaymentStarted: (() => void) | undefined
    const paymentStarted = new Promise<void>((resolve) => { signalPaymentStarted = resolve })
    const payment = vi.fn((_req: express.Request, _res: express.Response, _next: express.NextFunction) => {
      signalPaymentStarted?.()
      // Deliberately never finish this synthetic settlement.
    })
    const app = express()
    app.use(express.json())
    app.use(createChecksRouter(store, runner, cfg, payment))
    app.use(createProductsRouter(store, runner, cfg, payment, payment))
    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const controller = new AbortController()
    const first = fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'shared',
        'Payment-Signature': 'synthetic-first' },
      body: JSON.stringify({ url: 'https://example.com' }),
    }).catch(() => undefined)
    await paymentStarted
    controller.abort()
    await first
    const second = await fetch(`http://127.0.0.1:${port}/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'shared',
        'Payment-Signature': 'synthetic-second' },
      body: JSON.stringify({ url: 'https://example.com',
        assertions: [{ type: 'noConsoleErrors' }] }),
    })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({
      error: 'idempotency_outcome_unknown', nextAction: 'stop',
    })
    expect(payment).toHaveBeenCalledOnce()
  })
})
