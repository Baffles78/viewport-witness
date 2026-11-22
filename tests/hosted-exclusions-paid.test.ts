import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JobStore } from '../src/db.js'
import type { Config } from '../src/config.js'
import type { WorkerRunner } from '../src/worker/runner.js'
import { VIEWPORT_NAMES } from '../src/types.js'
import { makeConfig } from './helpers/mcp-server.js'

const facilitator = vi.hoisted(() => ({ verify: 0, settle: 0, failSettlement: false }))
vi.mock('../src/ssrf.js', () => ({ validatePublicHttpsUrl: async () => ({ valid: true }) }))
vi.mock('@coinbase/cdp-sdk/x402', () => ({
  createCdpFacilitatorClient: () => ({
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: {} } },
    async verify() { facilitator.verify++; return { isValid: true } },
    async settle() {
      facilitator.settle++
      if (facilitator.failSettlement) throw new Error('synthetic settlement disconnect')
      return { success: true, transaction: 'synthetic-tx', network: 'eip155:8453' }
    },
  }),
}))
const { createPaymentMiddleware } = await import('../src/payment/index.js')
const { createProductsRouter } = await import('../src/api/routes/products.js')
const { createMcpRouter } = await import('../src/mcp.js')

const baselineId = '11111111-1111-4111-8111-111111111111'
const regions = { desktop: [{ x: 0, y: 0, width: 10, height: 10 }] }
const body = { url: 'https://example.com', baselineJobId: baselineId, visualExclusions: regions }
let directory: string, dbPath: string, store: JobStore
const servers: http.Server[] = []
beforeEach(() => {
  facilitator.verify = 0; facilitator.settle = 0; facilitator.failSettlement = false
  directory = mkdtempSync(path.join(os.tmpdir(), 'vw-hosted-paid-'))
  dbPath = path.join(directory, 'qa.db')
  store = new JobStore(dbPath); store.init()
  store.createJob({ id: baselineId, url: body.url, idempotencyKey: null, expiresAt: Date.now() + 100000 })
  store.updateJobStatus(baselineId, 'complete', { reportPath: path.join(directory, 'baseline.json') })
  for (const viewport of VIEWPORT_NAMES) store.recordScreenshot(baselineId, viewport, path.join(directory, `${viewport}.png`), 'hash', 10)
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve())
  })))
  store.close(); rmSync(directory, { recursive: true, force: true })
})

