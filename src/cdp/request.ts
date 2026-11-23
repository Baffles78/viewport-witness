import { CDP_REQUEST_BYTES } from './json.js'

export const CDP_API_ORIGIN = 'https://api.cdp.coinbase.com'
export const CDP_RESPONSE_BYTES = 64 * 1024
export const CDP_REQUEST_TIMEOUT_MS = 10_000

/** Fixed CDP account endpoints only. One attempt includes body consumption in its deadline. */
export async function requestCdpJson(
  endpoint: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: string | undefined,
  fetchFn: typeof fetch = fetch,
  timeoutMs = CDP_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  if (
    !['GET', 'POST'].includes(method) ||
    (body !== undefined &&
      (typeof body !== 'string' || Buffer.byteLength(body) > CDP_REQUEST_BYTES)) ||
    endpoint.origin !== CDP_API_ORIGIN ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    !/^\/platform\/v2\/evm\/accounts\/0x[a-fA-F0-9]{40}(?:\/sign\/typed-data)?$/.test(
      endpoint.pathname,
    ) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > CDP_REQUEST_TIMEOUT_MS
  )
    throw new Error('CDP request is not supported.')
  if (
    (method === 'POST') !== endpoint.pathname.endsWith('/sign/typed-data') ||
    (method === 'POST') !== (body !== undefined)
  )
    throw new Error('CDP request is not supported.')
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('cdp_timeout'))
    }, timeoutMs)
  })
  const work = async (): Promise<Record<string, unknown>> => {
    const response = await fetchFn(endpoint.href, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'error',
      signal: controller.signal,
    })
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error('cdp_timeout')
    }
    const declaredLength = response.headers.get('content-length')
    if (
      !response.ok ||
      response.redirected ||
      (response.url && new URL(response.url).href !== endpoint.href) ||
      (declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > CDP_RESPONSE_BYTES))
    ) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error('cdp_response_rejected')
    }
    if (!response.body) throw new Error('cdp_empty_response')
    const reader = response.body.getReader()
    const cancel = () => {
      void reader.cancel().catch(() => undefined)
    }
    controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        controller.signal.throwIfAborted()
        if (done) break
        bytes += value.byteLength
        if (bytes > CDP_RESPONSE_BYTES) {
          cancel()
          throw new Error('cdp_response_limit')
        }
        chunks.push(value)
      }
      const json: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
      if (!json || typeof json !== 'object' || Array.isArray(json))
        throw new Error('cdp_invalid_response')
      return json as Record<string, unknown>
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      reader.releaseLock()
    }
  }
  try {
    return await Promise.race([work(), timeout])
  } catch {
    throw new Error(
      'CDP account request failed or is uncertain; do not retry signing automatically.',
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}
