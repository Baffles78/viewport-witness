import { FEEDBACK_URL } from './public.js'

/** Security requirement array for paid x402 operations */
const x402Security = [{ x402Payment: [] }]

const createCheckRequestSchema = {
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

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'ViewportWitness by Apex Labs',
    version: '0.2.0',
    'x-guidance':
      'Use POST /v1/checks for general browser QA, POST /v1/verify for explicit assertions, and POST /v1/compare when you already have a completed baseline job. Each paid operation returns an x402 challenge before work begins.',
    description:
      'Machine-facing browser QA API. Submit a public HTTPS URL and receive screenshots, ' +
      'accessibility findings, layout analysis, and a structured report across three browser viewports. ' +
      'x402 payment is required per report on the live service; see /.well-known/x402 for current payment options. ' +
      'Self-hosted instances can run in test mode without payment.',
    contact: {
      url: FEEDBACK_URL,
    },
  },
  servers: [
    { url: 'https://qa.honeygate.app', description: 'Live service' },
    { url: 'http://localhost:3000', description: 'Local development (test mode, no payment)' },
  ],
  paths: {
    '/': {
      get: {
        summary: 'Service info card',
        operationId: 'getRoot',
        security: [],
        responses: {
          '200': {
            description: 'Service links and version',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ServiceInfo' },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        summary: 'Process liveness',
        operationId: 'getHealth',
        security: [],
        responses: {
          '200': {
            description: 'Process is alive',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/ready': {
      get: {
        summary: 'Readiness probe',
        operationId: 'getReady',
        security: [],
        responses: {
          '200': {
            description: 'Service is ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReadyResponse' },
              },
            },
          },
          '503': {
            description: 'Service not ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReadyResponse' },
              },
            },
          },
        },
      },
    },
    '/.well-known/x402': {
      get: {
        summary: 'x402 payment discovery',
        operationId: 'getPaymentDiscovery',
        security: [],
        responses: {
          '200': {
            description: 'Payment configuration for x402 clients',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PaymentDiscovery' },
              },
            },
          },
        },
      },
    },
    '/.well-known/mcp.json': {
      get: {
        summary: 'MCP registry manifest for directory crawlers',
        operationId: 'getMcpDiscovery',
        security: [],
        responses: {
          '200': {
            description: 'Official-registry metadata exposed for compatible directory probes',
            content: { 'application/json': {} },
          },
        },
      },
    },
    '/skill.md': {
      get: {
        summary: 'Agent skill manifest',
        operationId: 'getSkillMd',
        security: [],
        responses: {
          '200': {
            description: 'Concise agent-facing instructions for this service',
            content: { 'text/markdown': {} },
          },
        },
      },
    },
    '/privacy': {
      get: {
        summary: 'Privacy policy',
        operationId: 'getPrivacy',
        security: [],
        responses: {
          '200': {
            description:
              'Privacy policy covering submitted URLs, screenshots, payment identifiers, and data retention',
            content: { 'text/markdown': {} },
          },
        },
      },
    },
    '/terms': {
      get: {
        summary: 'Terms of service',
        operationId: 'getTerms',
        security: [],
        responses: {
          '200': {
            description:
              'Terms of service covering paid automated QA, non-mutating behavior, report expiry, and crypto payment finality',
            content: { 'text/markdown': {} },
          },
        },
      },
    },
    '/logo.png': {
      get: {
        summary: 'ViewportWitness logo',
        operationId: 'getLogo',
        security: [],
        responses: {
          '200': {
            description: 'Square PNG logo for directories and integrations',
            content: { 'image/png': {} },
          },
        },
      },
    },
    '/mcp': {
      post: {
        summary: 'Remote MCP interface for AI agents',
        operationId: 'mcp',
        security: [],
        description:
          'Stateless Streamable HTTP MCP endpoint. Paid tools use the x402 MCP payment transport.',
        responses: { '200': { description: 'MCP JSON-RPC response' } },
      },
    },
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
  },
  components: {
    securitySchemes: {
      x402Payment: {
        type: 'apiKey',
        in: 'header',
        name: 'PAYMENT-SIGNATURE',
        description:
          'x402 payment header. Include a signed payment payload for the required amount. ' +
          'See /.well-known/x402 for accepted networks and amounts.',
      },
    },
    schemas: {
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
          status: { type: 'string', enum: ['queued'] },
          pollUrl: { type: 'string' },
          paymentMode: { type: 'string', enum: ['test', 'testnet', 'production'] },
        },
      },
      CheckStatusResponse: {
        oneOf: [
          { $ref: '#/components/schemas/JobPending' },
          { $ref: '#/components/schemas/QAReport' },
          { $ref: '#/components/schemas/JobFailed' },
        ],
      },
      JobPending: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['queued', 'running'] },
          createdAt: { type: 'string', format: 'date-time' },
          pollUrl: { type: 'string' },
        },
      },
      JobFailed: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['failed'] },
          createdAt: { type: 'string', format: 'date-time' },
          error: { type: 'string' },
        },
      },
      QAReport: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          url: { type: 'string' },
          kind: { type: 'string', enum: ['check', 'verify', 'compare'] },
          status: { type: 'string', enum: ['PASS', 'FAIL', 'INCONCLUSIVE'] },
          paymentMode: { type: 'string', enum: ['test', 'testnet', 'production'] },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          checksPerformed: { type: 'array', items: { type: 'string' } },
          limitations: { type: 'array', items: { type: 'string' } },
          contentHash: {
            type: 'string',
            description:
              'SHA-256 of report content. Evidence of integrity, not a cryptographic signature.',
          },
          feedbackUrl: { type: 'string', example: FEEDBACK_URL },
          summary: {
            type: 'object',
            properties: {
              totalViolations: { type: 'integer' },
              criticalViolations: { type: 'integer' },
              totalErrors: { type: 'integer' },
              overallLoadStatus: { type: 'string' },
            },
          },
          verdict: {
            type: 'object',
            required: ['decision', 'blockingIssues', 'warnings', 'reasons', 'recommendedActions'],
            properties: {
              decision: { type: 'string', enum: ['safe_to_ship', 'review', 'failed'] },
              blockingIssues: { type: 'integer' },
              warnings: { type: 'integer' },
              reasons: { type: 'array', items: { type: 'string' } },
              recommendedActions: { type: 'array', items: { type: 'object' } },
            },
          },
          diagnosis: {
            type: 'object',
            required: ['overview', 'findings'],
            description:
              'Bounded, deterministic plain-English diagnosis and repair guidance derived from collected evidence.',
            properties: {
              overview: { type: 'string' },
              findings: {
                type: 'array',
                maxItems: 12,
                items: {
                  type: 'object',
                  required: ['code', 'severity', 'viewports', 'diagnosis', 'fix', 'locatorHints'],
                  properties: {
                    code: { type: 'string' },
                    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                    viewports: {
                      type: 'array',
                      items: {
                        type: 'string',
                        enum: ['phonePortrait', 'phoneLandscape', 'desktop'],
                      },
                    },
                    diagnosis: { type: 'string' },
                    fix: { type: 'string' },
                    locatorHints: {
                      type: 'array',
                      maxItems: 5,
                      description:
                        'Structural tag and nth-of-type hints only; page text and element attributes are excluded.',
                      items: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          viewports: {
            type: 'object',
            properties: {
              phonePortrait: { $ref: '#/components/schemas/ViewportResult' },
              phoneLandscape: { $ref: '#/components/schemas/ViewportResult' },
              desktop: { $ref: '#/components/schemas/ViewportResult' },
            },
          },
        },
      },
      ViewportResult: {
        type: 'object',
        properties: {
          viewport: { type: 'string', enum: ['phonePortrait', 'phoneLandscape', 'desktop'] },
          dimensions: {
            type: 'object',
            properties: {
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
          loadStatus: { type: 'string', enum: ['success', 'timeout', 'error'] },
          loadTimeMs: { type: 'integer' },
          finalUrl: { type: 'string' },
          redirectCount: { type: 'integer' },
          screenshotUrl: { type: 'string' },
          screenshotDimensions: {
            type: 'object',
            properties: {
              w: { type: 'integer' },
              h: { type: 'integer' },
            },
          },
          screenshotBytes: { type: 'integer' },
          screenshotSha256: { type: 'string' },
          consoleErrors: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          pageCrash: { type: 'boolean' },
          failedRequests: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                status: { type: 'integer', nullable: true },
                reason: { type: 'string' },
              },
            },
          },
          overflowDetected: { type: 'boolean' },
          offscreenElements: { type: 'integer' },
          layoutLocatorHints: {
            type: 'array',
            maxItems: 5,
            items: { type: 'string' },
          },
          performance: {
            type: 'object',
            description:
              'Bounded timing and transfer evidence collected during the existing page load; no extra browsing is performed.',
            properties: {
              navigation: {
                type: 'object',
                properties: {
                  dnsMs: { type: 'number' },
                  connectMs: { type: 'number' },
                  tlsMs: { type: 'number' },
                  requestMs: { type: 'number' },
                  responseMs: { type: 'number' },
                  timeToFirstByteMs: { type: 'number' },
                  domInteractiveMs: { type: 'number' },
                  domContentLoadedMs: { type: 'number' },
                  loadEventMs: { type: 'number' },
                },
              },
              paint: {
                type: 'object',
                properties: {
                  firstPaintMs: { type: 'number' },
                  firstContentfulPaintMs: { type: 'number' },
                  largestContentfulPaintMs: { type: 'number' },
                  cumulativeLayoutShift: { type: 'number' },
                },
              },
              resources: {
                type: 'object',
                required: ['requestCount', 'transferredBytes'],
                properties: {
                  requestCount: { type: 'integer', maximum: 101 },
                  transferredBytes: { type: 'integer', maximum: 15728640 },
                },
              },
            },
          },
          accessibility: {
            type: 'object',
            properties: {
              completed: { type: 'boolean' },
              violations: {
                type: 'array',
                items: { $ref: '#/components/schemas/AccessibilityViolation' },
              },
              passes: { type: 'integer' },
              incomplete: { type: 'integer' },
              impact: { type: 'object', additionalProperties: { type: 'integer' } },
            },
          },
          interactionObservations: {
            type: 'object',
            properties: {
              visibleControls: { type: 'integer' },
              focusableControls: { type: 'integer' },
              keyboardReachable: { type: 'boolean' },
            },
          },
        },
      },
      AccessibilityViolation: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          impact: {
            type: 'string',
            enum: ['critical', 'serious', 'moderate', 'minor'],
            nullable: true,
          },
          description: { type: 'string' },
          helpUrl: { type: 'string' },
          nodes: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                html: { type: 'string' },
                failureSummary: { type: 'string' },
                locator: {
                  type: 'string',
                  description:
                    'Bounded structural locator made only from tag names and nth-of-type positions.',
                },
              },
            },
          },
          count: { type: 'integer' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          detail: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
} as const
