// Test config, mocks and servers for MCP and info router tests.
import express from 'express'
import http from 'http'
import { createMcpRouter } from '../../src/mcp.js'
import { createInfoRouter } from '../../src/api/routes/info.js'
import type { Config } from '../../src/config.js'
import type { JobStore } from '../../src/db.js'
import type { WorkerRunner } from '../../src/worker/runner.js'

export const servers: http.Server[] = []

export function makeConfig(overrides: Partial<Config> = {}): Config {
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

export function makeMockStore(): JobStore {
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

export function makeMockRunner(): WorkerRunner {
  return {
    enqueue: async () => {},
    isHealthy: () => true,
  } as unknown as WorkerRunner
}

export async function startMcpServer(
  cfg: Config,
  store: JobStore = makeMockStore(),
  runner: WorkerRunner = makeMockRunner(),
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use(createMcpRouter(store, runner, cfg))
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export async function startInfoServer(cfg: Config): Promise<{ port: number; close: () => Promise<void> }> {
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

export interface McpTool {
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

export interface McpToolsListResponse {
  jsonrpc: string
  id: number
  result?: { tools?: McpTool[] }
  error?: unknown
}

export async function callToolsList(port: number): Promise<McpToolsListResponse> {
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
