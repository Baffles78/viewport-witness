import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { JobStore } from '../src/db.js'
import { growthContext, growthMiddleware, type GrowthSource } from '../src/growth.js'
import { quickstartClientHeaders, quickstartRunHash } from '../src/quickstart-attribution.js'
import { createInfoRouter } from '../src/api/routes/info.js'
import { makeConfig, makeRunner } from './helpers/info-server.js'
// @ts-expect-error JavaScript CLI helper under test.
import { quickstartUsage } from '../scripts/lib/quickstart-usage.mjs'

let dir: string
let store: JobStore
let servers: Server[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-funnel-'))
  store = new JobStore(path.join(dir, 'test.db'))
  store.init()
})
afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  servers = []
  store.close()
  await fs.rm(dir, { recursive: true, force: true })
})
function purchase(
  run: string | undefined,
  id: string,
  customer: string,
  source: GrowthSource = 'agent-client',
  pending = false,
) {
  growthContext.run(
    { mode: 'production', source, ...(run ? { quickstartRunHash: run } : {}) },
    () => {
      store.createJob({
        id,
        url: 'https://example.com',
        idempotencyKey: null,
        expiresAt: Date.now() + 86400000,
        paymentId: `pay-${id}`,
        customerId: customer,
        ...(pending ? { initialStatus: 'payment_pending' as const } : {}),
      })
    },
  )
}
describe('quickstart funnel', () => {
  it('seeds retained settled history once so an existing payer is not called new', () => {
    purchase(undefined, 'prior', 'existing-payer')
    const db = new DatabaseSync(path.join(dir,'test.db'))
    db.exec('DROP TABLE quickstart_runs; DROP TABLE quickstart_jobs; DROP TABLE quickstart_meta'); db.close()
    store.close(); store.init()
    const run = quickstartRunHash(randomUUID())!
    store.quickstart.start(run,'agent-client','production'); purchase(run,'later','existing-payer')
    expect(store.quickstart.summary()).toMatchObject({ startedRuns:1,purchasedRuns:1,firstObservedPurchaseRuns:0 })
    const before = store.quickstart.summary()
    store.close(); store.init()
    expect(store.quickstart.summary()).toEqual(before)
  })

  it('bounds anonymous starts and preserves capacity-loss diagnostics after pruning', () => {
    const now=Date.now(), db = new DatabaseSync(path.join(dir,'test.db'))
    db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO quickstart_runs SELECT 'bounded-'||x,? FROM n`).run(now)
    const run=quickstartRunHash(randomUUID())!
    store.quickstart.start(run,'agent-client','production',now)
    expect(store.quickstart.summary({now})).toMatchObject({ startedRuns:10000,capacityReached:true,capacityDrops:1 })
    db.exec('DELETE FROM quickstart_runs'); db.close()
    expect(store.quickstart.summary()).toMatchObject({ startedRuns:0,capacityReached:true,capacityDrops:1 })
  })
  it('waits for authoritative settlement, preserves unknown attempts and deduplicates settlement replay', () => {
    const run = quickstartRunHash(randomUUID())!
    store.quickstart.start(run, 'agent-client', 'production')
    growthContext.run(
      { source: 'agent-client', mode: 'production', quickstartRunHash: run },
      () => {
        expect(
          store.admitPaymentAttempt({
            id: 'settlement',
            url: 'https://example.com',
            kind: 'check',
            request: {},
            paymentId: 'pid_test',
            customerId: 'payer',
            network: 'eip155:8453',
            expiresAt: Date.now() + 86400000,
            unresolvedLimit: 10,
          }),
        ).toEqual({ admitted: true })
      },
    )
    store.markSettlementUnknown('settlement', 'fixture-uncertain')
    expect(store.quickstart.summary()).toMatchObject({ purchasedRuns: 0 })
    expect(
      store.recordSettlement('settlement', { network: 'eip155:8453', transaction: 'fixture-tx' }),
    ).toBe(true)
    store.recordSettlement('settlement', { network: 'eip155:8453', transaction: 'fixture-tx' })
    expect(store.quickstart.summary()).toMatchObject({
      purchasedRuns: 1,
      firstObservedPurchaseRuns: 1,
    })
  })
  it('deduplicates runs and purchases, separates first observed payers and completed reports', () => {
    const a = quickstartRunHash(randomUUID())!,
      b = quickstartRunHash(randomUUID())!
    store.quickstart.start(a, 'agent-client', 'production')
    store.quickstart.start(a, 'agent-client', 'production')
    purchase(a, 'first', 'private-payer')
    purchase(a, 'retry', 'private-payer')
    store.updateJobStatus('first', 'complete')
    store.quickstart.start(b, 'agent-client', 'production')
    purchase(b, 'repeat', 'private-payer')
    expect(store.quickstart.summary()).toMatchObject({
      available: true,
      startedRuns: 2,
      purchasedRuns: 2,
      firstObservedPurchaseRuns: 1,
      completedReportRuns: 1,
      purchaseRate: 1,
    })
    expect(JSON.stringify(store.quickstart.summary())).not.toContain('private-payer')
    expect(JSON.stringify(store.quickstart.summary())).not.toContain(a)
  })
  it('excludes monitor, test-client, test modes and known controlled runs on both sides', () => {
    const real = quickstartRunHash(randomUUID())!,
      controlled = quickstartRunHash(randomUUID())!
    for (const source of ['monitor', 'test-client'] as const) {
      const run = quickstartRunHash(randomUUID())!
      store.quickstart.start(run, source, 'production')
      purchase(run, source, 'operator', source)
    }
    store.quickstart.start(quickstartRunHash(randomUUID()), 'agent-client', 'test')
    store.quickstart.start(quickstartRunHash(randomUUID()), 'agent-client', 'testnet')
    store.quickstart.start(controlled, 'agent-client', 'production')
    purchase(controlled, 'controlled', 'shared')
    store.quickstart.start(real, 'agent-client', 'production')
    purchase(real, 'real', 'shared')
    expect(store.quickstart.summary({ excludedJobIds: ['controlled'] })).toMatchObject({
      startedRuns: 1,
      purchasedRuns: 1,
      firstObservedPurchaseRuns: 1,
    })
  })
  it('does not treat a pending attempt as a purchase, and preserves proof after job deletion', () => {
    const run = quickstartRunHash(randomUUID())!
    store.quickstart.start(run, 'agent-client', 'production')
    purchase(run, 'pending', 'payer', 'agent-client', true)
    expect(store.quickstart.summary()).toMatchObject({ startedRuns: 1, purchasedRuns: 0 })
    store.activatePaymentPendingJob('pending')
    store.updateJobStatus('pending', 'complete')
    const db = new DatabaseSync(path.join(dir, 'test.db'))
    db.exec("PRAGMA foreign_keys=ON; DELETE FROM jobs WHERE id='pending'")
    db.close()
    expect(store.quickstart.summary()).toMatchObject({ purchasedRuns: 1, completedReportRuns: 1 })
    expect(store.quickstart.summary({ excludedJobIds: ['pending'] })).toMatchObject({
      startedRuns: 0,
      purchasedRuns: 0,
    })
  })
  it('handles retention, bounded capacity, missing tables and analytics failure honestly', () => {
    const now = Date.now(),
      old = quickstartRunHash(randomUUID())!
    store.quickstart.start(old, 'agent-client', 'production', now - 31 * 86400000)
    expect(store.quickstart.summary()).toMatchObject({ startedRuns: 0, purchaseRate: null })
    const db = new DatabaseSync(path.join(dir, 'test.db'))
    db.exec('DROP TABLE quickstart_runs')
    db.close()
    expect(() => store.quickstart.start(old, 'agent-client', 'production')).not.toThrow()
    expect(store.quickstart.summary()).toMatchObject({ available: false })
    expect(() => purchase(old, 'unblocked', 'payer')).not.toThrow()
    expect(store.getJob('unblocked')).not.toBeNull()
  })
  it('tracks only real successful redirects and valid production challenge runs', async () => {
    const app = express()
    app.use(growthMiddleware(store, 'production'))
    app.use(createInfoRouter(store, makeRunner(), makeConfig()))
    app.post('/v1/checks', (_req, res) => {
      res.status(402).json({})
    })
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('No port')
    const base = `http://127.0.0.1:${address.port}`
    for (const source of ['unknown', 'monitor', 'test-client']) {
      const response = await fetch(base + '/quickstart?next=https://evil.invalid', {
        redirect: 'manual',
        headers: { 'X-ViewportWitness-Source': source },
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(
        'https://github.com/Baffles78/viewport-witness/blob/main/docs/QUICKSTART.md',
      )
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const run = randomUUID()
    for (const token of [run, run, 'not-a-uuid'])
      await fetch(base + '/v1/checks', {
        method: 'POST',
        headers: {
          'X-ViewportWitness-Source': 'agent-client',
          'X-ViewportWitness-Quickstart-Run': token,
        },
      })
    await new Promise((resolve) => setImmediate(resolve))
    expect(store.quickstart.summary()).toMatchObject({
      quickstartOpens: 1,
      startedRuns: 1,
      purchasedRuns: 0,
    })
  })
  it('persists anonymous usage identity, supports opt-out, and drops unsafe stored data', async () => {
    const a = await quickstartUsage(dir, {}),
      b = await quickstartUsage(dir, {})
    expect(a).toEqual(b)
    expect(quickstartRunHash(a.runId)).toBeDefined()
    expect(
      await quickstartUsage(dir, {
        VW_DISABLE_USAGE_TRACKING: '1',
        VW_USAGE_SOURCE: 'test-client',
      }),
    ).toEqual({ source: 'test-client' })
    await fs.writeFile(path.join(dir, 'quickstart-usage.json'), '{"schema":"wrong","id":"secret"}')
    expect(await quickstartUsage(dir, {})).toEqual({ source: 'agent-client' })
    expect(quickstartClientHeaders('secret', 'forged')).toEqual({
      'x-viewportwitness-source': 'agent-client',
    })
  })
})
