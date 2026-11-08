/**
 * Integrated paid-admission and recovery tests.
 *
 * These use the real pinned x402 packages (@x402/express, @x402/core,
 * @x402/evm, @x402/svm, @x402/mcp), the real Express routes and a real SQLite
 * JobStore. Only the Coinbase facilitator network client is replaced by a
 * scripted facilitator, so verify/settle outcomes can be forced offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { JobStore } from '../src/db.js'
import type { Config } from '../src/config.js'
import type { WorkerRunner } from '../src/worker/runner.js'

type Verify = { isValid: boolean; invalidReason?: string }
type Settle = { success: boolean; transaction: string; network: string; errorReason?: string }

const fac = vi.hoisted(() => ({
  verify: async (): Promise<Verify> => ({ isValid: true }),
  settle: async (_p: unknown, r: { network: string }): Promise<Settle> => ({
    success: true, transaction: '0xsettled', network: r.network,
  }),
  verifyCalls: 0,
  settleCalls: 0,
}))

vi.mock('../src/ssrf.js', () => ({
  validatePublicHttpsUrl: vi.fn(async () => ({ valid: true })),
}))

vi.mock('@coinbase/cdp-sdk/x402', () => ({
  createCdpFacilitatorClient: () => ({
    async getSupported() {
      return {
        kinds: [
          { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
          {
            x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' },
          },
        ],
        extensions: [],
        signers: {},
      }
    },
    async verify(p: unknown, r: unknown) {
      fac.verifyCalls++
      return fac.verify(p as never, r as never)
    },
    async settle(p: unknown, r: { network: string }) {
      fac.settleCalls++
      return fac.settle(p, r)
    },
  }),
}))

const { createPaymentMiddleware } = await import('../src/payment/index.js')
const { createChecksRouter } = await import('../src/api/routes/checks.js')
const { createProductsRouter } = await import('../src/api/routes/products.js')
const { createWebProductsRouter } = await import('../src/api/routes/web-products.js')
const { createMcpRouter } = await import('../src/mcp.js')

const PAY_TO = '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400'
const SOLANA_PAY_TO = 'EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk'

let dir: string
let dbPath: string
let store: JobStore
const servers: http.Server[] = []

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vw-admission-'))
  dbPath = path.join(dir, 'vw.db')
  store = new JobStore(dbPath)
  store.init()
  fac.verify = async () => ({ isValid: true })
  fac.settle = async (_p, r) => ({ success: true, transaction: '0xsettled', network: r.network })
  fac.verifyCalls = 0
  fac.settleCalls = 0
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections()
    s.close(() => resolve())
  })))
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeCfg(limit = 20): Config {
  return {
    PAYMENT_MODE: 'production',
    ENABLE_MAINNET_PAYMENTS: true,
    ENABLE_SOLANA_PAYMENTS: true,
    CDP_API_KEY_ID: 'synthetic-id',
    CDP_API_KEY_SECRET: 'synthetic-secret',
    CUSTOMER_HASH_SECRET: '0123456789abcdef0123456789abcdef',
    PAY_TO,
    SOLANA_TEST_PAY_TO: 'AwnqYWr32DUJvk4XKxfUSpVVYcoUuMFNp8XoBShm5qSS',
    SOLANA_REVENUE_PAY_TO: SOLANA_PAY_TO,
    PRICE_USDC: '0.08',
    VERIFY_PRICE_USDC: '0.10',
    COMPARE_PRICE_USDC: '0.12',
    EXTRACT_PRICE_USDC: '0.005',
    SECURITY_PRICE_USDC: '0.05',
    RETENTION_DAYS: 7,
    PAYMENT_UNRESOLVED_LIMIT: limit,
  } as Config
}

function makeRunner() {
  const enqueued: string[] = []
  let healthy = true
  let failEnqueue = false
  const runner = {
    isHealthy: () => healthy,
    enqueue: vi.fn(async (id: string) => {
      if (failEnqueue) throw new Error('Worker is shutting down')
      enqueued.push(id)
    }),
  } as unknown as WorkerRunner
  return {
    runner,
    enqueued,
    setHealthy: (v: boolean) => { healthy = v },
    setFailEnqueue: (v: boolean) => { failEnqueue = v },
  }
}

async function serve(cfg: Config, runner: WorkerRunner) {
  const admission = {
    store,
    unresolvedLimit: cfg.PAYMENT_UNRESOLVED_LIMIT ?? 20,
    ...(cfg.PAYMENT_UNRESOLVED_PER_PAYER ? { payerUnresolvedLimit: cfg.PAYMENT_UNRESOLVED_PER_PAYER } : {}),
    retentionDays: 7,
  }
  const pm = (route: 'POST /v1/checks' | 'POST /v1/verify' | 'POST /v1/compare' | 'POST /v1/extract' | 'POST /v1/security-gate', price: string) =>
    createPaymentMiddleware({
      payTo: PAY_TO,
      solanaPayTo: SOLANA_PAY_TO,
      enableSolana: true,
      priceUsdc: price,
      mode: 'production',
      enableMainnet: true,
      cdpApiKeyId: 'synthetic-id',
      cdpApiKeySecret: 'synthetic-secret',
      customerHashSecret: cfg.CUSTOMER_HASH_SECRET,
      route,
      admission,
    })
  const app = express()
  app.set('trust proxy', false)
  app.use(express.json())
  app.use(createMcpRouter(store, runner, cfg))
  app.use(createProductsRouter(store, runner, cfg, pm('POST /v1/verify', '0.10'), pm('POST /v1/compare', '0.12')))
  app.use(createWebProductsRouter(store, runner, cfg, pm('POST /v1/extract', '0.005'), pm('POST /v1/security-gate', '0.05')))
  app.use(createChecksRouter(store, runner, cfg, pm('POST /v1/checks', '0.08')))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

interface Accept { scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number; extra?: Record<string, unknown> }

async function challenge(base: string, route = '/v1/checks', body: unknown = { url: 'https://example.com' }) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  expect(res.status).toBe(402)
  const header = res.headers.get('payment-required')
  expect(header).toBeTruthy()
  return JSON.parse(Buffer.from(header as string, 'base64').toString('utf8')) as {
    accepts: Accept[]; resource: { url: string }
  }
}

let nonceCounter = 0
function evmPayment(
  required: { accepts: Accept[]; resource: { url: string } },
  nonce?: string,
  from = '0x1111111111111111111111111111111111111111',
): string {
  const accepted = required.accepts.find((a) => a.network.startsWith('eip155:')) as Accept
  const n = nonce ?? `0x${(++nonceCounter).toString(16).padStart(64, '0')}`
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      authorization: {
        from,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: '0',
        validBefore: '9999999999',
        nonce: n,
      },
      signature: `0x${'a'.repeat(130)}`,
    },
  })).toString('base64')
}

async function paid(
  base: string,
  header: string,
  opts: { route?: string; body?: unknown; key?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${opts.route ?? '/v1/checks'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'payment-signature': header,
      ...(opts.key ? { 'idempotency-key': opts.key } : {}),
    },
    body: JSON.stringify(opts.body ?? { url: 'https://example.com' }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function jobCount(): number {
  return store.listJobsByStatuses(['payment_pending', 'queued', 'running', 'retryable', 'complete', 'failed']).length
}

describe('paid admission: invalid payments cannot poison keys or exhaust capacity', () => {
  it('rejects invalid signatures before storing anything, then accepts a valid payment for the same key', async () => {
    const { runner, enqueued } = makeRunner()
    const base = await serve(makeCfg(2), runner)
    const required = await challenge(base)
    fac.verify = async () => ({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' })
    for (let i = 0; i < 30; i++) {
      const r = await paid(base, evmPayment(required), { key: 'buyer-key' })
      expect(r.status).toBe(402)
      expect(r.body).not.toHaveProperty('id')
    }
    expect(fac.settleCalls).toBe(0)
    expect(jobCount()).toBe(0)
    expect(store.countUnresolvedPayments()).toBe(0)
    expect(store.getJobByIdempotencyKey('buyer-key')).toBeNull()

    fac.verify = async () => ({ isValid: true })
    const ok = await paid(base, evmPayment(required), { key: 'buyer-key' })
    expect(ok.status).toBe(202)
    expect(ok.body).toMatchObject({ status: 'queued', nextAction: 'poll_same_job' })
    expect(fac.settleCalls).toBe(1)
    expect(enqueued).toEqual([ok.body['id']])
    const job = store.getJob(ok.body['id'] as string)
    expect(job).toMatchObject({ status: 'queued', settlementState: 'settled', settlementTx: '0xsettled' })
  })

  it('treats a verification outage as a pre-settlement rejection with no stored state', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    fac.verify = async () => { throw new Error('facilitator timeout') }
    const r = await paid(base, evmPayment(required), { key: 'k1' })
    expect(r.status).toBe(402)
    expect(fac.settleCalls).toBe(0)
    expect(jobCount()).toBe(0)
  })

  it('pauses before verification when unresolved payments reach the limit, without charging', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(2), runner)
    const required = await challenge(base)
    fac.settle = async () => { throw new Error('socket hang up') }
    expect((await paid(base, evmPayment(required))).status).toBe(202)
    expect((await paid(base, evmPayment(required))).status).toBe(202)
    expect(store.countUnresolvedPayments()).toBe(2)
    const verifyBefore = fac.verifyCalls
    const settleBefore = fac.settleCalls
    const blocked = await paid(base, evmPayment(required))
    expect(blocked.status).toBe(503)
    expect(blocked.body).toMatchObject({ code: 'payment_admission_paused' })
    expect(fac.verifyCalls).toBe(verifyBefore)
    expect(fac.settleCalls).toBe(settleBefore)
  })
})

describe('paid admission: concurrency and binding', () => {
  it('settles one concurrent duplicate payment once and returns the same job to both callers', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    let releaseSettle!: () => void
    const gate = new Promise<void>((resolve) => { releaseSettle = resolve })
    fac.settle = async (_p, r) => { await gate; return { success: true, transaction: '0xabc', network: r.network } }
    const header = evmPayment(required)
    const a = paid(base, header)
    const b = paid(base, header)
    await new Promise((resolve) => setTimeout(resolve, 100))
    releaseSettle()
    const [ra, rb] = await Promise.all([a, b])
    expect(fac.settleCalls).toBe(1)
    expect(ra.status).toBe(202)
    expect(rb.status).toBe(202)
    expect(ra.body['id']).toBe(rb.body['id'])
    expect(jobCount()).toBe(1)
  })

  it('lets only one of two different payments for the same key settle; the other is told nothing was charged', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    let releaseSettle!: () => void
    const gate = new Promise<void>((resolve) => { releaseSettle = resolve })
    fac.settle = async (_p, r) => { await gate; return { success: true, transaction: '0xabc', network: r.network } }
    const a = paid(base, evmPayment(required), { key: 'shared' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const b = paid(base, evmPayment(required), { key: 'shared' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseSettle()
    const [ra, rb] = await Promise.all([a, b])
    expect(fac.settleCalls).toBe(1)
    expect(ra.status).toBe(202)
    expect(rb.status).toBe(409)
    expect(rb.body).not.toHaveProperty('id')
  })

  it('never returns a job to a different payment or to the same payment with different work', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    const header = evmPayment(required)
    const first = await paid(base, header, { key: 'owner-key' })
    expect(first.status).toBe(202)

    const otherPayment = await paid(base, evmPayment(required), { key: 'owner-key' })
    expect(otherPayment.status).toBe(409)
    expect(otherPayment.body).not.toHaveProperty('id')

    const changedWork = await paid(base, header, { body: { url: 'https://changed.example.com' } })
    expect(changedWork.status).toBe(409)
    expect(changedWork.body).not.toHaveProperty('id')

    const sameRetry = await paid(base, header)
    expect(sameRetry.status).toBe(202)
    expect(sameRetry.body).toMatchObject({ id: first.body['id'], paymentReplay: true })
    expect(fac.settleCalls).toBe(1)
  })
})

describe('paid admission: uncertain outcomes stay unresolved', () => {
  for (const [label, settle] of [
    ['a thrown timeout', async () => { throw new Error('timeout') }],
    ['a facilitator success:false', async (_p: unknown, r: { network: string }) => ({
      success: false, transaction: '', network: r.network, errorReason: 'unexpected_settle_error',
    })],
  ] as const) {
    it(`keeps the job, key and intent unresolved after ${label}, and never asks for another payment`, async () => {
      const { runner, enqueued } = makeRunner()
      const base = await serve(makeCfg(), runner)
      const required = await challenge(base)
      fac.settle = settle as typeof fac.settle
      const header = evmPayment(required)
      const r = await paid(base, header, { key: 'uncertain' })
      expect(r.status).toBe(202)
      expect(r.body).toMatchObject({
        status: 'payment_pending', paymentOutcome: 'unresolved', nextAction: 'poll_same_job',
      })
      expect(String(r.body['detail'])).toMatch(/Do not send another payment/)
      expect(enqueued).toEqual([])
      const id = r.body['id'] as string
      expect(store.getJob(id)).toMatchObject({ status: 'payment_pending', settlementState: 'unknown' })

      // Retrying the same payment does not settle again and returns the same id.
      const retry = await paid(base, header, { key: 'uncertain' })
      expect(retry.body).toMatchObject({ id, paymentOutcome: 'unresolved' })
      expect(fac.settleCalls).toBe(1)

      // A different payment for the key is refused before verify or settle.
      const verifyBefore = fac.verifyCalls
      const other = await paid(base, evmPayment(required), { key: 'uncertain' })
      expect(other.status).toBe(409)
      expect(fac.verifyCalls).toBe(verifyBefore)
      expect(fac.settleCalls).toBe(1)

      // No automatic expiry, even long after retention.
      expect(store.listExpiredJobs(Date.now() + 365 * 86_400_000).map((j) => j.id)).not.toContain(id)

      // Status polling never instructs a new payment.
      const poll = await fetch(`${base}/v1/checks/${id}`)
      const pollBody = (await poll.json()) as Record<string, unknown>
      expect(pollBody).toMatchObject({ status: 'payment_pending', nextAction: 'poll_same_job' })
    })
  }

  it('records a lost response: the buyer disconnects during settlement and the paid job is still delivered once', async () => {
    const { runner, enqueued } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    let releaseSettle!: () => void
    const gate = new Promise<void>((resolve) => { releaseSettle = resolve })
    fac.settle = async (_p, r) => { await gate; return { success: true, transaction: '0xlate', network: r.network } }
    const header = evmPayment(required)
    const controller = new AbortController()
    const lost = fetch(`${base}/v1/checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-signature': header },
      body: JSON.stringify({ url: 'https://example.com' }),
      signal: controller.signal,
    }).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, 80))
    controller.abort()
    await lost
    releaseSettle()
    await new Promise((resolve) => setTimeout(resolve, 80))
    const retry = await paid(base, header)
    expect(retry.status).toBe(202)
    expect(retry.body).toMatchObject({ status: 'queued', paymentReplay: true })
    expect(fac.settleCalls).toBe(1)
    expect(enqueued).toEqual([retry.body['id']])
  })
})

describe('paid admission: crash and restart recovery', () => {
  it('recovers a confirmed payment that crashed before enqueue as the original job, exactly once', async () => {
    const { runner, setFailEnqueue } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    setFailEnqueue(true) // the process "dies" at handoff: nothing reaches the worker
    const r = await paid(base, evmPayment(required), { key: 'crash-key' })
    expect(r.status).toBe(202)
    const id = r.body['id'] as string
    store.close()

    const reopened = new JobStore(dbPath)
    reopened.init()
    expect(reopened.recoverInterruptedSettlements()).toBe(0)
    const queued = reopened.listJobsByStatuses(['queued'])
    expect(queued.map((j) => j.id)).toEqual([id])
    expect(reopened.getJob(id)).toMatchObject({ settlementState: 'settled', idempotencyKey: 'crash-key' })
    reopened.close()
    store = new JobStore(dbPath)
    store.init()
  })

  it('turns a settle interrupted by a crash into unknown, then resolves it once from operator evidence', async () => {
    store.admitPaymentAttempt({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', url: 'https://example.com', kind: 'check', request: {},
      idempotencyKey: 'k', paymentId: 'p1', network: 'eip155:8453', expiresAt: Date.now() + 1000, unresolvedLimit: 5,
    })
    store.close()
    const reopened = new JobStore(dbPath)
    reopened.init()
    expect(reopened.recoverInterruptedSettlements()).toBe(1)
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    expect(reopened.getJob(id)).toMatchObject({ status: 'payment_pending', settlementState: 'unknown' })
    expect(reopened.recordSettlement(id, { network: 'eip155:8453', transaction: '0xproof' })).toBe(true)
    expect(reopened.recordSettlement(id, { network: 'eip155:8453', transaction: '0xproof' })).toBe(true)
    expect(reopened.listJobsByStatuses(['queued']).map((j) => j.id)).toEqual([id])
    expect(reopened.getJob(id)).toMatchObject({ settlementTx: '0xproof' })
    reopened.close()
    store = new JobStore(dbPath)
    store.init()
  })

  it('releases the key only when an operator proves the payment never settled', async () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    store.admitPaymentAttempt({
      id, url: 'https://example.com', kind: 'check', request: {},
      idempotencyKey: 'released', paymentId: 'p2', network: 'eip155:8453', expiresAt: Date.now(), unresolvedLimit: 5,
    })
    store.markSettlementUnknown(id, 'timeout')
    expect(store.getJobByIdempotencyKey('released')?.id).toBe(id)
    expect(store.markSettlementRejected(id, 'authorizationState false after validBefore')).toBe(true)
    expect(store.getJobByIdempotencyKey('released')).toBeNull()
    expect(store.getJob(id)).toMatchObject({ status: 'failed', settlementState: 'rejected' })
    expect(store.countUnresolvedPayments()).toBe(0)
    // A settled job can never be marked rejected.
    const settled = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    store.admitPaymentAttempt({
      id: settled, url: 'https://example.com', kind: 'check', request: {},
      paymentId: 'p3', network: 'eip155:8453', expiresAt: Date.now(), unresolvedLimit: 5,
    })
    store.recordSettlement(settled, { network: 'eip155:8453', transaction: '0x1' })
    expect(store.markSettlementRejected(settled, 'wrong')).toBe(false)
  })

  it('keeps paid work queued when the worker is quarantined after settlement', async () => {
    const { runner, setHealthy, setFailEnqueue } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    fac.settle = async (_p, r) => {
      setHealthy(false)
      setFailEnqueue(true)
      return { success: true, transaction: '0xq', network: r.network }
    }
    const r = await paid(base, evmPayment(required))
    expect(r.status).toBe(202)
    const job = store.getJob(r.body['id'] as string)
    expect(job).toMatchObject({ status: 'queued', settlementState: 'settled' })
  })
})

describe('paid admission: every product route and both rails', () => {
  const routes: Array<[string, unknown]> = [
    ['/v1/checks', { url: 'https://example.com' }],
    ['/v1/verify', { url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }] }],
    ['/v1/extract', { url: 'https://example.com', maxOutputTokens: 500 }],
    ['/v1/security-gate', { url: 'https://example.com' }],
  ]
  for (const [route, body] of routes) {
    it(`${route}: verified then settled payment creates exactly one bound job`, async () => {
      const { runner, enqueued } = makeRunner()
      const base = await serve(makeCfg(), runner)
      const required = await challenge(base, route, body)
      const header = evmPayment(required)
      const r = await paid(base, header, { route, body, key: `k${route}` })
      expect(r.status).toBe(202)
      expect(enqueued).toEqual([r.body['id']])
      const again = await paid(base, header, { route, body, key: `k${route}` })
      expect(again.body['id']).toBe(r.body['id'])
      expect(fac.settleCalls).toBe(1)
    })
  }

  it('preserves the Solana rail in the challenge and admits a Solana payment', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    const solana = required.accepts.find((a) => a.network.startsWith('solana:')) as Accept
    expect(solana).toMatchObject({ payTo: SOLANA_PAY_TO, amount: '80000' })
    const header = Buffer.from(JSON.stringify({
      x402Version: 2, resource: required.resource, accepted: solana,
      payload: { transaction: Buffer.from('synthetic-solana-transaction').toString('base64') },
    })).toString('base64')
    const r = await paid(base, header)
    expect(r.status).toBe(202)
    expect(store.getJob(r.body['id'] as string)).toMatchObject({
      settlementState: 'settled', settlementNetwork: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    })
  })
})

describe('MCP paid admission and recovery', () => {
  async function mcpCall(base: string, name: string, args: Record<string, unknown>, payment?: unknown) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: args, ...(payment ? { _meta: { 'x402/payment': payment } } : {}) },
      }),
    })
    const text = await res.text()
    const json = JSON.parse(text.startsWith('{') ? text : text.split('\ndata: ')[1] ?? '{}') as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean; structuredContent?: unknown }
    }
    const content = json.result?.content?.[0]?.text ?? '{}'
    let body: Record<string, unknown>
    try { body = JSON.parse(content) as Record<string, unknown> } catch { body = { text: content } }
    return { isError: json.result?.isError, body, raw: json.result }
  }

  async function mcpRequirements(base: string) {
    const r = await mcpCall(base, 'check_page', { url: 'https://example.com' })
    expect(r.isError).toBe(true)
    const required = (r.raw as { structuredContent?: { accepts?: Accept[]; resource?: { url: string } } })
      .structuredContent ?? (r.body as { accepts?: Accept[]; resource?: { url: string } })
    const accepts = required.accepts as Accept[]
    expect(accepts.length).toBeGreaterThan(0)
    return { accepts, resource: required.resource ?? { url: 'mcp://tool/check_page' } }
  }

  function mcpPayment(required: { accepts: Accept[]; resource: { url: string } }) {
    return JSON.parse(Buffer.from(evmPayment(required), 'base64').toString('utf8')) as unknown
  }

  it('never enters the paid wrapper while the worker is quarantined', async () => {
    const { runner, setHealthy } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await mcpRequirements(base)
    setHealthy(false)
    const r = await mcpCall(base, 'check_page', { url: 'https://example.com' }, mcpPayment(required))
    expect(r.isError).toBe(true)
    expect(r.body).toMatchObject({ error: 'worker_unavailable' })
    expect(fac.verifyCalls + fac.settleCalls).toBe(0)
    expect(jobCount()).toBe(0)
  })

  it('rejects invalid MCP payments without storing anything', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await mcpRequirements(base)
    fac.verify = async () => ({ isValid: false, invalidReason: 'invalid_signature' })
    const r = await mcpCall(base, 'check_page', { url: 'https://example.com' }, mcpPayment(required))
    expect(r.isError).toBe(true)
    expect(fac.settleCalls).toBe(0)
    expect(jobCount()).toBe(0)
  })

  it('returns an unresolved status, not a failure, when MCP settlement is uncertain', async () => {
    const { runner, enqueued } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await mcpRequirements(base)
    fac.settle = async () => { throw new Error('timeout') }
    const payment = mcpPayment(required)
    const r = await mcpCall(base, 'check_page', { url: 'https://example.com' }, payment)
    expect(r.isError).toBeUndefined()
    expect(r.body).toMatchObject({ status: 'payment_pending', paymentOutcome: 'unresolved' })
    expect(enqueued).toEqual([])
    const again = await mcpCall(base, 'check_page', { url: 'https://example.com' }, payment)
    expect(again.body).toMatchObject({ id: r.body['id'], paymentOutcome: 'unresolved' })
    expect(fac.settleCalls).toBe(1)
  })

  it('delivers one job for a settled MCP payment and replays it without settling again', async () => {
    const { runner, enqueued } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await mcpRequirements(base)
    const payment = mcpPayment(required)
    const r = await mcpCall(base, 'check_page', { url: 'https://example.com' }, payment)
    expect(r.body).toMatchObject({ status: 'queued' })
    expect(enqueued).toEqual([r.body['id']])
    const replay = await mcpCall(base, 'check_page', { url: 'https://example.com' }, payment)
    expect(replay.body).toMatchObject({ id: r.body['id'], paymentReplay: true })
    const changed = await mcpCall(base, 'check_page', { url: 'https://changed.example.com' }, payment)
    expect(changed.isError).toBe(true)
    expect(changed.body).not.toHaveProperty('id')
    expect(fac.settleCalls).toBe(1)
  })
})

describe('paid admission: review hardening', () => {
  function reencode(header: string): string {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Record<string, unknown>
    return Buffer.from(JSON.stringify(decoded, null, 1)).toString('base64')
  }

  it('treats a re-encoded copy of one payment as the same payment and settles it once', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    let releaseSettle!: () => void
    const gate = new Promise<void>((resolve) => { releaseSettle = resolve })
    fac.settle = async (_p, r) => { await gate; return { success: true, transaction: '0xone', network: r.network } }
    const header = evmPayment(required)
    const a = paid(base, header)
    const b = paid(base, reencode(header))
    await new Promise((resolve) => setTimeout(resolve, 100))
    releaseSettle()
    const [ra, rb] = await Promise.all([a, b])
    expect(fac.settleCalls).toBe(1)
    expect(ra.body['id']).toBe(rb.body['id'])
    expect(jobCount()).toBe(1)
    expect(store.countUnresolvedPayments()).toBe(0)
  })

  it('recognises a payment already used over HTTP when it arrives over MCP', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    const header = evmPayment(required)
    const first = await paid(base, header)
    expect(first.status).toBe(202)
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as unknown
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'check_page', arguments: { url: 'https://example.com' }, _meta: { 'x402/payment': payload } },
      }),
    })
    const text = await res.text()
    const json = JSON.parse(text.startsWith('{') ? text : text.split('\ndata: ')[1] ?? '{}') as {
      result?: { content?: Array<{ text?: string }> }
    }
    const body = JSON.parse(json.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>
    expect(body).toMatchObject({ id: first.body['id'], paymentReplay: true })
    expect(fac.settleCalls).toBe(1)
    expect(jobCount()).toBe(1)
  })

  it('stops one payer from filling global capacity with failing settlements', async () => {
    const { runner } = makeRunner()
    const base = await serve({ ...makeCfg(5), PAYMENT_UNRESOLVED_PER_PAYER: 2 } as Config, runner)
    const required = await challenge(base)
    fac.settle = async (_p, r) => ({
      success: false, transaction: '', network: r.network, errorReason: 'insufficient_funds',
    })
    const attacker = '0x2222222222222222222222222222222222222222'
    const results = await Promise.all(
      Array.from({ length: 6 }, () => paid(base, evmPayment(required, undefined, attacker))),
    )
    expect(results.filter((r) => r.status === 202)).toHaveLength(2)
    const busy = results.filter((r) => r.status === 429)
    expect(busy).toHaveLength(4)
    for (const r of busy) {
      expect(r.body).toMatchObject({ code: 'payment_payer_busy' })
      expect(r.body['detail']).toContain('Nothing was charged')
      expect(r.body).not.toHaveProperty('id')
    }
    expect(fac.settleCalls).toBe(2)
    expect(store.countUnresolvedPayments()).toBe(2)

    fac.settle = async (_p, r) => ({ success: true, transaction: '0xok', network: r.network })
    const other = await paid(base, evmPayment(required, undefined, '0x3333333333333333333333333333333333333333'))
    expect(other.status).toBe(202)
    expect(other.body).toMatchObject({ status: 'queued' })
  })

  it('never sends a failed settlement receipt with an unresolved response', async () => {
    const { runner } = makeRunner()
    const base = await serve(makeCfg(), runner)
    const required = await challenge(base)
    fac.settle = async (_p, r) => ({
      success: false, transaction: '', network: r.network, errorReason: 'insufficient_funds',
    })
    const res = await fetch(`${base}/v1/checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-signature': evmPayment(required) },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(202)
    expect(res.headers.get('payment-response')).toBeNull()
    expect(res.headers.get('payment-required')).toBeNull()
    expect(await res.json()).toMatchObject({ paymentOutcome: 'unresolved' })
  })

  it('refuses to mark a payment unpaid while its settlement is still in flight', () => {
    const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    store.admitPaymentAttempt({
      id, url: 'https://example.com', kind: 'check', request: {},
      idempotencyKey: 'inflight', paymentId: 'p-inflight', network: 'eip155:8453',
      expiresAt: Date.now() + 1000, unresolvedLimit: 5,
    })
    expect(store.markSettlementRejected(id, 'operator guessed while settle was running')).toBe(false)
    expect(store.getJobByIdempotencyKey('inflight')?.id).toBe(id)
    expect(store.recordSettlement(id, { network: 'eip155:8453', transaction: '0xlate' })).toBe(true)
    expect(store.getJob(id)).toMatchObject({ status: 'queued', settlementState: 'settled' })
  })

  it('gives a late-reconciled payment a fresh retention period', () => {
    const id = '99999999-9999-4999-8999-999999999999'
    const retention = 7 * 24 * 60 * 60 * 1000
    store.admitPaymentAttempt({
      id, url: 'https://example.com', kind: 'check', request: {},
      paymentId: 'p-late', network: 'eip155:8453', expiresAt: Date.now() + retention, unresolvedLimit: 5,
    })
    store.markSettlementUnknown(id, 'timeout')
    const later = Date.now() + 10 * 24 * 60 * 60 * 1000
    vi.useFakeTimers({ now: later, toFake: ['Date'] })
    try {
      store.recordSettlement(id, { network: 'eip155:8453', transaction: '0xlate' })
      expect(store.listExpiredJobs(later).map((j) => j.id)).not.toContain(id)
      expect(store.getJob(id)?.expiresAt).toBeGreaterThan(later)
    } finally {
      vi.useRealTimers()
    }
  })
})
