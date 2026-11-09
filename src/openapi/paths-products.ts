import { x402Security, createCheckRequestSchema } from './shared.js'

// OpenAPI section: Paid single-page products: extract, security gate, verify, compare.
export const productPaths = {
  '/v1/extract': {
    post: {
      summary: 'Extract clean Markdown from one public HTML page',
      operationId: 'extractPage',
      description:
        'Non-browser, deterministic extraction. Costs $0.005 USDC live. The response is queued and retained for seven days.',
      security: x402Security,
      'x-payment-info': {
        protocols: [{ x402: {} }],
        price: { mode: 'fixed', currency: 'USD', amount: '0.005' },
      },
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['url'],
              additionalProperties: false,
              properties: {
                url: { type: 'string', format: 'uri' },
                maxOutputTokens: { type: 'integer', minimum: 500, maximum: 12000 },
              },
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job accepted',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateCheckResponse' } },
          },
        },
        '402': {
          description: 'Payment required',
          headers: {
            'PAYMENT-REQUIRED': {
              schema: { type: 'string' },
              description: 'x402 payment requirements',
            },
          },
        },
        '422': { description: 'Invalid input' },
      },
    },
  },
  '/v1/security-gate': {
    post: {
      summary: 'Run a passive web release security gate',
      operationId: 'webReleaseGate',
      description:
        'Checks only the target HTML response and validated redirects. No probing or code execution. Costs $0.05 USDC live.',
      security: x402Security,
      'x-payment-info': {
        protocols: [{ x402: {} }],
        price: { mode: 'fixed', currency: 'USD', amount: '0.05' },
      },
      requestBody: {
        required: true,
        content: { 'application/json': { schema: createCheckRequestSchema } },
      },
      responses: {
        '202': {
          description: 'Job accepted',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateCheckResponse' } },
          },
        },
        '402': {
          description: 'Payment required',
          headers: {
            'PAYMENT-REQUIRED': {
              schema: { type: 'string' },
              description: 'x402 payment requirements',
            },
          },
        },
        '422': { description: 'Invalid input' },
      },
    },
  },
  '/v1/verify': {
    post: {
      summary: 'Create a read-only assertion job',
      operationId: 'verifyPage',
      description:
        'Checks up to 20 declarative assertions across all three viewports. Costs $0.10 USDC live on the production service; no payment required in test mode.',
      security: x402Security,
      'x-payment-info': {
        protocols: [{ x402: {} }],
        price: { mode: 'fixed', currency: 'USD', amount: '0.10' },
      },
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/VerifyRequest' },
            example: {
              url: 'https://example.com',
              assertions: [{ type: 'titleIncludes', value: 'Example Domain' }],
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job accepted',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateCheckResponse' } },
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
        },
        '422': { description: 'Invalid assertions' },
      },
    },
  },
  '/v1/compare': {
    post: {
      summary: 'Compare a page with a baseline job',
      operationId: 'comparePage',
      description:
        'Produces pixel diff images and QA deltas against a completed, unexpired baseline. Costs $0.12 USDC live on the production service; no payment required in test mode.',
      security: x402Security,
      'x-payment-info': {
        protocols: [{ x402: {} }],
        price: { mode: 'fixed', currency: 'USD', amount: '0.12' },
      },
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CompareRequest' },
            example: {
              url: 'https://example.com',
              baselineJobId: '00000000-0000-0000-0000-000000000000',
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Job accepted',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateCheckResponse' } },
          },
        },
        '400': { description: 'Baseline or URL unavailable' },
        '402': {
          description: 'Payment required (production mode only)',
          headers: {
            'PAYMENT-REQUIRED': {
              schema: { type: 'string' },
              description: 'x402 payment requirements',
            },
          },
        },
      },
    },
  },
} as const
