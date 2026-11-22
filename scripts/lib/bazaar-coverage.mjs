const API = 'https://api.cdp.coinbase.com/platform/v2/x402'
export const PRODUCT_PATHS = ['/v1/checks', '/v1/verify', '/v1/compare', '/v1/extract', '/v1/security-gate']

export async function discoveryJson(url, options = {}, fetchFn = fetch) {
  const response = await fetchFn(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'x-viewportwitness-source': 'monitor', ...options.headers },
  })
  if (!response.ok) throw new Error(`Discovery request returned HTTP ${response.status}`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Discovery response body is unavailable')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) throw new Error('Discovery response exceeds 2 MiB')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

/** Catalog membership is separate from ranked search visibility. No payment. */
export async function merchantCoverage(baseUrl, addresses, fetchFn = fetch) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/') {
    throw new Error('Catalog checks require an HTTPS service origin without credentials')
  }
  const payTos = [...new Set(addresses)]
  if (!payTos.length || payTos.length > 4 || payTos.some(a => typeof a !== 'string' || !/^[a-zA-Z0-9]{1,128}$/.test(a))) {
    throw new Error('Expected one to four public merchant addresses')
  }
  const resources = new Set()
  let complete = true
  let pages = 0
  for (const payTo of payTos) {
    let offset = 0
    let expectedTotal
    let addressComplete = false
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${API}/discovery/merchant`)
      url.search = new URLSearchParams({ payTo, limit: '100', offset: String(offset) }).toString()
      const body = await discoveryJson(url.href, {}, fetchFn)
      pages++
      const pagination = body.pagination
      if (!Array.isArray(body.resources) || body.resources.length > 100 ||
          !pagination || pagination.offset !== offset ||
          !Number.isSafeInteger(pagination.total) || pagination.total < 0 ||
          !Number.isSafeInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 100 ||
          body.resources.length > pagination.limit || offset + body.resources.length > pagination.total ||
          (expectedTotal !== undefined && pagination.total !== expectedTotal)) {
        throw new Error('Merchant pagination response is incomplete or malformed')
      }
      expectedTotal = pagination.total
      for (const item of body.resources) {
        let candidate
        try {
          if (!item || typeof item.resource !== 'string') throw new Error('invalid_resource')
          candidate = new URL(item.resource)
          if (candidate.protocol !== 'https:' || candidate.username || candidate.password) throw new Error('invalid_resource')
        } catch { throw new Error('Merchant resource record is malformed; catalog coverage is unknown') }
        if (candidate.origin === base.origin && !candidate.search && !candidate.hash) resources.add(candidate.href)
      }
      const consumed = offset + body.resources.length
      if (consumed >= pagination.total) { addressComplete = true; break }
      if (!body.resources.length || body.resources.length < pagination.limit) break
      offset += body.resources.length
    }
    complete &&= addressComplete
  }
  const found = PRODUCT_PATHS.filter(path => resources.has(base.origin + path))
  const unseen = PRODUCT_PATHS.filter(path => !resources.has(base.origin + path))
  return {
    complete, pages, found,
    missing: complete ? unseen : [],
    unknown: complete ? [] : unseen,
  }
}

/** Official read-only diagnostic. Never sends payment headers or triggers indexing. */
export async function validateProducts(baseUrl, fetchFn = fetch) {
  const origin = new URL(baseUrl).origin
  const results = []
  for (const path of PRODUCT_PATHS) {
    const body = await discoveryJson(`${API}/validate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: origin + path, method: 'POST' }),
    }, fetchFn)
    results.push({
      path, valid: body.valid === true,
      accepted: body.simulation?.outcome === 'accepted',
      indexActive: typeof body.index?.active === 'boolean' ? body.index.active : null,
      failures: Array.isArray(body.preflight)
        ? body.preflight.filter(check => check.severity === 'required' && check.passed !== true)
          .map(check => String(check.check).slice(0, 100)) : ['preflight_unavailable'],
    })
  }
  return results
}
