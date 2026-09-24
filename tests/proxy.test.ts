import { describe, expect, it } from 'vitest'
import { createApp } from '../src/api/index.js'
import type { Config } from '../src/config.js'
import type { JobStore } from '../src/db.js'
import type { WorkerRunner } from '../src/worker/runner.js'

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATA_DIR: './data',
  SCREENSHOTS_DIR: './data/screenshots',
  DB_PATH: './data/vw.db',
  PAYMENT_MODE: 'test',
  ENABLE_MAINNET_PAYMENTS: false,
  FACILITATOR_URL: undefined,
  CDP_API_KEY_ID: undefined,
  CDP_API_KEY_SECRET: undefined,
  PAY_TO: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
  PRICE_USDC: '0.08',
  RETENTION_DAYS: 7,
  MAX_STORAGE_GB: 10,
  WORKER_TIMEOUT_MS: 120_000,
  LOG_LEVEL: 'info',
}

describe('reverse proxy trust', () => {
  it('trusts only loopback peers used by the local Nginx proxy', () => {
    const app = createApp({} as JobStore, {} as WorkerRunner, config)
    const trustProxy = app.get('trust proxy fn') as (address: string, hop: number) => boolean

    expect(trustProxy('127.0.0.1', 0)).toBe(true)
    expect(trustProxy('::1', 0)).toBe(true)
    expect(trustProxy('203.0.113.10', 0)).toBe(false)
  })
})
