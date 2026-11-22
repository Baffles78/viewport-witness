import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { WorkerRunner } from '../src/worker/runner.js'
import { feedbackDiscovery } from '../src/api/feedback-discovery.js'
import { jsonResult } from '../src/mcp/tool-schemas.js'
import { createApp } from '../src/api/index.js'
import { JobStore } from '../src/db.js'
import {
  servers,
  makeConfig,
  makeMockStore,
  makeMockRunner,
  startMcpServer,
  callToolsList,
} from './helpers/mcp-server.js'

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise((resolve) => server.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

describe('feedback at application purchase blockers', () => {
  it('preserves status, payment headers, error codes and recovery while adding an optional invitation', async () => {
    const app = express()
    app.use(feedbackDiscovery)
    const original = {
      error: 'purchase_blocked',
      code: 'same_code',
      nextAction: 'poll_same_job',
      paymentOutcome: 'unresolved',
      accepts: [{ amount: '80000' }],
    }
    app.post('/v1/checks/:status', (req, res) => {
      res.setHeader('PAYMENT-REQUIRED', 'unchanged-encoded-challenge')
      res.setHeader('PAYMENT-RESPONSE', 'unchanged-settlement-receipt')
      res.status(Number(req.params.status)).json(original)
    })
    const base = await serve(app)
    for (const status of [400, 402, 403, 404, 409, 422, 429, 500, 503]) {
      const response = await fetch(`${base}/v1/checks/${status}`, { method: 'POST' })
      expect(response.status).toBe(status)
      expect(response.headers.get('payment-required')).toBe('unchanged-encoded-challenge')
      expect(response.headers.get('payment-response')).toBe('unchanged-settlement-receipt')
      expect(response.headers.get('link')).toBeNull()
      const body = await response.json()
      expect(body).toMatchObject(original)
      expect(body.feedback).toMatchObject({
        endpoint: '/v1/feedback',
        method: 'POST',
        paymentRequired: false,
        optional: true,
      })
      expect(body.feedback.when).toMatch(/price, payment setup, missing capabilities/)
      expect(body.feedback.instruction).toContain('caller authorizes')
      expect(body.feedback.recovery).toContain('never retries a job')
    }
    expect(original).not.toHaveProperty('feedback')
  })

  it('does not decorate successful/pending jobs, feedback errors or JSON-RPC envelopes', async () => {
    const app = express()
    app.use(feedbackDiscovery)
    const pending = { status: 'payment_pending', nextAction: 'poll_same_job' }
    app.post('/v1/checks', (_req, res) => res.status(202).json(pending))
    app.post('/v1/feedback', (_req, res) => res.status(400).json({ error: 'invalid_feedback' }))
    const rpc = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal server error' },
    }
    app.post('/mcp', (_req, res) => res.status(500).json(rpc))
    const base = await serve(app)
    for (const [path, expected] of [
      ['/v1/checks', pending],
      ['/v1/feedback', { error: 'invalid_feedback' }],
      ['/mcp', rpc],
    ] as const) {
      const response = await fetch(base + path, { method: 'POST' })
      expect(await response.json()).toEqual(expected)
      expect(response.headers.get('link')).toBeNull()
    }
  })

  it('advertises feedback on real app validation and payment-configuration failures', async () => {
    const store = new JobStore(':memory:')
    store.init()
    try {
      const base = await serve(createApp(store, makeMockRunner(), makeConfig()))
      const production = await serve(
        createApp(store, makeMockRunner(), makeConfig({ PAYMENT_MODE: 'production' })),
      )
      const post = (url: string) =>
        fetch(base + '/v1/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        })
      const invalid = await post('http://localhost')
      expect(invalid.status).toBe(400)
      expect((await invalid.json()).feedback.endpoint).toBe('/v1/feedback')
      const unavailable = await fetch(production + '/v1/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      })
      expect(unavailable.status).toBe(503)
      expect(await unavailable.json()).toMatchObject({
        error: 'mainnet_payments_disabled',
        feedback: { paymentRequired: false },
      })
      expect(store.growthSummary().paidJobs).toBe(0)
      expect(store.feedback.summary().submissions).toBe(0)
    } finally {
      store.close()
    }
  })
})

describe('MCP purchase-blocker discovery', () => {
  it('exposes optional feedback during initialization and in every paid tool description', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'feedback-test', version: '1' },
        },
      }),
    })
    const initialize = await response.json()
    expect(initialize.result.instructions).toContain('/v1/feedback')
    expect(initialize.result.instructions).toContain('stops a purchase')
    expect(initialize.result.instructions).toContain('/blob/main/docs/QUICKSTART.md')
    expect(initialize.result.instructions).toContain('--wallet cdp')
    expect(initialize.result.instructions).toContain('--resume --output')
    expect(initialize.result.instructions).toContain('explicit spending approval')
    const tools = (await callToolsList(port)).result?.tools ?? []
    expect(tools).toHaveLength(6)
    for (const tool of tools.filter((tool) => tool.name !== 'get_report')) {
      expect(tool.description).toContain('/v1/feedback')
      expect(tool.description).toContain('caller-authorized')
    }
  })

  it('includes the invitation when the worker blocks a tool without creating work or feedback', async () => {
    const runner = {
      isHealthy: () => false,
      enqueue: async () => {
        throw new Error('must not enqueue')
      },
    } as unknown as WorkerRunner
    const { port } = await startMcpServer(makeConfig(), makeMockStore(), runner)
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'check_page', arguments: { url: 'https://example.com' } },
      }),
    })
    const body = await response.json()
    expect(body.result.isError).toBe(true)
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      error: 'worker_unavailable',
      code: 'worker_unavailable',
      feedback: { optional: true, endpoint: '/v1/feedback' },
    })
  })

  it('does not change successful results or recovery actions when shaping an error', () => {
    const existing = {
      error: 'custom_error',
      feedback: { instruction: 'preserve existing guidance' },
    }
    expect(JSON.parse(jsonResult(existing, true).content[0]!.text)).toEqual(existing)
    const recovery = { error: 'not_found', nextAction: 'stop' }
    expect(JSON.parse(jsonResult(recovery, true).content[0]!.text)).toMatchObject({
      ...recovery,
      feedback: { optional: true },
    })
    const pending = { status: 'payment_pending', nextAction: 'poll_same_job' }
    expect(JSON.parse(jsonResult(pending).content[0]!.text)).toEqual(pending)
  })
})
