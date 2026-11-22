import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { JobStore } from '../src/db.js'
import type { Config } from '../src/config.js'
import { createAnnotationsRouter } from '../src/api/routes/annotations.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe('annotated evidence retrieval', () => {
  it('serves only completed unexpired browser derivatives and validates viewport and path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-annotation-route-'))
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }))
    await fs.mkdir(path.join(dir, 'job'))
    const data = Buffer.from('PNG fixture')
    await fs.writeFile(path.join(dir, 'job', 'annotations-desktop.png'), data)
    let job = { id: 'job', kind: 'check', status: 'complete', expiresAt: Date.now() + 60_000 }
    const store = { getJob: (id: string) => (id === 'missing' ? null : job) }
    const app = express().use(
      createAnnotationsRouter(
        store as unknown as JobStore,
        {
          SCREENSHOTS_DIR: dir,
        } as Config,
      ),
    )
    const server: Server = app.listen(0, '127.0.0.1')
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/checks`
    const ok = await fetch(`${base}/job/annotations/desktop`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toContain('image/png')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(data)
    expect((await fetch(`${base}/job/annotations/unknown`)).status).toBe(400)
    expect((await fetch(`${base}/missing/annotations/desktop`)).status).toBe(404)
    expect((await fetch(`${base}/job/annotations/phonePortrait`)).status).toBe(404)
    for (const mutation of [
      { expiresAt: Date.now() - 1 },
      { status: 'running' },
      { kind: 'extract' },
      { kind: 'security' },
      { id: '../outside' },
    ]) {
      const original = job
      job = { ...job, ...mutation }
      expect((await fetch(`${base}/job/annotations/desktop`)).status).toBe(404)
      job = original
    }
  })
})
