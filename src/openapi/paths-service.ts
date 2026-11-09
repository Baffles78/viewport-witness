// OpenAPI section: Free service, discovery and document routes.
export const serviceInfoPaths = {
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
  '/agents': {
    get: {
      summary: 'Agent discovery and tool-selection guide',
      operationId: 'getAgentLanding',
      security: [],
      responses: {
        '200': {
          description: 'Indexable guide mapping common website-testing intents to MCP tools',
          content: { 'text/html': {} },
        },
      },
    },
  },
  '/robots.txt': {
    get: {
      summary: 'Crawler policy',
      operationId: 'getRobotsTxt',
      security: [],
      responses: {
        '200': {
          description: 'Crawler access policy with sitemap location',
          content: { 'text/plain': {} },
        },
      },
    },
  },
  '/sitemap.xml': {
    get: {
      summary: 'Public discovery sitemap',
      operationId: 'getSitemap',
      security: [],
      responses: {
        '200': {
          description: 'Sitemap for agent-facing public documentation',
          content: { 'application/xml': {} },
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
} as const
