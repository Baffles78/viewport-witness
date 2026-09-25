const BASE_URL = process.env.VIEWPORT_WITNESS_BASE_URL ?? 'https://qa.honeygate.app'
const REGISTRY_NAME = 'io.github.Baffles78/viewport-witness'
const BAZAAR_SEARCH = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search'

function result(name, ok, detail) {
  return { name, ok, detail }
}

async function requireOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response
}

async function checkPublicDocuments() {
  const paths = ['/.well-known/x402', '/.well-known/mcp.json', '/openapi.json', '/skill.md', '/llms.txt']
  return Promise.all(
    paths.map(async (path) => {
      try {
        const response = await requireOk(`${BASE_URL}${path}`)
        return result(`public ${path}`, true, response.headers.get('content-type') ?? 'unknown')
      } catch (error) {
        return result(`public ${path}`, false, error instanceof Error ? error.message : String(error))
      }
    }),
  )
}

async function checkRegistry() {
  try {
    const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent('viewport-witness')}`
    const response = await requireOk(url)
    const body = await response.json()
    const entry = body.servers?.find((item) => item.server?.name === REGISTRY_NAME)
    return result(
      'official MCP Registry',
      Boolean(entry),
      entry
        ? `active version ${entry.server.version}; published ${entry._meta?.['io.modelcontextprotocol.registry/official']?.publishedAt ?? 'unknown'}`
        : 'registry entry not found',
    )
  } catch (error) {
    return result('official MCP Registry', false, error instanceof Error ? error.message : String(error))
  }
}

async function checkChallenge() {
  try {
    const response = await fetch(`${BASE_URL}/v1/checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
      signal: AbortSignal.timeout(20_000),
    })
    const encoded = response.headers.get('payment-required')
    if (response.status !== 402 || !encoded) {
      return result('x402 Bazaar declaration', false, `expected 402 with PAYMENT-REQUIRED; received ${response.status}`)
    }
    const challenge = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    const bazaar = challenge.extensions?.bazaar
    const absoluteResource = challenge.resource?.url === `${BASE_URL}/v1/checks`
    return result(
      'x402 Bazaar declaration',
      Boolean(bazaar?.info?.input && bazaar?.schema && absoluteResource),
      `resource=${challenge.resource?.url ?? 'missing'}; tags=${challenge.resource?.tags?.join(',') ?? 'missing'}`,
    )
  } catch (error) {
    return result('x402 Bazaar declaration', false, error instanceof Error ? error.message : String(error))
  }
}

async function checkBazaar() {
  try {
    const expectations = [
      ['ViewportWitness', ['/v1/checks', '/v1/verify']],
      ['browser QA screenshots accessibility', ['/v1/checks']],
      ['visual regression website', ['/v1/compare']],
      ['DOM to Markdown webpage extraction', ['/v1/extract']],
      ['passive web release security', ['/v1/security-gate']],
    ]
    const found = []
    const missing = []
    for (const [query, paths] of expectations) {
      const url = `${BAZAAR_SEARCH}?query=${encodeURIComponent(query)}&type=http`
      const response = await requireOk(url)
      const body = await response.json()
      const resources = new Set(
        body.resources
          ?.map((item) => item.resource)
          .filter((resource) => typeof resource === 'string' && resource.startsWith(BASE_URL)),
      )
      for (const path of paths) {
        const resource = `${BASE_URL}${path}`
        ;(resources.has(resource) ? found : missing).push(`${path} via "${query}"`)
      }
    }
    return result(
      'Coinbase Bazaar coverage',
      missing.length === 0,
      `found: ${found.join('; ') || 'none'}; missing: ${missing.join('; ') || 'none'}`,
    )
  } catch (error) {
    return result('Coinbase Bazaar coverage', false, error instanceof Error ? error.message : String(error))
  }
}

const checks = [
  ...(await checkPublicDocuments()),
  await checkRegistry(),
  await checkChallenge(),
  await checkBazaar(),
]

for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`)
}

const coreFailure = checks.some((check) => !check.ok && check.name !== 'Coinbase Bazaar coverage')
if (coreFailure || (process.argv.includes('--require-bazaar') && !checks.at(-1).ok)) process.exitCode = 1
