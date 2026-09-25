import { describe, it, expect } from 'vitest'
import { openApiSpec } from '../src/openapi.js'

type PathItem = Record<string, unknown>
type Operation = {
  security?: Array<Record<string, unknown>>
  'x-payment-info'?: {
    protocols: Array<{ x402: Record<string, never> }>
    price: { mode: string; amount: string; currency: string }
  }
  responses?: Record<string, unknown>
  requestBody?: {
    content?: {
      'application/json'?: {
        example?: unknown
      }
    }
  }
}

const paths = openApiSpec.paths as Record<string, PathItem>

function getOp(path: string, method: string): Operation {
  const item = paths[path]
  if (!item) throw new Error(`path ${path} not found`)
  const op = item[method] as Operation | undefined
  if (!op) throw new Error(`${method} ${path} not found`)
  return op
}

const FREE_OPERATIONS: Array<[string, string]> = [
  ['/', 'get'],
  ['/health', 'get'],
  ['/ready', 'get'],
  ['/.well-known/x402', 'get'],
  ['/skill.md', 'get'],
  ['/privacy', 'get'],
  ['/terms', 'get'],
  ['/logo.png', 'get'],
  ['/mcp', 'post'],
  ['/v1/checks/{id}', 'get'],
  ['/v1/checks/{id}/screenshots/{viewport}', 'get'],
]

const PAID_OPERATIONS: Array<[string, string, string]> = [
  ['/v1/checks', 'post', '0.08'],
  ['/v1/verify', 'post', '0.10'],
  ['/v1/compare', 'post', '0.12'],
  ['/v1/extract', 'post', '0.005'],
  ['/v1/security-gate', 'post', '0.05'],
]

describe('openapi spec — free route security', () => {
  for (const [path, method] of FREE_OPERATIONS) {
    it(`${method.toUpperCase()} ${path} has explicit security: []`, () => {
      const op = getOp(path, method)
      expect(op.security).toBeDefined()
      expect(op.security).toEqual([])
    })
  }
})

describe('openapi spec — /mcp excluded from HTTP x402 payment probing', () => {
  it('POST /mcp is explicitly public at the HTTP transport layer', () => {
    const op = getOp('/mcp', 'post')
    expect(op.security).toEqual([])
  })

  it('POST /mcp has no x-payment-info', () => {
    const op = getOp('/mcp', 'post')
    expect(op['x-payment-info']).toBeUndefined()
  })
})

describe('openapi spec — report value fields', () => {
  it('documents deterministic diagnosis and bounded performance evidence', () => {
    const schemas = openApiSpec.components.schemas as Record<
      string,
      { properties?: Record<string, unknown> }
    >
    expect(schemas['QAReport']?.properties).toHaveProperty('diagnosis')
    expect(schemas['ViewportResult']?.properties).toHaveProperty('performance')
    expect(schemas['ViewportResult']?.properties).toHaveProperty('layoutLocatorHints')
  })
})

