import { createCheckRequestSchema } from './shared.js'
import { FEEDBACK_URL } from '../public.js'

// OpenAPI section: Request bodies and service/status responses.
export const serviceSchemas = {
  VerifyRequest: {
    type: 'object',
    required: ['url', 'assertions'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', format: 'uri' },
      assertions: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          oneOf: [
            {
              type: 'object',
              required: ['type'],
              additionalProperties: false,
              properties: { type: { type: 'string', enum: ['noHorizontalOverflow'] } },
            },
            {
              type: 'object',
              required: ['type'],
              additionalProperties: false,
              properties: { type: { type: 'string', enum: ['noConsoleErrors'] } },
            },
            {
              type: 'object',
              required: ['type', 'value'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['textVisible'] },
                value: { type: 'string', minLength: 1, maxLength: 200 },
              },
            },
            {
              type: 'object',
              required: ['type', 'value'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['titleIncludes'] },
                value: { type: 'string', minLength: 1, maxLength: 200 },
              },
            },
            {
              type: 'object',
              required: ['type', 'selector'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['selectorExists'] },
                selector: { type: 'string', minLength: 1, maxLength: 300 },
              },
            },
            {
              type: 'object',
              required: ['type', 'selector'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['selectorVisible'] },
                selector: { type: 'string', minLength: 1, maxLength: 300 },
              },
            },
          ],
          discriminator: { propertyName: 'type' },
        },
      },
    },
  },
  CompareRequest: {
    type: 'object',
    required: ['url', 'baselineJobId'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', format: 'uri' },
      baselineJobId: { type: 'string', format: 'uuid' },
    },
  },
  ServiceInfo: {
    type: 'object',
    properties: {
      service: { type: 'string', example: 'ViewportWitness by Apex Labs' },
      version: { type: 'string', example: '0.1.0' },
      docs: { type: 'string', example: '/openapi.json' },
      agentDocs: { type: 'string', example: '/llms.txt' },
      skillDocs: { type: 'string', example: '/skill.md' },
      health: { type: 'string', example: '/health' },
      paymentDiscovery: { type: 'string', example: '/.well-known/x402' },
      feedback: { type: 'string', example: FEEDBACK_URL },
    },
  },
  HealthResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok'] },
      uptime: { type: 'number', description: 'Process uptime in seconds' },
    },
  },
  ReadyResponse: {
    type: 'object',
    properties: {
      ready: { type: 'boolean' },
      db: { type: 'string', enum: ['ok', 'fail'] },
      worker: { type: 'string', enum: ['ok', 'fail'] },
    },
  },
  PaymentDiscovery: {
    type: 'object',
    properties: {
      version: { type: 'string' },
      paymentRequired: { type: 'boolean' },
      price: { type: 'string', example: '$0.08 USDC' },
      asset: { type: 'string', example: 'USDC' },
      network: { type: 'string', example: 'base (eip155:8453)' },
      payTo: { type: 'string', example: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400' },
      accepts: {
        type: 'array',
        description: 'Every payment rail currently accepted by the service',
        items: {
          type: 'object',
          required: ['scheme', 'network', 'asset', 'payTo'],
          properties: {
            scheme: { type: 'string', enum: ['exact'] },
            network: { type: 'string', example: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
            asset: { type: 'string', enum: ['USDC'] },
            payTo: { type: 'string' },
          },
        },
      },
      testMode: { type: 'boolean' },
      endpoint: { type: 'string', example: 'POST https://qa.honeygate.app/v1/checks' },
      method: { type: 'string', example: 'POST' },
      description: { type: 'string' },
      skillMdUrl: { type: 'string', example: 'https://qa.honeygate.app/skill.md' },
      openapiUrl: { type: 'string', example: 'https://qa.honeygate.app/openapi.json' },
    },
  },
  CreateCheckRequest: createCheckRequestSchema,
  CreateCheckResponse: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['payment_pending', 'queued', 'running', 'retryable', 'complete', 'failed'] },
      jobStatus: { type: 'string', enum: ['payment_pending', 'queued', 'running', 'retryable', 'complete', 'failed'] },
      nextAction: { type: 'string', enum: ['poll_same_job', 'inspect_report', 'stop'] },
      retryAfterSeconds: { type: 'integer' },
      idempotent: { type: 'boolean' },
      paymentReplay: { type: 'boolean' },
      pollUrl: { type: 'string' },
      paymentMode: { type: 'string', enum: ['test', 'testnet', 'production'] },
      paymentOutcome: {
        type: 'string',
        enum: ['unresolved'],
        description:
          'Present while settlement is not yet proven. Do not send another payment; poll pollUrl or repeat the request with the same payment.',
      },
      detail: { type: 'string' },
    },
  },
  CheckStatusResponse: {
    oneOf: [
      { $ref: '#/components/schemas/JobPending' },
      { $ref: '#/components/schemas/QAReport' },
      { $ref: '#/components/schemas/ExtractReport' },
      { $ref: '#/components/schemas/SecurityReport' },
      { $ref: '#/components/schemas/JobFailed' },
    ],
  },
  JobPending: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['payment_pending', 'queued', 'running', 'retryable'] },
      jobStatus: { type: 'string', enum: ['payment_pending', 'queued', 'running', 'retryable'] },
      nextAction: { type: 'string', const: 'poll_same_job' },
      retryAfterSeconds: { type: 'integer', const: 5 },
      createdAt: { type: 'string', format: 'date-time' },
      pollUrl: { type: 'string' },
      paymentOutcome: { type: 'string', enum: ['unresolved'] },
      detail: { type: 'string' },
    },
  },
  JobFailed: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['failed'] },
      jobStatus: { type: 'string', const: 'failed' },
      nextAction: { type: 'string', const: 'stop' },
      createdAt: { type: 'string', format: 'date-time' },
      error: { type: 'string' },
    },
  },
} as const
