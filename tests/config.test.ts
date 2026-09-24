import { describe, expect, it } from 'vitest'
import { validateConfig, type Config } from '../src/config.js'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
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
    CUSTOMER_HASH_SECRET: undefined,
    PAY_TO: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
    PRICE_USDC: '0.08',
    RETENTION_DAYS: 7,
    MAX_STORAGE_GB: 10,
    WORKER_TIMEOUT_MS: 120_000,
    LOG_LEVEL: 'info',
    ...overrides,
  }
}

describe('paid-mode configuration', () => {
  it('requires a separate customer HMAC secret in paid modes', () => {
    expect(() =>
      validateConfig(
        makeConfig({
          PAYMENT_MODE: 'production',
          ENABLE_MAINNET_PAYMENTS: true,
          CDP_API_KEY_ID: 'organizations/org/apiKeys/key',
          CDP_API_KEY_SECRET: 'secret',
        }),
      ),
    ).toThrow('CUSTOMER_HASH_SECRET')
  })

  it('pins the reviewed V1 price to $0.08', () => {
    expect(() =>
      validateConfig(
        makeConfig({
          PAYMENT_MODE: 'testnet',
          PRICE_USDC: '0.09',
          CDP_API_KEY_ID: 'organizations/org/apiKeys/key',
          CDP_API_KEY_SECRET: 'secret',
          CUSTOMER_HASH_SECRET: '0123456789abcdef0123456789abcdef',
        }),
      ),
    ).toThrow('PRICE_USDC=0.08')
  })

  it('accepts the reviewed testnet price with CDP credentials', () => {
    expect(() =>
      validateConfig(
        makeConfig({
          PAYMENT_MODE: 'testnet',
          CDP_API_KEY_ID: 'organizations/org/apiKeys/key',
          CDP_API_KEY_SECRET: 'secret',
          CUSTOMER_HASH_SECRET: '0123456789abcdef0123456789abcdef',
        }),
      ),
    ).not.toThrow()
  })
})
