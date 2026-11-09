// OpenAPI section: Per-viewport results, accessibility findings and errors.
export const viewportSchemas = {
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
      layoutObservation: {
        type: 'string',
        enum: ['measured', 'unavailable'],
        description: 'Unavailable when the layout evaluation failed or timed out; zero overflow values then do not imply a clean layout.',
      },
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
          keyboardReachable: {
            type: 'boolean',
            description: 'Legacy compatibility field: potential focusability only, not verified Tab traversal or keyboard activation.',
          },
          keyboardObservation: {
            type: 'string',
            enum: ['focusability_heuristic', 'unavailable'],
            description: 'The focusability heuristic does not verify keyboard traversal or activation.',
          },
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
      nextAction: { type: 'string', enum: ['stop', 'retry_lookup'] },
      retryAfterSeconds: { type: 'integer' },
    },
  },
} as const
