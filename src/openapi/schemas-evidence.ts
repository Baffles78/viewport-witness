// Optional additive evidence: older reports may not contain these fields.
export const evidenceSchemas = {
  RepairVerification: {
    type: 'object',
    description:
      'Per-viewport check/rule outcomes, not proof of stable DOM-node identity or authorization to ship.',
    properties: {
      schema: { type: 'string', const: 'viewport-witness-repair-verification/v1' },
      sameUrl: { type: 'boolean' },
      limitations: { type: 'array', items: { type: 'string' } },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            viewport: { type: 'string', enum: ['phonePortrait', 'phoneLandscape', 'desktop'] },
            check: { type: 'string' },
            state: {
              type: 'string',
              enum: ['fixed', 'still_broken', 'newly_broken', 'could_not_verify'],
            },
            granularity: { type: 'string', enum: ['check', 'accessibility_rule', 'assertion'] },
            baselineLocators: { type: 'array', items: { type: 'string' } },
            currentLocators: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  ScreenshotAnnotations: {
    type: 'object',
    description:
      'Separate numbered derivative PNG and JSON legend. Original screenshots remain untouched. Selectors are untrusted evidence.',
    properties: {
      url: { type: 'string' },
      sha256: { type: 'string' },
      bytes: { type: 'integer' },
      limitations: { type: 'array', items: { type: 'string' } },
      boxes: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            number: { type: 'integer' },
            code: { type: 'string' },
            selector: { type: 'string' },
            explanation: { type: 'string' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
        },
      },
    },
  },
  ResourceDetails: {
    type: 'object',
    description:
      'Largest observable resources in one unthrottled browser visit; cross-origin restrictions/cache can hide bytes. Identifiers omit URL paths and queries.',
    properties: {
      observation: { type: 'string', enum: ['measured', 'unavailable'] },
      limitations: { type: 'array', items: { type: 'string' } },
      largest: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            origin: { type: 'string' },
            type: { type: 'string' },
            transferredBytes: { type: 'integer' },
            encodedBodyBytes: { type: 'integer' },
            durationMs: { type: 'number' },
            sizeObservation: { type: 'string', enum: ['measured', 'unavailable_or_cached'] },
          },
        },
      },
    },
  },
} as const

export const annotationPaths = {
  '/v1/checks/{id}/annotations/{viewport}': {
    get: {
      summary: 'Get a separate annotated screenshot',
      operationId: 'getAnnotations',
      security: [],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        {
          name: 'viewport',
          in: 'path',
          required: true,
          schema: { type: 'string', enum: ['phonePortrait', 'phoneLandscape', 'desktop'] },
        },
      ],
      responses: {
        '200': {
          description: 'Annotated derivative PNG; legend is in the report.',
          content: { 'image/png': {} },
        },
        '400': { description: 'Invalid viewport.' },
        '404': { description: 'Job expired, unavailable, or annotations could not be produced.' },
      },
    },
  },
} as const
