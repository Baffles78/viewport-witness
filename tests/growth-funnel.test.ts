import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { growthMiddleware, growthContext, GROWTH_EVENTS } from '../src/growth.js'
import { JobStore } from '../src/db.js'
import type { Request, Response } from 'express'
import type { PaymentMode } from '../src/types.js'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from '../src/api/index.js'
import type { Config } from '../src/config.js'
import type { WorkerRunner } from '../src/worker/runner.js'
import * as ssrf from '../src/ssrf.js'

function request({ status = 402, signed = false, settled = false, mode = 'production', source = 'unknown', path = '/v1/checks', throws = false }:
  { status?: number; signed?: boolean; settled?: boolean; mode?: PaymentMode; source?: string; path?: string; throws?: boolean } = {}) {
  const calls: unknown[][] = []
  const store = { recordGrowth: (...args: unknown[]) => { if (throws) throw Error('private fixture error'); calls.push(args) } } as unknown as JobStore
  const req = { method: 'POST', path, headers: { 'x-viewportwitness-source': source, ...(signed ? { 'payment-signature': 'private-fixture-signature' } : {}) } } as unknown as Request
  const res = Object.assign(new EventEmitter(), { statusCode: status, locals: {} }) as unknown as Response
  let nextCalls = 0
  let contextSource: string | undefined
  growthMiddleware(store, mode)(req, res, () => { nextCalls++; contextSource = growthContext.getStore()?.source })
  // Payment state is populated downstream, after the observer entered.
  req.paymentResult = { settled, mode }
  res.emit('finish')
  res.emit('finish')
  return { calls, events: calls.map(c => c[2]), nextCalls, contextSource }
}

describe('anonymous request-stage funnel', () => {
  it('unsigned challenges do not establish a payment attempt or acceptance', () => {
    expect(request().events).toEqual(['unpaid_challenge'])
  })
  it('input rejected after parsing is an attempt plus rejected input, never valid payment', () => {
    expect(request({ signed: true, status: 422 }).events).toEqual(['payment_header_attempt', 'input_rejected_after_parser'])
    expect(request({ signed: true, status: 400 }).events).toEqual(['payment_header_attempt', 'input_rejected_after_parser'])
  })
  it('signed rejection and unavailable service use distinct categories', () => {
    expect(request({ signed: true }).events).toEqual(['payment_header_attempt', 'unpaid_challenge', 'payment_rejected_response'])
    expect(request({ signed: true, status: 503 }).events).toEqual(['payment_header_attempt', 'service_unavailable_response'])
  })
  it('downstream settled paid state counts once per response; test mode cannot claim acceptance', () => {
    expect(request({ signed: true, status: 202, settled: true }).events).toEqual(['payment_header_attempt', 'payment_accepted_response'])
    expect(request({ signed: true, status: 202, settled: true, mode: 'test' }).events).toEqual(['payment_header_attempt'])
  })
  it('labels remain caller-declared, arbitrary private labels become unknown, and no raw values survive', () => {
    for (const source of ['monitor', 'test-client', 'private-person-identity']) {
      const r = request({ signed: true, source })
      expect(r.calls.every(c => c[1] === (source === 'private-person-identity' ? 'unknown' : source))).toBe(true)
      expect(JSON.stringify(r.calls)).not.toContain('private-')
    }
  })
  it('MCP stays protocol-labelled and HTTP-only stage counts do not invent MCP acceptance', () => {
    const r = request({ signed: true, path: '/mcp', status: 202, settled: true })
    expect(r.events).toEqual([])
    expect(r.contextSource).toBe('mcp')
  })
  it('measurement failures do not interrupt request processing', () => {
    expect(request({ signed: true, throws: true }).nextCalls).toBe(1)
  })
  it('stores only allowlisted daily aggregate dimensions with mode and thirty-day retention', () => {
    const store = new JobStore(':memory:')
    store.init()
    const now = Date.UTC(2026, 9, 8, 12)
    try {
      for (const event of GROWTH_EVENTS) store.recordGrowth('check', 'monitor', event, 'production', now)
      store.recordGrowth('check', 'test-client', 'payment_header_attempt', 'test', now)
      const result = store.growthSummary({ now })
      expect(result.documents).toHaveLength(GROWTH_EVENTS.length + 1)
      expect(result.paidJobs).toBe(0)
      for (const row of result.documents as Array<Record<string, unknown>>) {
        expect(Object.keys(row).sort()).toEqual(['count', 'day', 'event', 'mode', 'product', 'source'])
        expect(row['count']).toBe(1)
      }
      expect(result.limitations.join(' ')).toContain('unverified presence')
      expect(result.limitations.join(' ')).toContain('normalized JSON-parser error categories')
      const later = now + 30 * 86400000
      store.pruneGrowthDaily(later)
      expect(store.growthSummary({ now: later }).documents).toHaveLength(0)
    } finally {
      store.close()
    }
  })
})

