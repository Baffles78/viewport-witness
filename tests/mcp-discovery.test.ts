import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'http'
import { createMcpRouter } from '../src/mcp.js'
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

function makeMockStore(): JobStore {
  return {
    getJob: () => null,
    getJobByPaymentId: () => null,
    getJobByIdempotencyKey: () => null,
    activatePaymentPendingJob: () => false,
    failPaymentPendingJob: () => {},
    updateJobStatus: () => {},
    getScreenshot: () => null,
    createJob: () => {},
  } as unknown as JobStore
}

function makeMockRunner(): WorkerRunner {
  return {
    enqueue: async () => {},
    isHealthy: () => true,
  } as unknown as WorkerRunner
}

async function startMcpServer(
  cfg: Config,
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use(createMcpRouter(makeMockStore(), makeMockRunner(), cfg))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function startInfoServer(
  cfg: Config,
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express()
  app.use(createInfoRouter(makeMockStore(), makeMockRunner(), cfg))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, unknown>
    [key: string]: unknown
  }
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    openWorldHint?: boolean
    [key: string]: unknown
  }
}

interface McpToolsListResponse {
  jsonrpc: string
  id: number
  result?: { tools?: McpTool[] }
  error?: unknown
}

async function callToolsList(port: number): Promise<McpToolsListResponse> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Host: `127.0.0.1:${port}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  })
  return res.json() as Promise<McpToolsListResponse>
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

describe('MCP tools/list — tool annotations', () => {
  it('check_page has readOnlyHint=false, destructiveHint=false, openWorldHint=true', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'check_page')
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    expect(tool?.annotations?.openWorldHint).toBe(true)
  })

  it('verify_page has readOnlyHint=false, destructiveHint=false, openWorldHint=true', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    expect(tool?.annotations?.openWorldHint).toBe(true)
  })

  it('compare_page has readOnlyHint=false, destructiveHint=false, openWorldHint=true', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'compare_page')
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    expect(tool?.annotations?.openWorldHint).toBe(true)
  })

  it('get_report has readOnlyHint=true, destructiveHint=false, openWorldHint=false', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'get_report')
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    expect(tool?.annotations?.openWorldHint).toBe(false)
  })
})

describe('MCP tools/list — tool descriptions', () => {
  it('check_page description mentions $0.08 USDC and x402', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'check_page')
    expect(tool?.description).toContain('0.08')
    expect(tool?.description?.toLowerCase()).toContain('x402')
  })

  it('check_page description states x402-aware client is required', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'check_page')
    expect(tool?.description?.toLowerCase()).toContain('x402-aware')
  })

  it('get_report description mentions free and read-only', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'get_report')
    expect(tool?.description?.toLowerCase()).toContain('free')
    expect(tool?.description?.toLowerCase()).toContain('read-only')
  })

  it('verify_page description lists assertion types', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    expect(tool?.description).toContain('noHorizontalOverflow')
    expect(tool?.description).toContain('noConsoleErrors')
  })
})

describe('MCP tools/list — verify_page assertions schema', () => {
  it('verify_page has assertions in inputSchema', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    const assertions = tool?.inputSchema?.properties?.['assertions'] as Record<string, unknown> | undefined
    expect(assertions).toBeDefined()
  })

  it('verify_page assertions schema is a discriminated union (not generic object)', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    const assertions = tool?.inputSchema?.properties?.['assertions'] as Record<string, unknown> | undefined
    // The array items should have anyOf or oneOf — not just { type: 'object' }
    const items = assertions?.['items'] as Record<string, unknown> | undefined
    expect(items).toBeDefined()
    const hasDiscrimination = 'anyOf' in (items ?? {}) || 'oneOf' in (items ?? {})
    expect(hasDiscrimination).toBe(true)
  })

  it('verify_page assertions schema covers all six assertion types', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    const assertions = tool?.inputSchema?.properties?.['assertions'] as Record<string, unknown> | undefined
    const items = assertions?.['items'] as Record<string, unknown> | undefined
    const variants = ((items?.['anyOf'] ?? items?.['oneOf']) as unknown[]) ?? []
    expect(variants.length).toBe(6)
  })
})

describe('MCP tools/list — all four tools present', () => {
  it('returns exactly four tools', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const names = response.result?.tools?.map((t) => t.name) ?? []
    expect(names).toContain('check_page')
    expect(names).toContain('verify_page')
    expect(names).toContain('compare_page')
    expect(names).toContain('get_report')
    expect(names.length).toBe(4)
  })
})

describe('GET /privacy', () => {
  it('returns 200', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    expect(res.status).toBe(200)
  })

  it('returns text/markdown content-type', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    expect(res.headers.get('content-type')).toMatch(/text\/markdown|text\/plain/)
  })

  it('mentions data retention', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('retent')
  })

  it('mentions submitted URLs', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('url')
  })

  it('mentions screenshots', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('screenshot')
  })

  it('does not claim to have a named legal jurisdiction or company address', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/privacy`)
    const text = await res.text()
    expect(text).not.toMatch(/incorporated in|registered in|based in|GDPR|CCPA/i)
  })
})

describe('GET /terms', () => {
  it('returns 200', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    expect(res.status).toBe(200)
  })

  it('returns text/markdown content-type', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    expect(res.headers.get('content-type')).toMatch(/text\/markdown|text\/plain/)
  })

  it('mentions paid automated QA and x402', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('paid')
    expect(text.toLowerCase()).toContain('x402')
  })

  it('mentions public HTTPS target authorisation', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('authoris')
  })

  it('mentions non-mutating browser behaviour', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toMatch(/read.only|non.mutat/)
  })

  it('mentions report expiry', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('expir')
  })

  it('mentions crypto payment finality', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text.toLowerCase()).toMatch(/final|irreversible|refund/)
  })

  it('does not claim a specific company name, jurisdiction, or legal guarantee', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/terms`)
    const text = await res.text()
    expect(text).not.toMatch(/incorporated in|registered in|Ltd\.|LLC\.|Inc\./i)
  })
})

describe('GET /logo.png', () => {
  it('returns the directory logo as PNG', async () => {
    const { port } = await startInfoServer(makeConfig())
    const res = await fetch(`http://127.0.0.1:${port}/logo.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/image\/png/)
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1_000)
  })
})
