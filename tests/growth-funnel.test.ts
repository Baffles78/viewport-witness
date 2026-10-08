import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { growthMiddleware, growthContext, GROWTH_EVENTS } from '../src/growth.js'
import { JobStore } from '../src/db.js'
import type { Request, Response } from 'express'
import type { PaymentMode } from '../src/types.js'

function request({ status = 402, signed = false, settled = false, mode = 'production', source = 'unknown', path = '/v1/checks', throws = false }:
  { status?: number; signed?: boolean; settled?: boolean; mode?: PaymentMode; source?: string; path?: string; throws?: boolean } = {}) {
  const calls: unknown[][] = []
  const store = { recordGrowth: (...args: unknown[]) => { if (throws) throw Error('private fixture error'); calls.push(args) } } as unknown as JobStore
  const req = { method: 'POST', path, headers: { 'x-viewportwitness-source': source, ...(signed ? { 'payment-signature': 'private-fixture-signature' } : {}) } } as unknown as Request
  const res = Object.assign(new EventEmitter(), { statusCode: status }) as unknown as Response
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
      expect(result.limitations.join(' ')).toContain('Malformed JSON and parser body-limit failures are not included')
      const later = now + 30 * 86400000
      store.pruneGrowthDaily(later)
      expect(store.growthSummary({ now: later }).documents).toHaveLength(0)
    } finally {
      store.close()
    }
  })
})
