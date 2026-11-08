import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JobStore } from '../src/db.js'
import { runReconcile } from '../src/payment-reconcile-cli.js'

let dir: string
let store: JobStore
const ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vw-reconcile-'))
  store = new JobStore(path.join(dir, 'vw.db'))
  store.init()
  store.admitPaymentAttempt({
    id: ID, url: 'https://example.com', kind: 'check', request: {},
    idempotencyKey: 'cli-key', paymentId: 'cli-p', network: 'eip155:8453',
    expiresAt: Date.now() + 60_000, unresolvedLimit: 5,
  })
  store.markSettlementUnknown(ID, 'timeout')
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function run(argv: string[]): { code: number; lines: string[] } {
  const lines: string[] = []
  const code = runReconcile(argv, store, (l) => lines.push(l))
  return { code, lines }
}

describe('payment reconcile CLI', () => {
  it('lists unresolved payments without payment payloads', () => {
    const { code, lines } = run(['list'])
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0]!)
    expect(row).toMatchObject({ id: ID, state: 'unknown', network: 'eip155:8453', idempotencyKeyBound: true })
    expect(lines[0]).not.toContain('cli-p')
  })

  it('records a settlement once and queues the original job', () => {
    expect(run(['settled', ID, '--tx', 'short']).code).toBe(2)
    const ok = run(['settled', ID, '--tx', '0x' + 'a'.repeat(64)])
    expect(ok.code).toBe(0)
    expect(store.getJob(ID)).toMatchObject({ status: 'queued', settlementState: 'settled' })
    expect(run(['settled', ID, '--tx', '0x' + 'a'.repeat(64)]).code).toBe(1)
    expect(run(['list']).lines).toEqual(['No unresolved payments.'])
  })

  it('requires substantive evidence before releasing the key', () => {
    expect(run(['unpaid', ID]).code).toBe(2)
    expect(run(['unpaid', ID, '--evidence', 'timeout']).code).toBe(2)
    expect(store.getJobByIdempotencyKey('cli-key')?.id).toBe(ID)
    const ok = run(['unpaid', ID, '--evidence', 'authorizationState unused after validBefore 2026-11-08T22:00Z'])
    expect(ok.code).toBe(0)
    expect(store.getJobByIdempotencyKey('cli-key')).toBeNull()
    expect(store.getJob(ID)).toMatchObject({ status: 'failed', settlementState: 'rejected' })
  })

  it('rejects unknown commands and jobs', () => {
    expect(run(['bogus', ID]).code).toBe(2)
    expect(run(['settled', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '--tx', '0x' + 'b'.repeat(64)]).code).toBe(1)
  })
  it('refuses to act on a payment that is still settling', () => {
    const id = '12121212-1212-4121-8121-121212121212'
    store.admitPaymentAttempt({
      id, url: 'https://example.com', kind: 'check', request: {},
      paymentId: 'cli-settling', network: 'eip155:8453', expiresAt: Date.now() + 60_000, unresolvedLimit: 5,
    })
    expect(run(['unpaid', id, '--evidence', 'authorizationState unused after validBefore']).code).toBe(1)
    expect(run(['settled', id, '--tx', '0x' + 'c'.repeat(64)]).code).toBe(1)
    expect(store.getJob(id)).toMatchObject({ status: 'payment_pending', settlementState: 'settling' })
  })
})