describe('openapi spec — paid route security', () => {
  for (const [path, method] of PAID_OPERATIONS) {
    it(`${method.toUpperCase()} ${path} uses x402Payment security scheme`, () => {
      const op = getOp(path, method)
      expect(op.security).toBeDefined()
      expect(Array.isArray(op.security)).toBe(true)
      const hasX402 = (op.security ?? []).some((req) => 'x402Payment' in req)
      expect(hasX402).toBe(true)
    })

    it(`${method.toUpperCase()} ${path} has a 402 response`, () => {
      const op = getOp(path, method)
      expect((op.responses as Record<string, unknown>)['402']).toBeDefined()
    })

    it(`${method.toUpperCase()} ${path} has canonical x402 protocol metadata`, () => {
      const op = getOp(path, method)
      const info = op['x-payment-info']
      expect(info).toBeDefined()
      expect(info!.protocols).toEqual([{ x402: {} }])
    })

    it(`${method.toUpperCase()} ${path} has fixed USD pricing`, () => {
      const op = getOp(path, method)
      expect(op['x-payment-info']!.price.mode).toBe('fixed')
      expect(op['x-payment-info']!.price.currency).toBe('USD')
    })
  }

  for (const [path, method] of PAID_OPERATIONS) {
    it(`${method.toUpperCase()} ${path} documents PAYMENT-REQUIRED challenge header`, () => {
      const response = getOp(path, method).responses?.['402'] as {
        headers?: Record<string, unknown>
      }
      expect(response.headers?.['PAYMENT-REQUIRED']).toBeDefined()
      expect(response.headers?.['PAYMENT-RESPONSE']).toBeUndefined()
    })
  }

  it('POST /v1/checks x-payment-info amount is 0.08', () => {
    expect(getOp('/v1/checks', 'post')['x-payment-info']!.price.amount).toBe('0.08')
  })

  it('POST /v1/verify x-payment-info amount is 0.10', () => {
    expect(getOp('/v1/verify', 'post')['x-payment-info']!.price.amount).toBe('0.10')
  })

  it('POST /v1/compare x-payment-info amount is 0.12', () => {
    expect(getOp('/v1/compare', 'post')['x-payment-info']!.price.amount).toBe('0.12')
  })
})

describe('openapi spec — x402Payment security scheme defined', () => {
  it('components.securitySchemes.x402Payment is defined', () => {
    const schemes = (
      openApiSpec.components as unknown as {
        securitySchemes: Record<string, unknown>
      }
    ).securitySchemes
    expect(schemes).toBeDefined()
    expect(schemes['x402Payment']).toBeDefined()
  })

  it('x402Payment scheme targets the PAYMENT-SIGNATURE header', () => {
    const scheme = (
      openApiSpec.components as unknown as {
        securitySchemes: { x402Payment: { type: string; in: string; name: string } }
      }
    ).securitySchemes.x402Payment
    expect(scheme.type).toBe('apiKey')
    expect(scheme.in).toBe('header')
    expect(scheme.name).toBe('PAYMENT-SIGNATURE')
  })
})

describe('openapi spec — paid route request body examples', () => {
  it('POST /v1/checks example uses https://example.com', () => {
    const op = getOp('/v1/checks', 'post')
    const example = op.requestBody?.content?.['application/json']?.example as { url?: string }
    expect(example?.url).toBe('https://example.com')
  })

  it('POST /v1/verify example uses https://example.com', () => {
    const op = getOp('/v1/verify', 'post')
    const example = op.requestBody?.content?.['application/json']?.example as {
      url?: string
      assertions?: Array<{ type: string; value?: string }>
    }
    expect(example?.url).toBe('https://example.com')
  })

  it('POST /v1/verify example includes a title assertion', () => {
    const op = getOp('/v1/verify', 'post')
    const example = op.requestBody?.content?.['application/json']?.example as {
      assertions?: Array<{ type: string; value?: string }>
    }
    expect(Array.isArray(example?.assertions)).toBe(true)
    const titleAssertion = example!.assertions!.find((a) => a.type === 'titleIncludes')
    expect(titleAssertion).toBeDefined()
    expect(typeof titleAssertion!.value).toBe('string')
    expect(titleAssertion!.value!.length).toBeGreaterThan(0)
  })

  it('POST /v1/compare example uses https://example.com', () => {
    const op = getOp('/v1/compare', 'post')
    const example = op.requestBody?.content?.['application/json']?.example as {
      url?: string
      baselineJobId?: string
    }
    expect(example?.url).toBe('https://example.com')
  })

  it('POST /v1/compare example has a valid UUID baselineJobId', () => {
    const op = getOp('/v1/compare', 'post')
    const example = op.requestBody?.content?.['application/json']?.example as {
      baselineJobId?: string
    }
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect(example?.baselineJobId).toMatch(uuidPattern)
  })
})
