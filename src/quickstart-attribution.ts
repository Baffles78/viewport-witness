import { createHash } from 'node:crypto'

export function quickstartRunHash(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    return
  return createHash('sha256')
    .update('quickstart/v1:' + value.toLowerCase())
    .digest('hex')
}

export function quickstartClientHeaders(runId?: string, source?: string): Record<string, string> {
  return {
    'x-viewportwitness-source':
      source === 'monitor' || source === 'test-client' ? source : 'agent-client',
    ...(quickstartRunHash(runId) ? { 'x-viewportwitness-quickstart-run': runId! } : {}),
  }
}