function memoryStore() { const store = new JobStore(':memory:'); store.init(); return store }
function rows(store: JobStore) { return store.growthSummary().documents as Array<{ event: string; count: number; source: string; mode: string }> }
function count(store: JobStore, event: string) { return rows(store).filter(r => r.event === event).reduce((n, r) => n + r.count, 0) }
function create(store: JobStore, id: string, pending = false, source: 'mcp' | 'unknown' = 'unknown', mode: PaymentMode = 'production') {
  growthContext.run({ source, mode }, () => store.createJob({ id, url: 'https://example.com', idempotencyKey: null,
    paymentId: 'fixture-' + id, expiresAt: Date.now() + 86400000, ...(pending ? { initialStatus: 'payment_pending' as const } : {}) }))
}
describe('anonymous unique job lifecycle', () => {
  it('attribution-write failures remain visible while the job can still complete', () => {
    const store = memoryStore()
    try {
      const db = (store as unknown as { db: DatabaseSync }).db
      db.exec("CREATE TRIGGER reject_attribution BEFORE INSERT ON growth_jobs BEGIN SELECT RAISE(ABORT,'fixture'); END")
      create(store, 'attribution-failure')
      expect(store.getJob('attribution-failure')?.status).toBe('queued')
      store.updateJobStatus('attribution-failure', 'complete')
      expect(store.getJob('attribution-failure')?.status).toBe('complete')
      expect(store.growthSummary().counterObservation.writeFailuresThisProcess).toBeGreaterThan(0)
      expect(count(store, 'job_complete')).toBe(0)
    } finally { store.close() }
  })
  it('deduplicates repeated terminal writes and admission without retaining caller data in daily counters', () => {
    const store = memoryStore()
    try {
      create(store, 'one')
      store.updateJobStatus('one', 'complete'); store.updateJobStatus('one', 'complete')
      store.updateJobStatus('one', 'running'); store.updateJobStatus('one', 'complete')
      expect(count(store, 'job_created')).toBe(1)
      expect(count(store, 'accepted_paid_job')).toBe(1)
      expect(count(store, 'job_complete')).toBe(1)
      expect(JSON.stringify(rows(store))).not.toContain('fixture-')
      expect(JSON.stringify(rows(store))).not.toContain('example.com')
    } finally { store.close() }
  })
  it('separates MCP pending settlement failure from successful unique admission and worker failure', () => {
    const store = memoryStore()
    try {
      create(store, 'accepted', true, 'mcp')
      expect(count(store, 'accepted_paid_job')).toBe(0)
      expect(store.activatePaymentPendingJob('accepted')).toBe(true)
      expect(store.activatePaymentPendingJob('accepted')).toBe(false)
      store.updateJobStatus('accepted', 'failed'); store.updateJobStatus('accepted', 'failed')
      create(store, 'rejected', true, 'mcp')
      expect(store.failPaymentPendingJob('rejected', 'payment_not_settled')).toBe(true)
      expect(store.failPaymentPendingJob('rejected', 'payment_not_settled')).toBe(false)
      expect(count(store, 'accepted_paid_job')).toBe(1)
      expect(count(store, 'job_failed')).toBe(1)
      expect(count(store, 'payment_pending_failed')).toBe(1)
      expect(rows(store).filter(r => r.event === 'accepted_paid_job')[0]?.source).toBe('mcp')
    } finally { store.close() }
  })
  it('test-mode creation/completion never establishes paid admission', () => {
    const store = memoryStore()
    try {
      create(store, 'test', false, 'unknown', 'test')
      store.updateJobStatus('test', 'complete')
      expect(count(store, 'accepted_paid_job')).toBe(0)
      expect(count(store, 'job_complete')).toBe(1)
    } finally { store.close() }
  })
  it('retains daily counts after private job deletion, then prunes after thirty days', () => {
    const store = memoryStore()
    try {
      create(store, 'delete')
      store.updateJobStatus('delete', 'complete')
      store.deleteJob('delete')
      expect(store.getJob('delete')).toBeNull()
      expect(count(store, 'job_complete')).toBe(1)
      const later = Date.now() + 30 * 86400000
      store.pruneGrowthDaily(later)
      expect(store.growthSummary({ now: later }).documents).toHaveLength(0)
    } finally { store.close() }
  })
  it('failed measurement rolls back its dedupe marker and never prevents job processing', () => {
    const store = memoryStore()
    try {
      const db = (store as unknown as { db: DatabaseSync }).db
      db.exec("CREATE TRIGGER reject_counter BEFORE INSERT ON growth_daily BEGIN SELECT RAISE(ABORT,'fixture'); END")
      create(store, 'failure')
      expect(store.getJob('failure')?.status).toBe('queued')
      expect(store.growthSummary().counterObservation.writeFailuresThisProcess).toBeGreaterThan(0)
      expect(db.prepare('SELECT count(*) AS n FROM growth_job_events').get()?.['n']).toBe(0)
      db.exec('DROP TRIGGER reject_counter')
      store.updateJobStatus('failure', 'complete')
      expect(count(store, 'job_complete')).toBe(1)
    } finally { store.close() }
  })
})

