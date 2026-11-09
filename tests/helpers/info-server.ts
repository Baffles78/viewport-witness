// Test config, mocks and server for the info router.
import express from 'express'
import http from 'http'
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

export function makeStore(): JobStore {
  return {
    getJob: () => null,
  } as unknown as JobStore
}

export function makeRunner(): WorkerRunner {
  return {
    isHealthy: () => true,
  } as unknown as WorkerRunner
}

export async function startServer(cfg: Config): Promise<{ port: number; close: () => Promise<void> }> {
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
