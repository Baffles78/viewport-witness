import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'
import { createChecksRouter } from '../src/api/routes/checks.js'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import type { WorkerRunner } from '../src/worker/runner.js'
import type { JobStatus } from '../src/types.js'

const servers: http.Server[] = []
const id = '11111111-1111-4111-8111-111111111111'

async function getJobStatus(status: JobStatus | null) {
  const store = {
    getJob: () => status ? {
      id,
      status,
      createdAt: Date.now(),
      reportPath: null,
    } : null,
  } as unknown as JobStore
  const runner = {} as WorkerRunner
  const cfg = { PAYMENT_MODE: 'test', SCREENSHOTS_DIR: '/tmp', RETENTION_DAYS: 7 } as Config
  const app = express()
  app.use(createChecksRouter(store, runner, cfg, (_req, _res, next) => next()))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const response = await fetch(`http://127.0.0.1:${port}/v1/checks/${id}`)
  return { code: response.status, body: await response.json() as Record<string, unknown> }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve())),
  ))
})

describe('HTTP same-job reconciliation', () => {
  for (const status of ['payment_pending', 'queued', 'running', 'retryable'] as JobStatus[]) {
    it(`${status} keeps the original poll URL`, async () => {
      const response = await getJobStatus(status)
      expect(response.code).toBe(200)
      expect(response.body).toMatchObject({
        id,
        status,
        jobStatus: status,
        nextAction: 'poll_same_job',
        pollUrl: `/v1/checks/${id}`,
        retryAfterSeconds: 5,
      })
    })
  }

  it('permanent failure stops', async () => {
    const response = await getJobStatus('failed')
    expect(response.body).toMatchObject({
      id,
      status: 'failed',
      jobStatus: 'failed',
      nextAction: 'stop',
    })
  })

  it('missing or expired job ID stops without a repayment signal', async () => {
    const response = await getJobStatus(null)
    expect(response.code).toBe(404)
    expect(response.body).toMatchObject({ error: 'not_found', nextAction: 'stop' })
  })
})