describe('real API parser telemetry', () => {
  it('observes malformed and oversized JSON through actual middleware while preserving its existing error response', async () => {
    const store = memoryStore()
    const cfg = { NODE_ENV: 'test', PAYMENT_MODE: 'test', ENABLE_MAINNET_PAYMENTS: false, ENABLE_SOLANA_PAYMENTS: false,
      PAY_TO: 'fixture', PRICE_USDC: '0.08', VERIFY_PRICE_USDC: '0.10', COMPARE_PRICE_USDC: '0.12', RETENTION_DAYS: 7 } as Config
    const app = createApp(store, {} as WorkerRunner, cfg)
    const server = http.createServer(app)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      for (const body of ['{invalid', JSON.stringify({ data: 'x'.repeat(11000) })]) {
        const result = await fetch(`http://127.0.0.1:${port}/v1/checks`, { method: 'POST', body,
          headers: { 'Content-Type': 'application/json', 'payment-signature': 'fixture-signature' } })
        expect(result.status).toBe(500)
        expect((await result.json() as { error: string }).error).toBe('internal_error')
      }
      expect(count(store, 'parser_rejected_response')).toBe(2)
      expect(count(store, 'payment_header_attempt')).toBe(2)
      expect(count(store, 'payment_accepted_response')).toBe(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      log.mockRestore(); store.close()
    }
  })
})


describe('real parsed request attribution', () => {
  it('keeps caller-declared attribution through body parsing without treating test jobs as paid', async () => {
    const store = memoryStore()
    const cfg = { NODE_ENV: 'test', PAYMENT_MODE: 'test', ENABLE_MAINNET_PAYMENTS: false, ENABLE_SOLANA_PAYMENTS: false,
      PAY_TO: 'fixture', PRICE_USDC: '0.08', VERIFY_PRICE_USDC: '0.10', COMPARE_PRICE_USDC: '0.12', RETENTION_DAYS: 7 } as Config
    const enqueue = vi.fn(async () => {})
    const validator = vi.spyOn(ssrf, 'validatePublicHttpsUrl').mockResolvedValue({ valid: true })
    const server = http.createServer(createApp(store, { enqueue } as unknown as WorkerRunner, cfg))
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/v1/checks`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-viewportwitness-source': 'monitor' },
        body: JSON.stringify({ url: 'https://example.com' }) })
      expect(response.status).toBe(202)
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(rows(store).filter(r => r.event === 'job_created')).toEqual([
        expect.objectContaining({ source: 'monitor', mode: 'test', count: 1 })])
      expect(count(store, 'accepted_paid_job')).toBe(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      validator.mockRestore(); store.close()
    }
  })
})
