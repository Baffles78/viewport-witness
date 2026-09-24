import { z } from 'zod'
import type { PaymentMode } from './types.js'

const paymentModeSchema = z.enum(['test', 'testnet', 'production'])

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
  FACILITATOR_URL: z.string().url().optional(),
  FACILITATOR_API_KEY: z.string().optional(),
  PAY_TO: z.string().default('0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400'),
  PRICE_USDC: z.string().default('0.08'),
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
  FACILITATOR_URL: string | undefined
  FACILITATOR_API_KEY: string | undefined
  PAY_TO: string
  PRICE_USDC: string
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
  if (cfg.PAYMENT_MODE === 'production') {
    if (!cfg.ENABLE_MAINNET_PAYMENTS) {
      throw new Error(
        'PAYMENT_MODE=production requires ENABLE_MAINNET_PAYMENTS=true. ' +
          'This gate must not be bypassed without an independent code review.',
      )
    }
    if (!cfg.FACILITATOR_URL || !cfg.FACILITATOR_API_KEY) {
      throw new Error('PAYMENT_MODE=production requires FACILITATOR_URL and FACILITATOR_API_KEY.')
    }
  }
  if (cfg.PAYMENT_MODE === 'testnet') {
    if (!cfg.FACILITATOR_URL) {
      throw new Error('PAYMENT_MODE=testnet requires FACILITATOR_URL.')
    }
  }
}

export const config: Config = loadConfig()
