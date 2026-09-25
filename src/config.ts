import { z } from 'zod'
import type { PaymentMode } from './types.js'

const paymentModeSchema = z.enum(['test', 'testnet', 'production'])
const usdcPriceSchema = z
  .string()
  .refine((value) => /^\d+(\.\d{1,6})?$/.test(value) && Number(value) > 0, {
    message: 'Price must be a positive USDC amount with at most 6 decimals',
  })

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .optional()
    .transform((v) => parseInt(v ?? '3000', 10))
    .pipe(z.number().int().min(1).max(65535)),
  DATA_DIR: z.string().default('./data'),
  SCREENSHOTS_DIR: z.string().default('./data/screenshots'),
  DB_PATH: z.string().default('./data/vw.db'),
  PAYMENT_MODE: paymentModeSchema.default('test'),
  ENABLE_MAINNET_PAYMENTS: z
    .string()
    .optional()
    .transform((v) => v === 'true')
    .pipe(z.boolean()),
  ENABLE_SOLANA_PAYMENTS: z
    .string()
    .optional()
    .transform((v) => v === 'true')
    .pipe(z.boolean()),
  FACILITATOR_URL: z.string().url().optional(),
  CDP_API_KEY_ID: z.string().optional(),
  CDP_API_KEY_SECRET: z.string().optional(),
  CUSTOMER_HASH_SECRET: z.string().min(32).optional(),
  PAY_TO: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'PAY_TO must be a 20-byte EVM address')
    .default('0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400'),
  SOLANA_TEST_PAY_TO: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'SOLANA_TEST_PAY_TO must be a base58 Solana address')
    .default('AwnqYWr32DUJvk4XKxfUSpVVYcoUuMFNp8XoBShm5qSS'),
  SOLANA_REVENUE_PAY_TO: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'SOLANA_REVENUE_PAY_TO must be a base58 Solana address')
    .default('EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk'),
  PRICE_USDC: usdcPriceSchema.default('0.08'),
  VERIFY_PRICE_USDC: usdcPriceSchema.default('0.10'),
  COMPARE_PRICE_USDC: usdcPriceSchema.default('0.12'),
  RETENTION_DAYS: z
    .string()
    .optional()
    .transform((v) => parseInt(v ?? '7', 10))
    .pipe(z.number().int().min(1)),
  MAX_STORAGE_GB: z
    .string()
    .optional()
    .transform((v) => parseFloat(v ?? '10'))
    .pipe(z.number().positive()),
  WORKER_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => parseInt(v ?? '120000', 10))
    .pipe(z.number().int().min(1000)),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = {
  NODE_ENV: 'development' | 'test' | 'production'
  PORT: number
  DATA_DIR: string
  SCREENSHOTS_DIR: string
  DB_PATH: string
  PAYMENT_MODE: PaymentMode
  ENABLE_MAINNET_PAYMENTS: boolean
  ENABLE_SOLANA_PAYMENTS: boolean
  FACILITATOR_URL: string | undefined
  CDP_API_KEY_ID: string | undefined
  CDP_API_KEY_SECRET: string | undefined
  CUSTOMER_HASH_SECRET: string | undefined
  PAY_TO: string
  SOLANA_TEST_PAY_TO: string
  SOLANA_REVENUE_PAY_TO: string
  PRICE_USDC: string
  VERIFY_PRICE_USDC: string
  COMPARE_PRICE_USDC: string
  RETENTION_DAYS: number
  MAX_STORAGE_GB: number
  WORKER_TIMEOUT_MS: number
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error'
}

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env)
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`)
  }
  return result.data as Config
}

export function validateConfig(cfg: Config): void {
  if (cfg.PAYMENT_MODE !== 'test' && cfg.PRICE_USDC !== '0.08') {
    throw new Error('Paid modes require PRICE_USDC=0.08 for the reviewed V1 price.')
  }
  if (
    cfg.PAYMENT_MODE !== 'test' &&
    (cfg.VERIFY_PRICE_USDC !== '0.10' || cfg.COMPARE_PRICE_USDC !== '0.12')
  ) {
    throw new Error('Paid modes require the reviewed prices: verify=0.10 and compare=0.12 USDC.')
  }
  if (cfg.PAYMENT_MODE === 'production') {
    if (!cfg.ENABLE_MAINNET_PAYMENTS) {
      throw new Error(
        'PAYMENT_MODE=production requires ENABLE_MAINNET_PAYMENTS=true. ' +
          'This gate must not be bypassed without an independent code review.',
      )
    }
    if (!cfg.CDP_API_KEY_ID || !cfg.CDP_API_KEY_SECRET) {
      throw new Error('PAYMENT_MODE=production requires CDP_API_KEY_ID and CDP_API_KEY_SECRET.')
    }
    if (!cfg.CUSTOMER_HASH_SECRET || cfg.CUSTOMER_HASH_SECRET.length < 32) {
      throw new Error(
        'PAYMENT_MODE=production requires CUSTOMER_HASH_SECRET with at least 32 characters.',
      )
    }
  }
  if (cfg.PAYMENT_MODE === 'testnet') {
    if (!cfg.CDP_API_KEY_ID || !cfg.CDP_API_KEY_SECRET) {
      throw new Error('PAYMENT_MODE=testnet requires CDP_API_KEY_ID and CDP_API_KEY_SECRET.')
    }
    if (!cfg.CUSTOMER_HASH_SECRET || cfg.CUSTOMER_HASH_SECRET.length < 32) {
      throw new Error(
        'PAYMENT_MODE=testnet requires CUSTOMER_HASH_SECRET with at least 32 characters.',
      )
    }
  }
}

export const config: Config = loadConfig()