async function serve(mode: 'test' | 'production' = 'production') {
  const cfg = makeConfig({ PAYMENT_MODE: mode, ENABLE_MAINNET_PAYMENTS: true,
    CDP_API_KEY_ID: 'synthetic', CDP_API_KEY_SECRET: 'synthetic',
    CUSTOMER_HASH_SECRET: '0123456789abcdef0123456789abcdef',
    EXTRACT_PRICE_USDC: '0.005', SECURITY_PRICE_USDC: '0.05',
  }) as Config
  const runner = { isHealthy: () => true, enqueue: vi.fn(async () => {}) } as unknown as WorkerRunner
  const payment = createPaymentMiddleware({ payTo: cfg.PAY_TO, priceUsdc: '0.12', mode,
    enableMainnet: true, cdpApiKeyId: 'synthetic', cdpApiKeySecret: 'synthetic',
    customerHashSecret: cfg.CUSTOMER_HASH_SECRET, route: 'POST /v1/compare',
    admission: { store, unresolvedLimit: 20, retentionDays: 7 },
  })
  const app = express(); app.use(express.json())
  app.use(createProductsRouter(store, runner, cfg, payment, payment))
  app.use(createMcpRouter(store, runner, cfg))
  const server = app.listen(0, '127.0.0.1'); servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

let nonce = 0
function sign(required: { accepts: Array<Record<string, unknown>>; resource?: unknown }) {
  const accepted = required.accepts[0]!
  return { x402Version: 2, resource: required.resource, accepted, payload: {
    authorization: { from: '0x1111111111111111111111111111111111111111', to: accepted['payTo'], value: accepted['amount'],
      validAfter: '0', validBefore: '9999999999', nonce: `0x${(++nonce).toString(16).padStart(64, '0')}` },
    signature: `0x${'a'.repeat(130)}`,
  } }
}
async function post(base: string, input: unknown, signature?: unknown, useKey = true) {
  const response = await fetch(`${base}/v1/compare`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(useKey ? { 'idempotency-key': 'hosted-buyer' } : {}),
      ...(signature ? { 'payment-signature': Buffer.from(JSON.stringify(signature)).toString('base64') } : {}) },
    body: JSON.stringify(input),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown>,
    challenge: response.headers.get('payment-required') }
}
async function call(base: string, input: unknown, signature?: unknown) {
  const response = await fetch(`${base}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'compare_page', arguments: input,
      ...(signature ? { _meta: { 'x402/payment': signature } } : {}) } }),
  })
  const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: unknown }; error?: unknown }
  let value: Record<string, unknown> = {}
  try { value = JSON.parse(payload.result?.content?.[0]?.text ?? '{}') } catch { /* payment challenge can be text */ }
  return { payload, value }
}
async function httpPayment(base: string) {
  const unsigned = await post(base, body)
  expect(unsigned.status).toBe(402)
  return sign(JSON.parse(Buffer.from(unsigned.challenge!, 'base64').toString('utf8')))
}
async function mcpPayment(base: string) {
  const unsigned = await call(base, body)
  const required = unsigned.payload.result?.structuredContent ?? unsigned.value
  return sign(required as Parameters<typeof sign>[0])
}

describe('hosted exclusions preserve payment admission and replay intent', () => {
  it.each(['http', 'mcp'] as const)('%s preserves old omitted requests when replayed with empty regions', async (channel) => {
    const base = await serve()
    const payment = channel === 'http' ? await httpPayment(base) : await mcpPayment(base)
    const legacy = { url: body.url, baselineJobId: baselineId }
    if (channel === 'http') {
      const accepted = await post(base, legacy, payment)
      expect(accepted.status).toBe(202)
      for (const visualExclusions of [{}, { desktop: [], phonePortrait: [] }]) {
        expect((await post(base, { ...legacy, visualExclusions }, payment)).body['id']).toBe(accepted.body['id'])
      }
    } else {
      const accepted = await call(base, legacy, payment)
      expect(accepted.payload.result?.isError).not.toBe(true)
      for (const visualExclusions of [{}, { desktop: [], phonePortrait: [] }]) {
        const replay = await call(base, { ...legacy, visualExclusions }, payment)
        expect(replay.payload.result?.isError).not.toBe(true)
        expect(replay.value['id']).toBe(accepted.value['id'])
      }
    }
    expect(facilitator.settle).toBe(1)
  })
  it('persists HTTP paid options, survives database reopen, and rejects changed intent without paying again', async () => {
    const base = await serve(), payment = await httpPayment(base)
    const accepted = await post(base, body, payment)
    expect(accepted.status).toBe(202)
    const id = accepted.body['id'] as string
    expect(store.getJob(id)?.request.visualExclusions).toEqual(regions)
    expect(store.getJob(id)?.settlementState).toBe('settled')
    const reopened = new JobStore(dbPath)
    try { reopened.init(); expect(reopened.getJob(id)?.request.visualExclusions).toEqual(regions) }
    finally { reopened.close() }
    expect((await post(base, body, payment)).body['id']).toBe(id)
    expect((await post(base, { ...body, visualExclusions: { desktop: [regions.desktop[0], regions.desktop[0]] } }, payment)).body['id']).toBe(id)
    const changed = await post(base, { ...body, visualExclusions: {} }, payment)
    expect(changed.status).toBe(409)
    expect((await post(base, { ...body, visualExclusions: {} }, payment, false)).status).toBe(409)
    expect(facilitator.settle).toBe(1)
  })

  it('retains exclusions and identity when settlement becomes unknown', async () => {
    const base = await serve(), payment = await httpPayment(base)
    facilitator.failSettlement = true
    const accepted = await post(base, body, payment)
    expect(accepted.status).toBe(202)
    expect(store.getJob(accepted.body['id'] as string)).toMatchObject({ settlementState: 'unknown', request: { visualExclusions: regions } })
    expect((await post(base, { ...body, visualExclusions: {} }, payment)).status).toBe(409)
    expect(facilitator.settle).toBe(1)
  })

  it.each(['http', 'mcp'] as const)('%s rejects invalid exclusions before verification or settlement', async (channel) => {
    const base = await serve()
    const payment = channel === 'http' ? await httpPayment(base) : await mcpPayment(base)
    for (const visualExclusions of [
      { tablet: [] }, { desktop: [{ x: 0, y: 0, width: 1440, height: 181 }] },
      { desktop: [{ x: 0.5, y: 0, width: 10, height: 10 }] },
      { desktop: [{ x: 1440, y: 0, width: 10, height: 10 }] },
      { desktop: [{ x: 0, y: 0, width: 10, height: 10, selector: 'body' }] },
    ]) {
      if (channel === 'http') expect((await post(base, { ...body, visualExclusions }, payment)).status).toBe(422)
      else {
        const result = await call(base, { ...body, visualExclusions }, payment)
        expect(result.payload.result?.isError || result.payload.error).toBeTruthy()
        expect(result.value).not.toHaveProperty('id')
      }
    }
    expect(facilitator.verify).toBe(0); expect(facilitator.settle).toBe(0)
  })

  it('persists MCP paid options and refuses changed payment intent', async () => {
    const base = await serve(), payment = await mcpPayment(base)
    const accepted = await call(base, body, payment)
    expect(accepted.payload.result?.isError).not.toBe(true)
    const id = accepted.value['id'] as string
    expect(store.getJob(id)?.request.visualExclusions).toEqual(regions)
    expect((await call(base, body, payment)).value['id']).toBe(id)
    expect((await call(base, { ...body, visualExclusions: {} }, payment)).payload.result?.isError).toBe(true)
    expect(facilitator.settle).toBe(1)
  })

  it('keeps MCP exclusions bound when settlement becomes unknown', async () => {
    const base = await serve(), payment = await mcpPayment(base)
    facilitator.failSettlement = true
    const accepted = await call(base, body, payment)
    expect(store.getJob(accepted.value['id'] as string)).toMatchObject({ settlementState: 'unknown', request: { visualExclusions: regions } })
    expect((await call(base, body, payment)).value['id']).toBe(accepted.value['id'])
    expect((await call(base, { ...body, visualExclusions: {} }, payment)).payload.result?.isError).toBe(true)
    expect(facilitator.settle).toBe(1)
  })

  it.each(['http', 'mcp'] as const)('%s test mode persists the same options without settlement', async (channel) => {
    const base = await serve('test')
    const id = channel === 'http' ? (await post(base, body)).body['id'] : (await call(base, body)).value['id']
    expect(store.getJob(id as string)?.request.visualExclusions).toEqual(regions)
    expect(facilitator.settle).toBe(0)
  })
})
