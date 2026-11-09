import { afterEach, describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { servers, makeConfig, startServer } from './helpers/info-server.js'

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

describe('synthetic buyer workflow evidence', () => {
  it('serves failure and fix evidence while refusing non-public artifacts', async () => {
    const { port } = await startServer(makeConfig())
    const base = `http://127.0.0.1:${port}/samples/release-demo/`
    expect((await fetch(base)).status).toBe(200)
    const proof = await (await fetch(`${base}proof.json`)).json()
    expect(proof.simulation).toBe(true)
    expect(proof.onChainPayments).toBe(0)
    expect(proof.productionCalls).toBe(0)
    expect(proof.receipts.map((receipt: { decision: string }) => receipt.decision)).toEqual([
      'FAIL',
      'PASS',
    ])
    for (const version of ['broken', 'fixed']) {
      expect((await fetch(`${base}${version}/report.json`)).status).toBe(200)
      for (const viewport of ['phonePortrait', 'phoneLandscape', 'desktop']) {
        const response = await fetch(`${base}${version}/${viewport}.png`)
        expect(response.status).toBe(200)
        const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()))
        expect(png.width).toBeGreaterThan(300)
      }
    }
    for (const file of ['checkpoint.json', 'broken/checkpoint.json', 'fixed/vw.db', 'index.ts']) {
      expect((await fetch(`${base}${file}`)).status).toBe(404)
    }
  })
})

describe('durable public demonstration', () => {
  it('serves real test-mode evidence without a retained job or payment', async () => {
    const { port } = await startServer(makeConfig())
    const base = `http://127.0.0.1:${port}/samples/example/`
    const page = await fetch(base)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('SAVED DEMONSTRATION')
    const report = await (await fetch(`${base}report.json`)).json()
    expect(report.url).toBe('https://example.com')
    expect(report.paymentMode).toBe('test')
    const provenance = await (await fetch(`${base}provenance.json`)).json()
    expect(provenance.paymentSettled).toBe(false)
    for (const viewport of ['phonePortrait', 'phoneLandscape', 'desktop']) {
      const response = await fetch(`${base}${viewport}.png`)
      expect(response.status).toBe(200)
      const image = PNG.sync.read(Buffer.from(await response.arrayBuffer()))
      expect(image.width).toBe(report.viewports[viewport].screenshotDimensions.w)
      expect(image.height).toBe(report.viewports[viewport].screenshotDimensions.h)
    }
  })

  it('does not expose arbitrary files or the test database', async () => {
    const { port } = await startServer(makeConfig())
    for (const file of ['test.db', '.env', 'other-job.json']) {
      expect((await fetch(`http://127.0.0.1:${port}/samples/example/${file}`)).status).toBe(404)
    }
  })
})

describe('GET /', () => {
  it('returns service name ViewportWitness by Apex Labs', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.service).toBe('ViewportWitness by Apex Labs')
  })

  it('advertises skillDocs at /skill.md', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.skillDocs).toBe('/skill.md')
  })

  it('advertises paymentDiscovery at /.well-known/x402', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.paymentDiscovery).toBe('/.well-known/x402')
  })

  it('advertises the public customer feedback form', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.feedback).toBe(
      'https://github.com/Baffles78/viewport-witness/issues/new?template=customer-feedback.yml',
    )
  })
})

