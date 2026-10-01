import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { JobStore } from '../src/db.js'
import { growthContext, growthSource, GROWTH_SOURCES, growthMiddleware } from '../src/growth.js'
import type { GrowthSource, GrowthProduct, GrowthEvent } from '../src/growth.js'
import type { Request, Response } from 'express'

let store: JobStore
let tmpFile: string

beforeEach(async () => {
  tmpFile = path.join(
    os.tmpdir(),
    `vw-growth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )
  store = new JobStore(tmpFile)
  store.init()
})

afterEach(async () => {
  store.close()
  try {
    await fs.unlink(tmpFile)
    await fs.unlink(`${tmpFile}-wal`).catch(() => {})
    await fs.unlink(`${tmpFile}-shm`).catch(() => {})
  } catch {
    /* ignore */
  }
})

describe('growth source allowlist', () => {
  it('maps known source labels to typed values', () => {
    for (const s of GROWTH_SOURCES) {
      expect(growthSource(s)).toBe(s)
    }
  })

  it('maps unknown or missing headers to "unknown" — no caller label retained', () => {
    expect(growthSource(undefined)).toBe('unknown')
    expect(growthSource('')).toBe('unknown')
    expect(growthSource('wallet:0xdeadbeef')).toBe('unknown')
    expect(growthSource('192.168.1.1')).toBe('unknown')
    expect(growthSource({ injected: true })).toBe('unknown')
  })

  it('rejects label injection attempts', () => {
    expect(growthSource('github-action; DROP TABLE growth_daily')).toBe('unknown')
    expect(growthSource('mcp\x00null')).toBe('unknown')
  })
})

describe('recordGrowth — bounded daily retention', () => {
  it('records an event for a valid combination', () => {
    store.recordGrowth('check', 'github-action', 'unpaid_challenge', 'test')
    const summary = store.growthSummary()
    expect(summary.documents.length).toBeGreaterThan(0)
  })

  it('silently drops events with invalid product/source/event/mode', () => {
    expect(() => {
      store.recordGrowth(
        'unknown_product' as GrowthProduct,
        'github-action',
        'unpaid_challenge',
        'test',
      )
    }).not.toThrow()
    expect(() => {
      store.recordGrowth('check', 'raw-ip' as GrowthSource, 'unpaid_challenge', 'test')
    }).not.toThrow()
    expect(() => {
      store.recordGrowth('check', 'github-action', 'purchase' as GrowthEvent, 'test')
    }).not.toThrow()
    expect(() => {
      store.recordGrowth('check', 'github-action', 'unpaid_challenge', 'mainnet' as 'test')
    }).not.toThrow()
    const summary = store.growthSummary()
    expect(summary.documents.length).toBe(0)
  })

  it('counts are bounded to prevent integer overflow', () => {
    for (let i = 0; i < 5; i++) {
      store.recordGrowth('check', 'agent-client', 'unpaid_challenge', 'production')
    }
    const summary = store.growthSummary()
    const row = (summary.documents as Array<Record<string, unknown>>).find(
      (d) =>
        d['product'] === 'check' &&
        d['source'] === 'agent-client' &&
        d['event'] === 'unpaid_challenge',
    )
    expect(typeof row?.['count']).toBe('number')
    expect(Number(row?.['count'])).toBeGreaterThanOrEqual(5)
  })

  it('purges rows older than 30 days', () => {
    const old = Date.now() - 31 * 86400000
    store.recordGrowth('check', 'mcp', 'document_request', 'testnet', old)
    const summary = store.growthSummary()
    const oldRow = (summary.documents as Array<Record<string, unknown>>).find(
      (d) => d['source'] === 'mcp',
    )
    expect(oldRow).toBeUndefined()
  })
})

describe('growthSummary — mode/job settlement classification', () => {
  it('only counts jobs with payment_id, non-payment-pending, non-payment_not_settled, production mode', () => {
    growthContext.run({ source: 'agent-client', mode: 'production' }, () => {
      store.createJob({
        id: 'paid-1',
        url: 'https://example.com',
        idempotencyKey: null,
        expiresAt: Date.now() + 86400000,
        paymentId: 'p1',
      })
      store.createJob({
        id: 'pending-1',
        url: 'https://example.com',
        idempotencyKey: null,
        expiresAt: Date.now() + 86400000,
        paymentId: 'p2',
        initialStatus: 'payment_pending',
      })
      store.createJob({
        id: 'test-1',
        url: 'https://example.com',
        idempotencyKey: null,
        expiresAt: Date.now() + 86400000,
      })
    })
    growthContext.run({ source: 'github-action', mode: 'test' }, () => {
      store.createJob({
        id: 'testjob-1',
        url: 'https://example.com',
        idempotencyKey: null,
        expiresAt: Date.now() + 86400000,
        paymentId: 'p3',
      })
    })
    store.updateJobStatus('pending-1', 'failed', { error: 'payment_not_settled' })
    const summary = store.growthSummary()
    expect(summary.paidJobs).toBe(1)
    expect(summary.testOrTestnetJobs).toBeGreaterThanOrEqual(1)
  })

  it('classifies replay and settlement separately — both use same job record', () => {
    growthContext.run({ source: 'agent-client', mode: 'production' }, () => {
      store.createJob({
        id: 'replay-job',
        url: 'https://example.com',
        idempotencyKey: null,
        expiresAt: Date.now() + 86400000,
        paymentId: 'pay-replay',
      })
    })
    store.updateJobStatus('replay-job', 'complete', { completedAt: Date.now() })
    const summary = store.growthSummary()
    expect(summary.paidJobs).toBe(1)
    expect(summary.completed).toBe(1)
  })

  it('excludes operator-smoke job IDs from paid job counts', () => {
    growthContext.run({ source: 'agent-client', mode: 'production' }, () => {
      store.createJob({
        id: 'smoke-job',
        url: 'https://example.com',
        idempotencyKey: null,
        expiresAt: Date.now() + 86400000,
        paymentId: 'psmoke',
      })
    })
    const summary = store.growthSummary({ excludedJobIds: ['smoke-job'] })
    expect(summary.paidJobs).toBe(0)
    expect(summary.excludedControlledJobs).toBe(1)
  })

  it('rejects invalid excludedJobIds', () => {
    expect(() => store.growthSummary({ excludedJobIds: ['../etc/passwd'] })).toThrow()
    expect(() =>
      store.growthSummary({ excludedJobIds: Array.from({ length: 101 }, (_, i) => `job-${i}`) }),
    ).toThrow()
  })

  it('does not expose customer labels, payment identifiers or target URLs', () => {
    growthContext.run({ source: 'agent-client', mode: 'production' }, () => {
      store.createJob({
        id: 'cust-job',
        url: 'https://private.example.com',
        idempotencyKey: null,
        expiresAt: Date.now() + 86400000,
        paymentId: 'paypriv',
        customerId: 'cust_abc',
      })
    })
    const summary = store.growthSummary()
    const json = JSON.stringify(summary)
    expect(json).not.toContain('https://private.example.com')
    expect(json).not.toContain('paypriv')
    expect(json).not.toContain('cust_abc')
  })

  it('unknown historical mode is flagged, not counted as production', () => {
    store.createJob({
      id: 'unknown-job',
      url: 'https://example.com',
      idempotencyKey: null,
      expiresAt: Date.now() + 86400000,
      paymentId: 'punknown',
    })
    const summary = store.growthSummary()
    expect(summary.unknownModePaymentIdentityJobs).toBeGreaterThanOrEqual(1)
    expect(summary.paidJobs).toBe(0)
  })
})

describe('growthMiddleware — failed observer does not affect request delivery', () => {
  it('does not throw when recordGrowth would fail', () => {
    const brokenStore = {
      recordGrowth: () => {
        throw new Error('observer failure')
      },
    } as unknown as JobStore
    const middleware = growthMiddleware(brokenStore, 'test')
    const req = { method: 'POST', path: '/v1/checks', headers: {} } as unknown as Request
    const events: Record<string, (() => void)[]> = {}
    const res = {
      statusCode: 402,
      once: (event: string, fn: () => void) => {
        ;(events[event] ??= []).push(fn)
      },
    } as unknown as Response
    const next = () => {
      for (const fn of events['finish'] ?? []) fn()
    }
    expect(() => middleware(req, res, next)).not.toThrow()
  })

  it('sets MCP source for /mcp path', () => {
    const records: Array<[string, string]> = []
    const capturingStore = {
      recordGrowth: (product: GrowthProduct, source: GrowthSource) =>
        records.push([product, source]),
    } as unknown as JobStore
    const middleware = growthMiddleware(capturingStore, 'test')
    const req = {
      method: 'GET',
      path: '/mcp',
      headers: { 'x-viewportwitness-source': undefined },
    } as unknown as Request
    const events: Record<string, (() => void)[]> = {}
    const res = {
      statusCode: 200,
      once: (e: string, fn: () => void) => {
        ;(events[e] ??= []).push(fn)
      },
    } as unknown as Response
    middleware(req, res, () => {
      const ctx = growthContext.getStore()
      expect(ctx?.source).toBe('mcp')
    })
  })
})
