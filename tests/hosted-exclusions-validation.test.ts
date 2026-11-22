import { describe, expect, it } from 'vitest'
import { normalizeVisualExclusions, visualExclusionsSchema } from '../src/visual-exclusions.js'
import { sameJobIntent } from '../src/idempotency-replay.js'
import type { JobRecord } from '../src/types.js'
import { openApiSpec } from '../src/openapi.js'
import { createBazaarDiscovery } from '../src/payment/index.js'

const rect = { x: 0, y: 0, width: 10, height: 10 }
describe('hosted visual exclusion validation and identity', () => {
  it.each([
    null,
    [],
    { tablet: [] },
    { desktop: null },
    { desktop: [{ ...rect, selector: 'body' }] },
    { desktop: [{ ...rect, x: 0.1 }] },
    { desktop: [{ ...rect, width: 0 }] },
    { desktop: [{ ...rect, x: 1440 }] },
    { phonePortrait: [{ ...rect, x: 375 }] },
    { phoneLandscape: [{ ...rect, y: 375 }] },
    { desktop: Array.from({ length: 21 }, () => rect) },
    { desktop: [{ x: 0, y: 0, width: 1440, height: 181 }] },
  ])('rejects invalid hosted regions before admission: %j', (input) => {
    expect(visualExclusionsSchema.safeParse(input).success).toBe(false)
  })

  it('accepts exactly twenty percent and counts overlaps only once', () => {
    expect(
      normalizeVisualExclusions({
        desktop: [
          { x: 0, y: 0, width: 1440, height: 180 },
          { x: 0, y: 0, width: 1440, height: 180 },
        ],
      }),
    ).toEqual({ desktop: [{ x: 0, y: 0, width: 1440, height: 180 }] })
  })

  it('canonicalizes empty regions, viewport order, rectangle order and rectangle keys', () => {
    expect(normalizeVisualExclusions(undefined)).toEqual({})
    expect(normalizeVisualExclusions({ desktop: [], phonePortrait: [] })).toEqual({})
    expect(
      normalizeVisualExclusions({
        desktop: [{ height: 10, width: 10, y: 0, x: 20 }, rect, rect],
        phonePortrait: [],
      }),
    ).toEqual({ desktop: [rect, { x: 20, y: 0, width: 10, height: 10 }] })
  })

  it('keeps old requests compatible with empty exclusions and rejects changed or corrupt intent', () => {
    const job = {
      kind: 'compare',
      url: 'https://example.com',
      baselineJobId: 'base',
      request: {},
    } as JobRecord
    const intent = { kind: 'compare' as const, url: job.url, baselineJobId: 'base' }
    expect(sameJobIntent(job, { ...intent, visualExclusions: {} })).toBe(true)
    expect(sameJobIntent(job, { ...intent, visualExclusions: { desktop: [] } })).toBe(true)
    expect(sameJobIntent(job, { ...intent, visualExclusions: { desktop: [rect] } })).toBe(false)
    job.request.visualExclusions = { desktop: [rect] }
    expect(
      sameJobIntent(job, {
        ...intent,
        visualExclusions: { desktop: [{ height: 10, x: 0, width: 10, y: 0 }] },
      }),
    ).toBe(true)
    expect(sameJobIntent(job, intent)).toBe(false)
    job.request.visualExclusions = { desktop: [{ ...rect, width: 2000 }] }
    expect(sameJobIntent(job, intent)).toBe(false)
  })

  it('documents hosted request options and raw/filtered evidence without bloating discovery headers', () => {
    expect(
      openApiSpec.components.schemas.CompareRequest.properties.visualExclusions,
    ).toHaveProperty('additionalProperties', false)
    expect(
      openApiSpec.components.schemas.QAReport.properties.comparison.properties.visual
        .additionalProperties.properties,
    ).toHaveProperty('rawChangedPixels')
    const metadata = JSON.stringify(createBazaarDiscovery('POST /v1/compare'))
    expect(metadata).toContain('visualExclusions')
    expect(metadata).toContain('/openapi.json')
  })
})
