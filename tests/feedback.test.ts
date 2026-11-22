import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { JobStore } from '../src/db.js'
import { createApp } from '../src/api/index.js'
import { feedbackSchema, type Feedback } from '../src/feedback/schema.js'
import { makeConfig, makeMockRunner } from './helpers/mcp-server.js'

const sample: Feedback = {
  product: 'extract',
  reason: 'missing_capability',
  requestedChange: 'JavaScript rendered Markdown extraction',
  purchaseIntent: 'considering',
}
const limits = { retentionDays: 90, maxRecords: 5000, dailyLimit: 100 }
let store: JobStore
let server: http.Server | undefined

beforeEach(() => {
  store = new JobStore(':memory:')
  store.init()
})
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  store.close()
})

async function start(overrides = {}) {
  server = http.createServer(createApp(store, makeMockRunner(), makeConfig(overrides)))
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function post(base: string, data: unknown) {
  return fetch(`${base}/v1/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

describe('free feedback API', () => {
  it('works without payment or a job in production mode and deduplicates retries', async () => {
    const base = await start({ PAYMENT_MODE: 'production' })
    const res = await post(base, sample)
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ status: 'accepted', paymentRequired: false })
    expect(res.headers.get('payment-required')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    const retry = await post(base, { purchaseIntent: 'considering', ...sample })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ status: 'duplicate' })
    expect(store.feedback.summary()).toMatchObject({
      submissions: 1,
      groups: [{ mode: 'production', submissions: 1 }],
    })
  })

  it('exposes guidance/schema without publishing submissions', async () => {
    const base = await start()
    await post(base, sample)
    const guidance = await (await fetch(`${base}/v1/feedback`)).json()
    expect(guidance).toMatchObject({ paymentRequired: false, optional: true })
    expect(JSON.stringify(guidance)).not.toContain(sample.requestedChange)
    expect((await fetch(`${base}/v1/feedback/anything`)).status).toBe(404)
    const root = await (await fetch(base)).json()
    expect(root.agentFeedback).toBe('/v1/feedback')
    const api = await (await fetch(`${base}/openapi.json`)).json()
    expect(api.paths['/v1/feedback'].post.security).toEqual([])
    expect(api.components.schemas.FeedbackRequest.additionalProperties).toBe(false)
  })

  it('rejects invalid input without echoing or storing it', async () => {
    const base = await start()
    for (const data of [
      { ...sample, wallet: 'private detail' },
      { ...sample, maxPriceUsdc: -1 },
      { ...sample, reason: 'execute_this' },
      { ...sample, requestedChange: 'https://private.example' },
      { ...sample, requestedChange: 'private key abcdef' },
      {
        ...sample,
        requestedChange:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      { ...sample, requestedChange: 'a'.repeat(64) },
      {
        ...sample,
        requestedChange: '0123456789abcdef 0123456789abcdef 0123456789abcdef 0123456789abcdef',
      },
      { ...sample, requestedChange: 'private.example/account' },
      { ...sample, requestedChange: '192.168.1.1/account' },
      { ...sample, requestedChange: '<script>alert(1)</script>' },
      { ...sample, requestedChange: 'Need\nmore formats' },
      [],
      null,
    ]) {
      const res = await post(base, data)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid_feedback' })
    }
    expect(store.feedback.summary().submissions).toBe(0)
  })

  it('returns bounded JSON errors for malformed/oversized bodies', async () => {
    const base = await start()
    for (const [body, status] of [
      ['{', 400],
      [JSON.stringify({ text: 'x'.repeat(3000) }), 413],
    ] as const) {
      const res = await fetch(`${base}/v1/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      expect(res.status).toBe(status)
      expect(await res.json()).toMatchObject({ error: 'invalid_feedback' })
    }
    expect(store.feedback.summary().submissions).toBe(0)
  })

  it('enforces a global quota and accepts duplicate retries without consuming it', async () => {
    const base = await start({ FEEDBACK_DAILY_LIMIT: 1 })
    expect((await post(base, sample)).status).toBe(201)
    expect((await post(base, sample)).status).toBe(200)
    const rejected = await post(base, { ...sample, requestedChange: 'Batch extraction' })
    expect(rejected.status).toBe(429)
    expect(rejected.headers.get('retry-after')).toBe('86400')
    expect(store.feedback.summary().submissions).toBe(1)
  })

  it('reports failed storage without acknowledging a saved submission', async () => {
    const base = await start()
    store.close()
    const response = await post(base, sample)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'feedback_unavailable' })
  })
})

