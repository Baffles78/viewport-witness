import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { Response } from 'express'
import { JobStore } from '../src/db.js'
import { claimPaidAdmission } from '../src/idempotency-replay.js'
import type { Config } from '../src/config.js'

const stores: JobStore[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function databasePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-admission-'))
  dirs.push(dir)
  return path.join(dir, 'jobs.db')
}

function openStore(dbPath: string) {
  const store = new JobStore(dbPath)
  store.init()
  stores.push(store)
  return store
}

function response() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    status: vi.fn(function (this: { statusCode: number }, code: number) {
      this.statusCode = code
      return this
    }),
    json: vi.fn(),
  })
  return res as unknown as Response & EventEmitter
}

describe('durable paid admission', () => {
  const cfg = { PAYMENT_MODE: 'production' } as Config

  it('claims one key across two store instances and retains uncertainty after restart', async () => {
    const dbPath = await databasePath()
    const first = openStore(dbPath)
    const second = openStore(dbPath)
    expect(first.claimPaymentAdmission('same-key')).toBe(true)
    expect(second.claimPaymentAdmission('same-key')).toBe(false)
    first.close()
    stores.splice(stores.indexOf(first), 1)
    const restarted = openStore(dbPath)
    expect(restarted.claimPaymentAdmission('same-key')).toBe(false)
    restarted.releasePaymentAdmission('same-key')
    expect(second.claimPaymentAdmission('same-key')).toBe(true)
  })

  it('keeps the shared claim after disconnect and rejects a cross-route retry before payment', async () => {
    const dbPath = await databasePath()
    const checksStore = openStore(dbPath)
    const verifyStore = openStore(dbPath)
    const disconnected = response()
    expect(claimPaidAdmission(checksStore, 'shared', disconnected, cfg)).toBe(true)
    disconnected.emit('close')

    const retry = response()
    expect(claimPaidAdmission(verifyStore, 'shared', retry, cfg)).toBe(false)
    expect(retry.status).toHaveBeenCalledWith(409)
    expect(retry.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'idempotency_outcome_unknown', nextAction: 'stop',
    }))
  })

  it('releases only a completed accepted response', async () => {
    const store = openStore(await databasePath())
    const rejected = response()
    expect(claimPaidAdmission(store, 'retry', rejected, cfg)).toBe(true)
    rejected.statusCode = 402
    rejected.emit('finish')
    expect(store.claimPaymentAdmission('retry')).toBe(false)

    const accepted = response()
    expect(claimPaidAdmission(store, 'accepted', accepted, cfg)).toBe(true)
    accepted.statusCode = 202
    accepted.emit('finish')
    expect(store.claimPaymentAdmission('accepted')).toBe(true)
  })
})
