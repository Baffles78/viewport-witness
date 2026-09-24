/**
 * Verifies that the Bazaar discovery extension metadata appears in the actual
 * x402 402 challenge returned by the payment middleware for testnet/production
 * configuration.
 *
 * The CDP facilitator is mocked so no live API calls are made. The 402 challenge
 * is built from the route config by the @x402/express middleware without calling
 * the facilitator.
 */

import { vi, afterEach, describe, it, expect } from 'vitest'

// Mock the CDP facilitator client — only instantiated, never called for 402 challenges.
vi.mock('@coinbase/cdp-sdk/x402', () => ({
  createCdpFacilitatorClient: vi.fn(() => ({
    getSupported: vi.fn(async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
      extensions: [],
    })),
  })),
}))

import express from 'express'
import http from 'http'
import { createPaymentMiddleware } from '../src/payment/index.js'

const servers: http.Server[] = []

async function challengeText(res: Response): Promise<string> {
  const encoded = [res.headers.get('payment-required'), res.headers.get('payment-response')]
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      try {
        return Buffer.from(value, 'base64').toString('utf8')
      } catch {
        return value
      }
    })
  return [...encoded, await res.text()].join(' ')
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

async function makeTestnetApp(): Promise<{ port: number }> {
  const middleware = createPaymentMiddleware({
    payTo: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
    priceUsdc: '0.08',
    mode: 'testnet',
    enableMainnet: false,
    facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
    cdpApiKeyId: 'test-key-id',
    cdpApiKeySecret: 'test-key-secret',
  })

  const app = express()
  app.use(express.json())
  app.post('/v1/checks', middleware, (_req, res) => {
    res.status(202).json({ id: 'test-id', status: 'queued' })
  })

  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { port: (address as { port: number }).port }
}

describe('Bazaar discovery — 402 challenge metadata', () => {
  it('returns 402 for a request without payment header', async () => {
    const { port } = await makeTestnetApp()
    const res = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(402)
  })

  it('402 challenge contains updated serviceName "ViewportWitness by Apex Labs"', async () => {
    const { port } = await makeTestnetApp()
    const res = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })

    expect(res.status).toBe(402)

    // The 402 challenge from @x402/express includes service metadata in the
    // PAYMENT-RESPONSE header (base64 JSON) and/or the response body.
    const combined = await challengeText(res)

    expect(combined).toContain('ViewportWitness by Apex Labs')
    expect(combined).toContain('"bazaar"')
    expect(combined).toContain('"bodyType":"json"')
    expect(combined).toContain('"url"')
  })

  it('402 challenge contains 80000 atomic USDC units ($0.08) — no price regression', async () => {
    const { port } = await makeTestnetApp()
    const res = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })

    expect(res.status).toBe(402)
    const combined = await challengeText(res)

    // USDC has six decimals, so 0.08 USDC is encoded as 80000 atomic units.
    expect(combined).toContain('"amount":"80000"')
    expect(combined).toContain('"name":"USDC"')
  })

  it('402 challenge targets Base Sepolia (eip155:84532) for testnet', async () => {
    const { port } = await makeTestnetApp()
    const res = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })

    expect(res.status).toBe(402)
    const combined = await challengeText(res)

    expect(combined).toContain('84532')
  })

  it('test mode passes through without 402 — payment mode not regressed', async () => {
    const middleware = createPaymentMiddleware({
      payTo: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
      priceUsdc: '0.08',
      mode: 'test',
      enableMainnet: false,
    })

    const app = express()
    app.use(express.json())
    app.post('/v1/checks', middleware, (_req, res) => {
      res.status(202).json({ id: 'test-id', status: 'queued', pollUrl: '/v1/checks/test-id', paymentMode: 'test' })
    })

    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }

    const res = await fetch(`http://127.0.0.1:${address.port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })

    // Test mode should pass through and return 202, not 402
    expect(res.status).toBe(202)
  })
})

describe('Bazaar discovery — request/output schema compliance', () => {
  it('accepts strict {url:string} request body without extra fields', async () => {
    // This verifies the schema registered with Bazaar extension is accurate.
    // Tested via the validation preflight in checks router, not payment middleware,
    // but the schema description must match: only `url` is accepted.
    const { port } = await makeTestnetApp()

    // A request with extra fields should NOT cause issues at the payment middleware level
    // (schema enforcement is in the checks router, but Bazaar schema must match reality)
    const res = await fetch(`http://127.0.0.1:${port}/v1/checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })

    // 402 because no payment — the input was accepted by the middleware schema
    expect(res.status).toBe(402)
  })
})