describe('feedback retention and owner summary', () => {
  it('isolates test suggestions, bounds storage and expires records', () => {
    const now = Date.now()
    expect(store.feedback.submit(sample, 'test', limits, now).status).toBe('accepted')
    expect(store.feedback.submit(sample, 'production', limits, now).status).toBe('accepted')
    expect(
      store.feedback
        .summary(now)
        .groups.map((x) => x.mode)
        .sort(),
    ).toEqual(['production', 'test'])
    expect(
      store.feedback.submit(
        { ...sample, reason: 'price' },
        'production',
        { ...limits, maxRecords: 2 },
        now,
      ).status,
    ).toBe('limited')
    expect(store.feedback.summary(now + 90 * 86_400_000).submissions).toBe(0)
    store.feedback.prune(now + 90 * 86_400_000)
    expect(
      store.feedback.submit(
        sample,
        'production',
        { ...limits, maxRecords: 1 },
        now + 90 * 86_400_000,
      ).status,
    ).toBe('accepted')
  })

  it('does not treat old suggestions or claimed purchase intent as sales', () => {
    const now = Date.now()
    store.feedback.submit(
      { ...sample, purchaseIntent: 'would_buy', maxPriceUsdc: 0.03 },
      'production',
      limits,
      now - 31 * 86_400_000,
    )
    store.feedback.submit(sample, 'production', limits, now)
    expect(store.feedback.summary(now).submissions).toBe(1)
    expect(store.feedback.summary(now).limitations.join(' ')).toContain('not instructions')
  })

  it('summarizes capabilities and price suggestions beyond the latest twenty', () => {
    const now = Date.now()
    store.feedback.submit(
      { ...sample, requestedChange: 'PDF export', maxPriceUsdc: 0.02 },
      'production',
      limits,
      now - 1000,
    )
    store.feedback.submit(
      { ...sample, requestedChange: 'PDF export', maxPriceUsdc: 0.05 },
      'production',
      limits,
      now - 999,
    )
    for (let i = 0; i < 21; i++) {
      store.feedback.submit(
        { ...sample, requestedChange: `Batch export option ${i}` },
        'production',
        limits,
        now,
      )
    }
    const summary = store.feedback.summary(now)
    expect(summary.recent).toHaveLength(20)
    expect(summary.requestedCapabilities[0]).toMatchObject({
      requestedChange: 'pdf export',
      submissions: 2,
      priceSuggestionCount: 2,
      minSuggestedPriceUsdc: 0.02,
      maxSuggestedPriceUsdc: 0.05,
    })
    expect(summary.submissions).toBe(23)
  })

  it('persists across restart and supports a read-only owner summary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-feedback-'))
    const file = path.join(dir, 'vw.db')
    const disk = new JobStore(file)
    try {
      disk.init()
      disk.feedback.submit(sample, 'production', limits)
      disk.close()
      disk.init({ readOnly: true })
      expect(disk.feedback.summary().submissions).toBe(1)
      expect(() =>
        disk.feedback.submit({ ...sample, reason: 'price' }, 'production', limits),
      ).toThrow()
    } finally {
      disk.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts useful short requests but rejects seed-length text and key-like strings', () => {
    expect(feedbackSchema.safeParse({ ...sample, purchaseIntent: 'not_stated' }).success).toBe(true)
    for (const requestedChange of [
      'PDF export',
      'Custom viewport sizes',
      'Faster batch checks',
      'OAuth login support',
    ]) {
      expect(feedbackSchema.safeParse({ ...sample, requestedChange }).success).toBe(true)
    }
    expect(
      feedbackSchema.safeParse({
        ...sample,
        requestedChange: 'one two three four five six seven eight nine ten eleven twelve',
      }).success,
    ).toBe(false)
    expect(feedbackSchema.safeParse({ ...sample, maxPriceUsdc: Infinity }).success).toBe(false)
  })
})
