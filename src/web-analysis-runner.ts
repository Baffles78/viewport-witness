import { Worker } from 'node:worker_threads'
import type { BoundedHtml } from './web-products.js'
import type { JobKind, PaymentMode, StoredReport } from './types.js'

interface AnalysisParams {
  kind: Extract<JobKind, 'extract' | 'security'>
  id: string
  createdAt: number
  expiresAt: number
  paymentMode: PaymentMode
  fetched: BoundedHtml
  maxOutputTokens: number
}

export async function runBoundedWebAnalysis(
  params: AnalysisParams,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<StoredReport> {
  if (signal.aborted) throw new Error('job_aborted')
  if (timeoutMs <= 0) throw new Error('parser_timeout')
  const sourceMode = import.meta.url.endsWith('.ts')
  const headerEntries: Array<[string, string]> = []
  params.fetched.headers.forEach((value, name) => headerEntries.push([name, value]))
  const workerUrl = new URL(
    sourceMode ? './web-parser-worker.ts' : './web-parser-worker.js',
    import.meta.url,
  )
  const worker = new Worker(workerUrl, {
    workerData: {
      ...params,
      fetched: {
        ...params.fetched,
        headers: headerEntries,
        setCookies:
          typeof params.fetched.headers.getSetCookie === 'function'
            ? params.fetched.headers.getSetCookie()
            : [],
      },
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 96,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
    ...(sourceMode ? { execArgv: ['--import', 'tsx'] } : {}),
  })

  return await new Promise<StoredReport>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = (): void => {
      void worker.terminate()
      finish(() => reject(new Error(signal.aborted ? 'job_aborted' : 'parser_timeout')))
    }
    const timeout = setTimeout(() => {
      void worker.terminate()
      finish(() => reject(new Error('parser_timeout')))
    }, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (message: { ok: boolean; report?: StoredReport; error?: string }) => {
      void worker.terminate()
      if (message.ok && message.report) finish(() => resolve(message.report as StoredReport))
      else finish(() => reject(new Error(message.error ?? 'parser_failed')))
    })
    worker.once('error', (error) => {
      finish(() => reject(new Error(`parser_resource_failure:${error.message}`)))
    })
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error('parser_resource_failure')))
    })
  })
}
