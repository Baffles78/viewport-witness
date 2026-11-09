import { x402Security, createCheckRequestSchema } from './shared.js'

// OpenAPI section: Browser QA checks: create, status and screenshots.
export const checkPaths = {
  '/v1/checks': {
    post: {
      summary: 'Create a browser QA check',
      operationId: 'createCheck',
      description:
        'Submit a public HTTPS URL for browser QA. Returns a job ID for polling. ' +
        'In test mode, no payment is required. In production mode, include a PAYMENT-SIGNATURE header ' +
        'with a valid $0.08 USDC payment using one of the networks in the live 402 challenge and ' +
        '/.well-known/x402 discovery response.',
      security: x402Security,
      'x-payment-info': {
        protocols: [{ x402: {} }],
        price: { mode: 'fixed', currency: 'USD', amount: '0.08' },
      },
      parameters: [
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', maxLength: 128 },
          description: 'Optional client-generated key to prevent duplicate job creation',
        },
        {
          name: 'PAYMENT-SIGNATURE',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'x402 payment header (required in production mode)',
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            // Keep this schema inline as well as in components. Discovery crawlers
            // deliberately avoid resolving third-party $ref values when building
            // an unpaid probe request.
            schema: createCheckRequestSchema,
            example: { url: 'https://example.com' },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job accepted and queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateCheckResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request (bad URL, blocked destination, etc.)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '402': {
          description: 'Payment required (production mode only)',
          headers: {
            'PAYMENT-REQUIRED': {
              schema: { type: 'string' },
              description: 'x402 payment requirements',
            },
          },
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '422': {
          description: 'Validation error',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Service unavailable (payment infrastructure not configured)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/v1/checks/{id}': {
    get: {
      summary: 'Get check job status and result',
      operationId: 'getCheck',
      security: [],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
          description: 'Job ID returned by POST /v1/checks',
        },
      ],
      responses: {
        '200': {
          description: 'Job status or complete report',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CheckStatusResponse' },
            },
          },
        },
        '404': {
          description: 'Job not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/v1/checks/{id}/screenshots/{viewport}': {
    get: {
      summary: 'Get a screenshot for a specific viewport',
      operationId: 'getScreenshot',
      security: [],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        {
          name: 'viewport',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            enum: ['phonePortrait', 'phoneLandscape', 'desktop'],
          },
        },
      ],
      responses: {
        '200': {
          description: 'PNG screenshot image',
          content: { 'image/png': {} },
        },
        '400': {
          description: 'Invalid viewport name',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Screenshot not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
} as const
