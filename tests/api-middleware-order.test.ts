import { afterEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import http from 'http'
import { createChecksRouter } from '../src/api/routes/checks.js'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import type { WorkerRunner } from '../src/worker/runner.js'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

describe('POST /v1/checks middleware order', () => {
  it('rejects an unsafe URL before invoking payment middleware', async () => {
    const paymentMiddleware = vi.fn((_req: Request, _res: Response, next: NextFunction): void =>
      next(),
    )
    const cfg: Config = {
      NODE_ENV: 'test',
      PORT: 3000,
      DATA_DIR: './data',
      SCREENSHOTS_DIR: './data/screenshots',
      DB_PATH: './data/vw.db',
      PAYMENT_MODE: 'test',
      ENABLE_MAINNET_PAYMENTS: false,
      FACILITATOR_URL: undefined,
      CDP_API_KEY_ID: undefined,
      CDP_API_KEY_SECRET: undefined,
      CUSTOMER_HASH_SECRET: undefined,
      PAY_TO: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
      PRICE_USDC: '0.08',
      RETENTION_DAYS: 7,
      MAX_STORAGE_GB: 10,
      WORKER_TIMEOUT_MS: 120_000,
      LOG_LEVEL: 'info',
    }
    const app = express()
    app.use(express.json())
    app.use(createChecksRouter({} as JobStore, {} as WorkerRunner, cfg, paymentMiddleware))
    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server address unavailable')

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/private' }),
    })

    expect(response.status).toBe(400)
    expect(paymentMiddleware).not.toHaveBeenCalled()
  })
})
