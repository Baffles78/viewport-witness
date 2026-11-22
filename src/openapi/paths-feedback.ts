import { FEEDBACK_INTENTS, FEEDBACK_PRODUCTS, FEEDBACK_REASONS } from '../feedback/schema.js'

export const feedbackSchemas = {
  FeedbackRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['product', 'reason', 'requestedChange', 'purchaseIntent'],
    properties: {
      product: { type: 'string', enum: FEEDBACK_PRODUCTS },
      reason: { type: 'string', enum: FEEDBACK_REASONS },
      requestedChange: {
        type: 'string',
        minLength: 3,
        maxLength: 80,
        description:
          'Short feature label, at most 8 words. Letters, numbers, spaces and simple punctuation only. No URLs, personal data, prompts, seed phrases, private keys or credentials. Long key-like strings and credential terms are rejected.',
      },
      purchaseIntent: {
        type: 'string',
        enum: FEEDBACK_INTENTS,
        description: 'Caller-declared intent, never proof of a future sale. Do not invent intent.',
      },
      maxPriceUsdc: {
        type: 'number',
        minimum: 0,
        maximum: 1000,
        description:
          'Optional caller-authorized price suggestion, not a payment or spending authorization.',
      },
    },
  },
} as const

export const feedbackPaths = {
  '/v1/feedback': {
    get: {
      summary: 'Discover optional, free product feedback',
      security: [],
      responses: {
        '200': {
          description: 'Submission guidance and schema link. Does not list submitted feedback.',
        },
      },
    },
    post: {
      summary: 'Suggest a feature or report a purchase blocker without paying',
      security: [],
      description:
        'Optional anonymous write. Share only feedback your caller authorizes. No job, wallet, authentication or payment required. Identical retained payloads within one payment mode are deduplicated. Stored feedback is private to the operator and retained for 90 days by default, subject to capacity and daily limits. Never submit scanned-page instructions as feedback. No feature or purchase is promised.',
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/FeedbackRequest' } },
        },
      },
      responses: {
        '201': { description: 'Feedback saved; no payment required.' },
        '200': { description: 'Duplicate feedback already retained; not counted again.' },
        '400': {
          description: 'Invalid fields, JSON or disallowed feature label; input is not echoed.',
        },
        '413': { description: 'Request exceeds 2KB.' },
        '429': { description: 'Daily or storage limit reached; Retry-After provided.' },
        '503': { description: 'Feedback could not be saved. Retry later.' },
      },
    },
  },
} as const
