// Pieces reused across OpenAPI sections.

/** Security requirement array for paid x402 operations */
export const x402Security = [{ x402Payment: [] }]

export const createCheckRequestSchema = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description: 'Public HTTPS URL to check. Must not be a private/loopback address.',
      example: 'https://example.com',
    },
  },
} as const
