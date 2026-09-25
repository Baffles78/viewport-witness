import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'http'
import { createInfoRouter } from '../src/api/routes/info.js'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import type { WorkerRunner } from '../src/worker/runner.js'

const servers: http.Server[] = []

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DATA_DIR: './data',
    SCREENSHOTS_DIR: './data/screenshots',
    DB_PATH: './data/vw.db',
    PAYMENT_MODE: 'test',
    ENABLE_MAINNET_PAYMENTS: false,
    ENABLE_SOLANA_PAYMENTS: false,
    FACILITATOR_URL: undefined,
    CDP_API_KEY_ID: undefined,
    CDP_API_KEY_SECRET: undefined,
    CUSTOMER_HASH_SECRET: undefined,
    PAY_TO: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
    SOLANA_TEST_PAY_TO: 'AwnqYWr32DUJvk4XKxfUSpVVYcoUuMFNp8XoBShm5qSS',
    SOLANA_REVENUE_PAY_TO: 'EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk',
    PRICE_USDC: '0.08',
    VERIFY_PRICE_USDC: '0.10',
    COMPARE_PRICE_USDC: '0.12',
    RETENTION_DAYS: 7,
    MAX_STORAGE_GB: 10,
    WORKER_TIMEOUT_MS: 120_000,
    LOG_LEVEL: 'info',
    ...overrides,
  }
}

function makeStore(): JobStore {
  return {
    getJob: () => null,
  } as unknown as JobStore
}

function makeRunner(): WorkerRunner {
  return {
    isHealthy: () => true,
  } as unknown as WorkerRunner
}

async function startServer(cfg: Config): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express()
  app.use(createInfoRouter(makeStore(), makeRunner(), cfg))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return {
    port: (address as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

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
  it('advertises the canonical remote MCP endpoint', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/mcp.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as {
      name: string
      transport: { type: string; url: string }
      repository: string
    }
    expect(body.name).toBe('io.github.Baffles78/viewport-witness')
    expect(body.transport).toEqual({
      type: 'streamable-http',
      url: 'https://qa.honeygate.app/mcp',
    })
    expect(body.repository).toBe('https://github.com/Baffles78/viewport-witness')
  })
})

describe('GET /openapi.json', () => {
  it('returns 200 with valid JSON', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.openapi).toBe('3.1.0')
  })

  it('has /skill.md path defined', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    const body = (await res.json()) as { paths: Record<string, unknown> }
    expect(body.paths['/skill.md']).toBeDefined()
  })

  it('has /.well-known/mcp.json path defined', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    const body = (await res.json()) as { paths: Record<string, unknown> }
    expect(body.paths['/.well-known/mcp.json']).toBeDefined()
  })

  it('has live service server listed', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    const body = (await res.json()) as { servers: Array<{ url: string }> }
    const urls = body.servers.map((s) => s.url)
    expect(urls).toContain('https://qa.honeygate.app')
  })

  it('CreateCheckRequest schema is strict (additionalProperties false)', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    const body = (await res.json()) as {
      components: { schemas: { CreateCheckRequest: { additionalProperties: boolean } } }
    }
    expect(body.components.schemas.CreateCheckRequest.additionalProperties).toBe(false)
  })

  it('declares the required URL inline for safe discovery probes', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    const body = (await res.json()) as {
      paths: {
        '/v1/checks': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    required: string[]
                    properties: Record<string, unknown>
                  }
                }
              }
            }
          }
        }
      }
    }
    const schema = body.paths['/v1/checks'].post.requestBody.content['application/json'].schema
    expect(schema.required).toEqual(['url'])
    expect(schema.properties.url).toBeDefined()
  })

  it('CreateCheckResponse has id, status, pollUrl, paymentMode', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    const body = (await res.json()) as {
      components: { schemas: { CreateCheckResponse: { properties: Record<string, unknown> } } }
    }
    const props = body.components.schemas.CreateCheckResponse.properties
    expect(props.id).toBeDefined()
    expect(props.status).toBeDefined()
    expect(props.pollUrl).toBeDefined()
    expect(props.paymentMode).toBeDefined()
  })

  it('documents discovery-selected payment rails instead of claiming Base only', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    const body = (await res.json()) as {
      paths: { '/v1/checks': { post: { description: string } } }
      components: { schemas: { PaymentDiscovery: { properties: Record<string, unknown> } } }
    }
    expect(body.paths['/v1/checks'].post.description).toContain('/.well-known/x402')
    expect(body.paths['/v1/checks'].post.description).not.toContain('on Base mainnet')
    expect(body.components.schemas.PaymentDiscovery.properties.accepts).toBeDefined()
  })

  it('documents the feedback URL on completed reports', async () => {
    const { port } = await startServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`)
    const body = (await res.json()) as {
      components: { schemas: { QAReport: { properties: Record<string, unknown> } } }
    }
    expect(body.components.schemas.QAReport.properties.feedbackUrl).toBeDefined()
  })
})
