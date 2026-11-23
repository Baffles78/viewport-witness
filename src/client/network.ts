export const SERVICE_ORIGIN = 'https://qa.honeygate.app'
export const BASE_RPC = 'https://mainnet.base.org'

/** Public diagnostic endpoints only; one total deadline and streaming size bound. */
export function diagnosticFetch(fetchFn: typeof fetch = fetch, timeoutMs = 10_000): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input))
    const service =
      url.origin === SERVICE_ORIGIN && ['/health', '/v1/checks'].includes(url.pathname)
    if (
      (!service && url.href !== `${BASE_RPC}/`) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('DIAGNOSTIC_ENDPOINT_INVALID')
    if (url.pathname === '/health' ? (init.method ?? 'GET') !== 'GET' : init.method !== 'POST')
      throw new Error('DIAGNOSTIC_METHOD_INVALID')
    if (typeof init.body === 'string' && Buffer.byteLength(init.body) > 4096)
      throw new Error('DIAGNOSTIC_REQUEST_LIMIT')
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('DIAGNOSTIC_TIMEOUT'))
      }, timeoutMs)
    })
    const work = async () => {
      const response = await fetchFn(url.href, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      })
      if (
        controller.signal.aborted ||
        response.redirected ||
        (response.url && response.url !== url.href)
      ) {
        void response.body?.cancel().catch(() => undefined)
        throw new Error('DIAGNOSTIC_RESPONSE_INVALID')
      }
      for (const name of ['payment-required', 'content-length']) {
        const value = response.headers.get(name)
        if (
          value &&
          (value.length > 65536 ||
            (name === 'content-length' && (!/^\d+$/.test(value) || Number(value) > 65536)))
        ) {
          void response.body?.cancel().catch(() => undefined)
          throw new Error('DIAGNOSTIC_RESPONSE_LIMIT')
        }
      }
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (response.body) {
        const reader = response.body.getReader()
        const cancel = () => {
          void reader.cancel().catch(() => undefined)
        }
        controller.signal.addEventListener('abort', cancel, { once: true })
        try {
          for (;;) {
            const { done, value } = await reader.read()
            controller.signal.throwIfAborted()
            if (done) break
            bytes += value.byteLength
            if (bytes > 65536) {
              cancel()
              throw new Error('DIAGNOSTIC_RESPONSE_LIMIT')
            }
            chunks.push(value)
          }
        } finally {
          controller.signal.removeEventListener('abort', cancel)
          reader.releaseLock()
        }
      }
      return new Response(bytes ? Buffer.concat(chunks, bytes) : null, {
        status: response.status,
        headers: response.headers,
      })
    }
    try {
      return await Promise.race([work(), deadline])
    } catch {
      throw new Error('DIAGNOSTIC_REQUEST_FAILED')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
