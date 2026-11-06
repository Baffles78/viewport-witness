import type { JobStatus } from './types.js'

export type ReconcileAction = 'poll_same_job' | 'inspect_report' | 'stop'

export function reconcileJobStatus(status: JobStatus): {
  jobStatus: JobStatus
  nextAction: ReconcileAction
  retryAfterSeconds?: number
} {
  if (status === 'complete') return { jobStatus: status, nextAction: 'inspect_report' }
  if (status === 'failed') return { jobStatus: status, nextAction: 'stop' }
  return { jobStatus: status, nextAction: 'poll_same_job', retryAfterSeconds: 5 }
}
