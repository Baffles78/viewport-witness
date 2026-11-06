import { describe, expect, it } from 'vitest'
import { reconcileJobStatus } from '../src/job-reconciliation.js'
import type { JobStatus } from '../src/types.js'

describe('job reconciliation contract', () => {
  for (const status of ['payment_pending', 'queued', 'running', 'retryable'] as JobStatus[]) {
    it(`${status} keeps the caller on the same job`, () => {
      expect(reconcileJobStatus(status)).toEqual({
        jobStatus: status,
        nextAction: 'poll_same_job',
        retryAfterSeconds: 5,
      })
    })
  }

  it('a stored report asks the caller to inspect it', () => {
    expect(reconcileJobStatus('complete')).toEqual({
      jobStatus: 'complete',
      nextAction: 'inspect_report',
    })
  })

  it('a permanent failure stops without asking for a new paid job', () => {
    expect(reconcileJobStatus('failed')).toEqual({
      jobStatus: 'failed',
      nextAction: 'stop',
    })
  })
})
