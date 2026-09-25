import { parentPort, workerData } from 'node:worker_threads'
import { buildExtractReport, buildSecurityReport, type BoundedHtml } from './web-products.js'
import type { PaymentMode } from './types.js'

interface WorkerInput {
  kind: 'extract' | 'security'
  id: string
  createdAt: number
  expiresAt: number
  paymentMode: PaymentMode
  maxOutputTokens: number
  fetched: Omit<BoundedHtml, 'headers'> & {
    headers: Array<[string, string]>
    setCookies: string[]
  }
}

try {
  const input = workerData as WorkerInput
  const headers = new Headers(input.fetched.headers)
  for (const cookie of input.fetched.setCookies) headers.append('set-cookie', cookie)
  const fetched: BoundedHtml = { ...input.fetched, headers }
  const report =
    input.kind === 'extract'
      ? buildExtractReport(
          input.id,
          input.createdAt,
          input.expiresAt,
          input.paymentMode,
          fetched,
          input.maxOutputTokens,
        )
      : buildSecurityReport(input.id, input.createdAt, input.expiresAt, input.paymentMode, fetched)
  parentPort?.postMessage({ ok: true, report })
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message.slice(0, 300) : 'parser_failed',
  })
}
