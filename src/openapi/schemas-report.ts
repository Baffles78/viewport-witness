import { FEEDBACK_URL } from '../public.js'

// OpenAPI section: QA report, agent result and assertion results.
export const reportSchemas = {
  QAReport: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      url: { type: 'string' },
      kind: { type: 'string', enum: ['check', 'verify', 'compare'] },
      status: { type: 'string', enum: ['PASS', 'FAIL', 'INCONCLUSIVE'] },
      jobStatus: { type: 'string', const: 'complete' },
      nextAction: { type: 'string', const: 'inspect_report' },
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
      agent: { $ref: '#/components/schemas/AgentResult' },
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
      assertions: {
        type: 'object',
        description: 'Verify result counts. Unavailable assertions were not measured and are excluded from failed.',
        properties: {
          passed: { type: 'integer' },
          failed: { type: 'integer' },
          unavailable: { type: 'integer' },
          results: {
            type: 'object',
            properties: {
              phonePortrait: { type: 'array', items: { $ref: '#/components/schemas/AssertionResult' } },
              phoneLandscape: { type: 'array', items: { $ref: '#/components/schemas/AssertionResult' } },
              desktop: { type: 'array', items: { $ref: '#/components/schemas/AssertionResult' } },
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
  AgentResult: {
    type: 'object',
    required: [
      'schema',
      'reportID',
      'kind',
      'decision',
      'reportExpiresAt',
      'evidenceBound',
      'findings',
      'allowedNextSteps',
      'dataTrust',
    ],
    description:
      'Bounded browser evidence for agent callers. Does not authorize deployment, fixes or payment. Re-evaluated at report retrieval.',
    properties: {
      schema: { type: 'string', const: 'viewport-witness-agent-result/v1' },
      reportID: { type: 'string' },
      kind: { type: 'string' },
      decision: { type: 'string', enum: ['safe_to_ship', 'review', 'failed', 'inconclusive'] },
      reportExpiresAt: { type: 'string' },
      evidenceBound: { type: 'boolean' },
      dataTrust: { type: 'string' },
      allowedNextSteps: {
        type: 'array',
        items: { type: 'string', enum: ['inspect_report', 'recheck', 'compare', 'none'] },
      },
      findings: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            viewports: {
              type: 'array',
              items: { type: 'string', enum: ['phonePortrait', 'phoneLandscape', 'desktop'] },
            },
            locators: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
            fix: { type: 'string', maxLength: 500 },
          },
        },
      },
      comparisonBaseline: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      recheck: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: ['check_page', 'verify_page'] },
          assertions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['noHorizontalOverflow', 'noConsoleErrors'] },
              },
            },
          },
          requiresFreshBudget: { type: 'boolean', const: true },
          requiresCallerFix: { type: 'boolean', const: true },
        },
      },
    },
  },
  AssertionResult: {
    type: 'object',
    required: ['assertion', 'passed', 'detail'],
    properties: {
      assertion: { type: 'object' },
      passed: { type: 'boolean', description: 'True only when the assertion was measured and passed.' },
      measured: { type: 'boolean', description: 'False means the assertion could not be measured; it is neither a pass nor a failure.' },
      detail: { type: 'string' },
    },
  },
} as const
