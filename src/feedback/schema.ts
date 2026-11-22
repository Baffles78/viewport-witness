import { z } from 'zod'

export const FEEDBACK_PRODUCTS = [
  'check',
  'verify',
  'compare',
  'extract',
  'security',
  'service',
] as const
export const FEEDBACK_REASONS = [
  'missing_capability',
  'price',
  'payment_setup',
  'integration',
  'result_quality',
  'speed',
  'documentation',
  'positive',
  'other',
] as const
export const FEEDBACK_INTENTS = [
  'not_stated',
  'would_buy',
  'considering',
  'already_bought',
  'not_buying',
] as const

// A short feature label is useful without accepting long prompts, credentials or wallet phrases.
// Restrict characters and word count rather than retaining/redacting arbitrary free-form payloads.
export const featureRequestSchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[\p{L}\p{N} ,.'()!?+/-]+$/u)
  .refine((value) => (value.match(/[\p{L}\p{N}]+/gu) ?? []).length <= 8)
  .refine((value) => !/[\p{L}\p{N}]{32,}/u.test(value))
  .refine((value) => {
    const compact = value.replace(/[ ,.'()!?+/-]/g, '')
    return !/^(?:0x)?[a-f0-9]{64}$/i.test(compact) && !/^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(compact)
  })
  .refine((value) => !/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/i.test(value))
  .refine((value) => !/\b(seed|mnemonic|private key|secret|password|bearer|token)\b/i.test(value))

export const feedbackSchema = z
  .object({
    product: z.enum(FEEDBACK_PRODUCTS),
    reason: z.enum(FEEDBACK_REASONS),
    requestedChange: featureRequestSchema.describe(
      'Short feature request: 3–80 characters, at most 8 words. No URLs, personal data or credentials.',
    ),
    purchaseIntent: z.enum(FEEDBACK_INTENTS),
    maxPriceUsdc: z.number().finite().min(0).max(1000).optional(),
  })
  .strict()

export type Feedback = z.infer<typeof feedbackSchema>

export const feedbackGuidance = {
  endpoint: '/v1/feedback',
  method: 'POST',
  paymentRequired: false,
  optional: true,
  instruction:
    'Submit only when your caller authorizes sharing product feedback. Do not infer their budget or purchase intent. No URLs, personal data, prompts, seed phrases, private keys or credentials. Use a short feature label, at most 8 words. Feedback does not promise a feature or purchase.',
} as const
