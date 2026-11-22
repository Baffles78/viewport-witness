import { declareDiscoveryExtension } from '@x402/extensions/bazaar'
import type { PaymentMiddlewareOptions } from './index.js'

// Bazaar discovery extension: describes the request/response schema for marketplace indexing.
// Request fields vary by product. Response: accepted 202 job, not the eventual report.
export function createBazaarDiscovery(route: PaymentMiddlewareOptions['route']) {
  const input =
    route === 'POST /v1/verify'
      ? { url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }] }
      : route === 'POST /v1/compare'
        ? { url: 'https://example.com', baselineJobId: '550e8400-e29b-41d4-a716-446655440000' }
        : route === 'POST /v1/history'
          ? { url: 'https://example.com', limit: 5 }
          : { url: 'https://example.com' }
  const properties: Record<string, unknown> = {
    url: {
      type: 'string',
      format: 'uri',
      description: 'Public HTTPS URL to check',
      example: 'https://example.com',
    },
  }
  const required = ['url']
  if (route === 'POST /v1/verify') {
    properties['assertions'] = {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description: 'Pass/fail assertions',
      items: {
        type: 'object',
        description:
          'noHorizontalOverflow|noConsoleErrors|textVisible|titleIncludes|selectorExists|selectorVisible',
      },
    }
    required.push('assertions')
  }
  if (route === 'POST /v1/compare') {
    properties['baselineJobId'] = {
      type: 'string',
      format: 'uuid',
      description: 'Completed, unexpired ViewportWitness check job used as the visual baseline.',
    }
    // Full rectangle schema is in OpenAPI; challenge headers have a 4 KiB budget.
    properties['visualExclusions'] = {
      type: 'object',
      description: 'Viewport rectangles; see /openapi.json.',
    }
    required.push('baselineJobId')
  }
  if (route === 'POST /v1/extract') {
    properties['maxOutputTokens'] = {
      type: 'integer',
      minimum: 500,
      maximum: 12000,
      description: 'Optional approximate Markdown output budget.',
    }
  }
  if (route === 'POST /v1/history') {
    properties['limit'] = {
      type: 'integer',
      minimum: 1,
      description: 'Maximum archived snapshots to return, newest first.',
    }
    properties['before'] = {
      type: 'string',
      format: 'date-time',
      description: 'Only return snapshots captured before this time, for paging.',
    }
    return declareDiscoveryExtension({
      bodyType: 'json',
      input,
      inputSchema: { type: 'object', required, additionalProperties: false, properties },
      output: {
        example: {
          url: 'https://example.com/',
          snapshots: [
            {
              snapshotId: '550e8400-e29b-41d4-a716-446655440000',
              capturedAt: '2026-10-01T12:00:00.000Z',
              status: 'PASS',
              snapshotUrl: '/v1/history/snapshots/550e8400-e29b-41d4-a716-446655440000',
            },
          ],
          nextBefore: null,
        },
        schema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            snapshots: { type: 'array', items: { type: 'object' } },
            nextBefore: { type: ['string', 'null'] },
          },
          required: ['url', 'snapshots', 'nextBefore'],
        },
      },
    })
  }
  const isCheck = route === 'POST /v1/checks'
  const jobStatuses = ['payment_pending', 'queued', 'running', 'retryable', 'complete', 'failed']
  return declareDiscoveryExtension({
    bodyType: 'json',
    input,
    inputSchema: {
      type: 'object',
      required,
      additionalProperties: false,
      properties,
    },
    output: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'queued',
        ...(isCheck ? { jobStatus: 'queued', nextAction: 'poll_same_job' } : {}),
        pollUrl: '/v1/checks/550e8400-e29b-41d4-a716-446655440000',
        paymentMode: 'production',
      },
      // Kept compact: this travels in the 402 PAYMENT-REQUIRED header, which
      // must fit the production proxy's 4 KiB header buffer. Optional replay
      // and reconciliation fields are documented in OpenAPI instead.
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: jobStatuses },
          ...(isCheck ? {
            jobStatus: { type: 'string' },
            nextAction: { type: 'string', enum: ['poll_same_job', 'inspect_report', 'stop'] },
          } : {}),
          pollUrl: { type: 'string' },
          paymentMode: { type: 'string', enum: ['testnet', 'production'] },
        },
        required: [
          'id', 'status', 'pollUrl', 'paymentMode',
          ...(isCheck ? ['jobStatus', 'nextAction'] : []),
        ],
      },
    },
  })
}

