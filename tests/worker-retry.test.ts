import { describe, expect, it } from 'vitest'
import { WorkerRunner } from '../src/worker/runner.js'
import type { JobStore } from '../src/db.js'

async function timeoutOnce(initialRetries: number) {
  const job = { id: 'job-1', status: 'queued', retryCount: initialRetries }
  const store = {
    getJob: () => job,
    updateJobStatus: (_id: string, status: string) => { job.status = status },
    markJobRetryable: () => { job.status = 'retryable'; job.retryCount++ },
  } as unknown as JobStore
  const runner = new WorkerRunner(store, '/tmp', 1, 'test')
  const internal = runner as unknown as {
    runJob: (_item: unknown, signal: AbortSignal) => Promise<never>
    runJobWithTimeout: (item: { jobId: string; paymentMode: string }) => Promise<void>
    queue: unknown[]
  }
  internal.runJob = (_item, signal) => new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('job_aborted')), { once: true })
  })
  await internal.runJobWithTimeout({ jobId: job.id, paymentMode: 'test' })
  return { job, queueLength: internal.queue.length }
}

describe('bounded internal retry', () => {
  it('requeues the same job after its first timeout', async () => {
    const result = await timeoutOnce(0)
    expect(result.job.status).toBe('retryable')
    expect(result.job.retryCount).toBe(1)
    expect(result.queueLength).toBe(1)
  })

  it('marks the same job permanently failed after retry exhaustion', async () => {
    const result = await timeoutOnce(1)
    expect(result.job.status).toBe('failed')
    expect(result.job.retryCount).toBe(2)
    expect(result.queueLength).toBe(0)
  })
})

describe('non-cooperative abort', () => {
  it('fails boundedly without overlapping a retry', async () => {
    const job = { id: 'stuck-job', status: 'queued', retryCount: 0, error: '' }
    const store = {
      getJob: () => job,
      updateJobStatus: (_id: string, status: string, fields?: { error?: string }) => {
        job.status = status
        job.error = fields?.error ?? ''
      },
      markJobRetryable: () => { job.status = 'retryable'; job.retryCount++ },
    } as unknown as JobStore
    const runner = new WorkerRunner(store, '/tmp', 1, 'test')
    const internal = runner as unknown as {
      runJob: () => Promise<never>
      runJobWithTimeout: (item: { jobId: string; paymentMode: string }) => Promise<void>
      queue: unknown[]
    }
    internal.runJob = () => new Promise<never>(() => undefined)
    const startedAt = Date.now()
    await internal.runJobWithTimeout({ jobId: job.id, paymentMode: 'test' })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(job.status).toBe('failed')
    expect(job.error).toBe('job_abort_unresponsive')
    expect(internal.queue).toHaveLength(0)
    await expect(runner.enqueue('another-job')).rejects.toThrow('Worker is shutting down')
  })
})
