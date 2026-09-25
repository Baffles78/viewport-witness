import { afterEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import http from 'http'
import type { AddressInfo } from 'net'
import { createChecksRouter } from '../src/api/routes/checks.js'
import { createProductsRouter } from '../src/api/routes/products.js'
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

const TEST_CFG: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATA_DIR: './data',
  SCREENSHOTS_DIR: './data/screenshots',
  DB_PATH: './data/vw.db',
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
  MAX_STORAGE_GB: 10,
  WORKER_TIMEOUT_MS: 120_000,
  LOG_LEVEL: 'info',
}

const PAID_CFG: Config = { ...TEST_CFG, PAYMENT_MODE: 'testnet' }

async function startServer(app: express.Express): Promise<{ port: number }> {
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  return { port: addr.port }
}

describe('POST /v1/checks middleware order', () => {
  it('rejects an unsafe URL before invoking payment middleware (test mode)', async () => {
    const paymentMiddleware = vi.fn((_req: Request, _res: Response, next: NextFunction): void =>
      next(),
    )
    const app = express()
    app.use(express.json())
    app.use(createChecksRouter({} as JobStore, {} as WorkerRunner, TEST_CFG, paymentMiddleware))
    const { port } = await startServer(app)

    const response = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/private' }),
    })

    expect(response.status).toBe(400)
    expect(paymentMiddleware).not.toHaveBeenCalled()
  })

  it('challenges unsigned paid-mode requests before body validation', async () => {
    const paymentMiddleware = vi.fn((_req: Request, res: Response): void => {
      res.status(402).json({ error: 'payment_required' })
    })
    const app = express()
    app.use(express.json())
    app.use(createChecksRouter({} as JobStore, {} as WorkerRunner, PAID_CFG, paymentMiddleware))
    const { port } = await startServer(app)

    const response = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ not_a_url: 'garbage' }),
    })

    expect(response.status).toBe(402)
    expect(paymentMiddleware).toHaveBeenCalledOnce()
  })

  it('validates signed paid-mode requests before invoking payment middleware', async () => {
    const paymentMiddleware = vi.fn((_req: Request, _res: Response, next: NextFunction): void =>
      next(),
    )
    const app = express()
    app.use(express.json())
    app.use(createChecksRouter({} as JobStore, {} as WorkerRunner, PAID_CFG, paymentMiddleware))
    const { port } = await startServer(app)

    const response = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'payment-signature': 'fakesig' },
      body: JSON.stringify({ not_a_url: 'garbage' }),
    })

    expect(response.status).toBe(422)
    expect(paymentMiddleware).not.toHaveBeenCalled()
  })
})

describe('POST /v1/verify middleware order', () => {
  function makeVerifyApp(cfg: Config, verifyPayment: ReturnType<typeof vi.fn>): express.Express {
    const app = express()
    app.use(express.json())
    app.use(
      createProductsRouter(
        {} as JobStore,
        {} as WorkerRunner,
        cfg,
        verifyPayment,
        (_req, _res, next) => next(),
      ),
    )
    return app
  }

  it('challenges unsigned paid-mode requests before body validation', async () => {
    const verifyPayment = vi.fn((_req: Request, res: Response): void => {
      res.status(402).json({ error: 'payment_required' })
    })
    const { port } = await startServer(makeVerifyApp(PAID_CFG, verifyPayment))

    const response = await fetch(`http://127.0.0.1:${port}/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }), // missing assertions
    })

    expect(response.status).toBe(402)
    expect(verifyPayment).toHaveBeenCalledOnce()
  })

  it('validates signed paid-mode requests before invoking payment middleware', async () => {
    const verifyPayment = vi.fn((_req: Request, _res: Response, next: NextFunction): void =>
      next(),
    )
    const { port } = await startServer(makeVerifyApp(PAID_CFG, verifyPayment))

    const response = await fetch(`http://127.0.0.1:${port}/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment': 'fakepayload' },
      body: JSON.stringify({ url: 'https://example.com' }), // missing assertions
    })

    expect(response.status).toBe(422)
    expect(verifyPayment).not.toHaveBeenCalled()
  })
})

describe('POST /v1/compare middleware order', () => {
  function makeCompareApp(cfg: Config, comparePayment: ReturnType<typeof vi.fn>): express.Express {
    const app = express()
    app.use(express.json())
    app.use(
      createProductsRouter(
        { getJob: () => null } as unknown as JobStore,
        {} as WorkerRunner,
        cfg,
        (_req, _res, next) => next(),
        comparePayment,
      ),
    )
    return app
  }

  it('challenges unsigned paid-mode requests before body validation', async () => {
    const comparePayment = vi.fn((_req: Request, res: Response): void => {
      res.status(402).json({ error: 'payment_required' })
    })
    const { port } = await startServer(makeCompareApp(PAID_CFG, comparePayment))

    const response = await fetch(`http://127.0.0.1:${port}/v1/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }), // missing baselineJobId
    })

    expect(response.status).toBe(402)
    expect(comparePayment).toHaveBeenCalledOnce()
  })

  it('validates signed paid-mode requests before invoking payment middleware', async () => {
    const comparePayment = vi.fn((_req: Request, _res: Response, next: NextFunction): void =>
      next(),
    )
    const { port } = await startServer(makeCompareApp(PAID_CFG, comparePayment))

    const response = await fetch(`http://127.0.0.1:${port}/v1/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'payment-signature': 'fakesig' },
      body: JSON.stringify({ url: 'https://example.com' }), // missing baselineJobId
    })

    expect(response.status).toBe(422)
    expect(comparePayment).not.toHaveBeenCalled()
  })
})