describe('GET /llms.txt', () => {
  it('returns text/plain content-type', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/llms.txt`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
  })

  it('contains live service URL https://qa.honeygate.app', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/llms.txt`)
    const text = await res.text()
    expect(text).toContain('https://qa.honeygate.app')
  })

  it('does not claim the service is test/default or mainnet-disabled', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/llms.txt`)
    const text = await res.text()
    expect(text).not.toMatch(/mainnet payments are disabled by default/i)
    expect(text).not.toMatch(/replace with the deployed host/i)
    expect(text).not.toMatch(/your-host/i)
  })
})

describe('GET /skill.md', () => {
  it('returns 200 with markdown content', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/skill.md`)
    expect(res.status).toBe(200)
  })

  it('contains base URL https://qa.honeygate.app', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/skill.md`)
    const text = await res.text()
    expect(text).toContain('https://qa.honeygate.app')
  })

  it('contains 0.08 USDC price on Base', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/skill.md`)
    const text = await res.text()
    expect(text).toContain('0.08 USDC')
    expect(text).toContain('Base')
  })

  it('mentions POST /v1/checks', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/skill.md`)
    const text = await res.text()
    expect(text).toContain('POST')
    expect(text).toContain('/v1/checks')
  })

  it('contains polling guidance', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/skill.md`)
    const text = await res.text()
    expect(text).toMatch(/poll/i)
  })

  it('mentions idempotency', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/skill.md`)
    const text = await res.text()
    expect(text).toMatch(/idempoten/i)
  })

  it('references OpenAPI spec', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/skill.md`)
    const text = await res.text()
    expect(text).toContain('/openapi.json')
  })
})

describe('agent discovery pages', () => {
  it('serves an indexable agent landing page with every tool intent', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/agents`)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    for (const tool of [
      'check_page',
      'verify_page',
      'compare_page',
      'extract_page',
      'web_release_gate',
      'get_report',
    ]) {
      expect(text).toContain(tool)
    }
    expect(text).toContain('https://qa.honeygate.app/mcp')
  })

  it('serves robots.txt with the public sitemap URL', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/robots.txt`)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toContain('Allow: /')
    expect(text).toContain('https://qa.honeygate.app/sitemap.xml')
  })

  it('serves a sitemap containing the agent landing page and machine-readable docs', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/sitemap.xml`)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/xml/)
    expect(text).toContain('https://qa.honeygate.app/agents')
    expect(text).toContain('https://qa.honeygate.app/openapi.json')
  })
})

describe('GET /.well-known/x402', () => {
  it('includes price $0.08 USDC', async () => {
    const { port } = await startServer(makeConfig({ PAYMENT_MODE: 'testnet' }))
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/x402`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.price).toBe('$0.08 USDC')
  })

  it('includes payTo address', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/x402`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.payTo).toBe('0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400')
  })

  it('includes crawler discovery fields (endpoint, method, skillMdUrl, openapiUrl)', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/x402`)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.endpoint).toBe('string')
    expect(body.endpoint).toBe('POST https://qa.honeygate.app/v1/checks')
    expect(body.method).toBe('POST')
    expect(typeof body.skillMdUrl).toBe('string')
    expect(body.skillMdUrl).toMatch(/skill\.md$/)
    expect(typeof body.openapiUrl).toBe('string')
    expect(body.openapiUrl).toMatch(/openapi\.json$/)
  })

  it('does not let request Host headers rewrite public discovery URLs', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/x402`, {
      headers: { Host: 'attacker.example' },
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(body.endpoint).toBe('POST https://qa.honeygate.app/v1/checks')
    expect(body.skillMdUrl).toBe('https://qa.honeygate.app/skill.md')
  })

  it('is backwards compatible — preserves version, paymentRequired, asset, network', async () => {
    const { port } = await startServer(makeConfig({ PAYMENT_MODE: 'testnet' }))
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/x402`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.version).toBeDefined()
    expect(typeof body.paymentRequired).toBe('boolean')
    expect(body.asset).toBeDefined()
    expect(body.network).toBeDefined()
  })
})

describe('GET /.well-known/mcp.json', () => {
  it('serves the official registry manifest shape for the mcpub directory probe', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/mcp.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as {
      $schema: string
      name: string
      description: string
      remotes: Array<{ type: string; url: string }>
      repository: { source: string; url: string; id: string }
    }
    expect(body.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    )
    expect(body.name).toBe('io.github.Baffles78/viewport-witness')
    expect(body.description.length).toBeLessThanOrEqual(100)
    expect(body.remotes).toEqual([
      {
        type: 'streamable-http',
        url: 'https://qa.honeygate.app/mcp',
      },
    ])
    expect(body.repository).toEqual({
      source: 'github',
      url: 'https://github.com/Baffles78/viewport-witness',
      id: '1386004607',
    })
  })
})
