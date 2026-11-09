import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import { fileURLToPath } from 'url'
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

describe('README.md — paid product documentation', () => {
  let readme: string

  beforeAll(() => {
    readme = fs.readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf-8')
  })

  it('documents POST /v1/checks at 0.08 USDC', () => {
    expect(readme).toContain('POST /v1/checks')
    expect(readme).toContain('0.08 USDC')
  })

  it('documents POST /v1/verify at 0.10 USDC', () => {
    expect(readme).toContain('POST /v1/verify')
    expect(readme).toContain('0.10 USDC')
  })

  it('documents POST /v1/compare at 0.12 USDC', () => {
    expect(readme).toContain('POST /v1/compare')
    expect(readme).toContain('0.12 USDC')
  })

  it('explains the HTTP 402 x402 challenge', () => {
    expect(readme).toContain('HTTP 402')
    expect(readme).toContain('x402')
  })

  it('explains that an x402-aware client pays and retries', () => {
    expect(readme).toContain('x402-aware client')
    expect(readme).toContain('retries automatically')
  })

  it('documents the public-HTTPS-only safety boundary', () => {
    expect(readme).toContain('public HTTPS')
  })

  it('documents the non-mutating safety boundary', () => {
    expect(readme).toContain('non-mutating')
  })

  it('/v1/compare: documents that baselineJobId must identify a completed job', () => {
    expect(readme).toMatch(/baselineJobId.{0,40}must identify a completed/is)
  })

  it('/v1/compare: documents that the baseline must have screenshots for all three viewports', () => {
    expect(readme).toContain('screenshots for all three viewports')
  })
})
