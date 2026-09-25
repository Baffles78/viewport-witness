import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import { createProductsRouter } from '../src/api/routes/products.js'
import type { WorkerRunner } from '../src/worker/runner.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('compare discovery challenge ordering', () => {
  it('returns an unsigned production 402 before baseline validation', async () => {
    const baselineLookup = vi.fn(() => {
      throw new Error('baseline validation must not run before the unsigned challenge')
    })
    const comparePayment = vi.fn((_req, res) => {
      res.setHeader('PAYMENT-REQUIRED', 'challenge')
      res.status(402).json({ error: 'payment_required' })
    })
    const app = express()
    app.use(express.json())
    app.use(
      createProductsRouter(
        { getJob: baselineLookup } as unknown as JobStore,
        {} as WorkerRunner,
        {
          PAYMENT_MODE: 'production',
          RETENTION_DAYS: 7,
        } as Config,
        (_req, _res, next) => next(),
        comparePayment,
      ),
    )
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port

    const response = await fetch(`http://127.0.0.1:${port}/v1/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        baselineJobId: '00000000-0000-0000-0000-000000000000',
      }),
    })

    expect(response.status).toBe(402)
    expect(response.headers.get('payment-required')).toBe('challenge')
    expect(comparePayment).toHaveBeenCalledOnce()
    expect(baselineLookup).not.toHaveBeenCalled()
  })
})
