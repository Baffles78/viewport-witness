import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import { createMcpRouter, mcpPaymentFingerprint } from '../src/mcp.js'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import type { WorkerRunner } from '../src/worker/runner.js'

const paymentMock = vi.hoisted(() => ({
  calls: 0,
  beforeSettlement: null as (() => void) | null,
}))

vi.mock('../src/ssrf.js', () => ({
  validatePublicHttpsUrl: vi.fn(async () => ({ valid: true })),
}))
vi.mock('@coinbase/cdp-sdk/x402', () => ({
  createCdpFacilitatorClient: vi.fn(() => ({})),
}))
vi.mock('@x402/core/server', () => ({
  x402ResourceServer: class {
    register() { return this }
    async initialize() { return undefined }
    async buildPaymentRequirementsFromOptions() { return [] }
  },
}))
vi.mock('@x402/mcp', () => ({
  MCP_PAYMENT_META_KEY: 'mock-payment',
  createPaymentWrapper: (_server: unknown, options: {
    hooks: { onAfterSettlement: (args: { paymentPayload: unknown }) => Promise<void> }
  }) => (handler: (args: Record<string, unknown>, context: unknown) => Promise<unknown>) =>
    async (args: Record<string, unknown>, extra: unknown) => {
      paymentMock.calls++
      const meta = (extra as { _meta?: Record<string, unknown> })._meta
      const result = await handler(args, { toolName: 'check_page', arguments: args, meta })
      paymentMock.beforeSettlement?.()
      await options.hooks.onAfterSettlement({ paymentPayload: meta?.['mock-payment'] })
      return result
    },
}))

const paymentPayload = {
  x402Version: 2,
  accepted: {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '80000',
    asset: '0x3333333333333333333333333333333333333333',
    payTo: '0x4444444444444444444444444444444444444444',
    maxTimeoutSeconds: 60,
  },
  payload: {
    authorization: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '80000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: `0x${'1'.repeat(64)}`,
    },
    signature: `0x${'a'.repeat(130)}`,
  },
}

const cfg = {
  PAYMENT_MODE: 'production',
  CDP_API_KEY_ID: 'synthetic-id',
  CDP_API_KEY_SECRET: 'synthetic-secret',
  ENABLE_SOLANA_PAYMENTS: false,
  PAY_TO: '0x4444444444444444444444444444444444444444',
  PRICE_USDC: '0.08',
  VERIFY_PRICE_USDC: '0.10',
  COMPARE_PRICE_USDC: '0.12',
  EXTRACT_PRICE_USDC: '0.005',
  SECURITY_PRICE_USDC: '0.05',
  RETENTION_DAYS: 7,
} as Config

const servers: http.Server[] = []
beforeEach(() => {
  paymentMock.calls = 0
  paymentMock.beforeSettlement = null
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve())),
  ))
})

function makeStore() {
  let job: {
    id: string; status: string; paymentId: string; kind: string; url: string;
    request: { assertions?: unknown[]; maxOutputTokens?: number }; baselineJobId: string | null
  } | null = null
  const createJob = vi.fn((input: {
    id: string; initialStatus: string; paymentId: string; kind: string; url: string;
    request: { assertions?: unknown[]; maxOutputTokens?: number }; baselineJobId?: string
  }) => {
    job = {
      id: input.id, status: input.initialStatus, paymentId: input.paymentId,
      kind: input.kind, url: input.url, request: input.request,
      baselineJobId: input.baselineJobId ?? null,
    }
  })
  const updateJobStatus = vi.fn()
  const store = {
    getJobByPaymentId: (id: string) => job?.paymentId === id ? job : null,
    getJobByIdempotencyKey: () => null,
    createJob,
    activatePaymentPendingJob: (id: string) => {
      if (!job || job.id !== id || job.status !== 'payment_pending') return false
      job.status = 'queued'
      return true
    },
    failPaymentPendingJob: () => undefined,
    updateJobStatus,
  } as unknown as JobStore
  return { store, createJob, updateJobStatus, current: () => job }
}

async function makeServer(store: JobStore, runner: WorkerRunner) {
  const app = express()
  app.use(express.json())
  app.use(createMcpRouter(store, runner, cfg))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

async function callTool(port: number, name: string, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Host: `127.0.0.1:${port}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args,
        _meta: { 'mock-payment': paymentPayload } },
    }),
  })
  const payload = await response.json() as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean }
  }
  return {
    isError: payload.result?.isError,
    body: JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>,
  }
}

const callCheck = (port: number) => callTool(port, 'check_page', { url: 'https://example.com' })

describe('MCP paid admission with mocked settlement', () => {
  it('never enters the paid wrapper while worker is quarantined', async () => {
    const { store, createJob } = makeStore()
    const runner = { isHealthy: () => false, enqueue: vi.fn() } as unknown as WorkerRunner
    const port = await makeServer(store, runner)
    const result = await callCheck(port)
    expect(result.isError).toBe(true)
    expect(result.body).toMatchObject({ error: 'worker_unavailable' })
    expect(paymentMock.calls).toBe(0)
    expect(createJob).not.toHaveBeenCalled()
  })

  it('rejects changed MCP arguments and tool for the same payment without another settlement', async () => {
    const { store, createJob, current } = makeStore()
    const runner = {
      isHealthy: () => true,
      enqueue: vi.fn(async () => undefined),
    } as unknown as WorkerRunner
    const port = await makeServer(store, runner)
    const original = await callCheck(port)
    expect(original.isError).toBeUndefined()
    expect(current()?.kind).toBe('check')
    expect(paymentMock.calls).toBe(1)

    const changedUrl = await callTool(port, 'check_page', { url: 'https://changed.example.com' })
    expect(changedUrl.isError).toBe(true)
    expect(changedUrl.body).toMatchObject({ error: 'payment_replay_conflict' })
    expect(changedUrl.body).not.toHaveProperty('id')

    const changedTool = await callTool(port, 'verify_page', {
      url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }],
    })
    expect(changedTool.isError).toBe(true)
    expect(changedTool.body).toMatchObject({ error: 'payment_replay_conflict' })
    expect(changedTool.body).not.toHaveProperty('id')
    expect(paymentMock.calls).toBe(1)
    expect(createJob).toHaveBeenCalledOnce()
  })

  it('keeps exactly the same queued job if quarantine begins after mocked settlement', async () => {
    const { store, createJob, updateJobStatus, current } = makeStore()
    let healthy = true
    const runner = {
      isHealthy: () => healthy,
      enqueue: vi.fn(async () => { throw new Error('Worker is shutting down') }),
    } as unknown as WorkerRunner
    paymentMock.beforeSettlement = () => { healthy = false }
    const port = await makeServer(store, runner)
    expect(mcpPaymentFingerprint(paymentPayload)).toMatch(/^mcp_[a-f0-9]{64}$/)
    const first = await callCheck(port)
    expect(first.isError).toBeUndefined()
    expect(paymentMock.calls).toBe(1)
    expect(createJob).toHaveBeenCalledOnce()
    expect(current()?.status).toBe('queued')
    expect(updateJobStatus).not.toHaveBeenCalled()
    const second = await callCheck(port)
    expect(second.body).toMatchObject({ id: current()?.id, status: 'queued', paymentReplay: true })
    expect(paymentMock.calls).toBe(1)
    expect(createJob).toHaveBeenCalledOnce()
  })
})
