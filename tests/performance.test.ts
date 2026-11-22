import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { collectPerformanceEvidence, summarizeResources } from '../src/worker/performance.js'

describe('passive resource evidence', () => {
  it('ranks bounded resources and redacts paths, credentials, queries and unexpected types', () => {
    const entries = Array.from({ length: 105 }, (_, index) => ({
      name: `https://user:secret@cdn.example.test/private/customer-${index}?token=secret#private`,
      initiatorType: index === 99 ? 'secret-value' : 'script',
      transferSize: index * 10,
      encodedBodySize: index * 20,
      duration: index + 0.4,
    }))
    const result = summarizeResources(entries)
    expect(result).toHaveLength(10)
    expect(result[0]).toEqual({
      index: 100,
      origin: 'https://cdn.example.test',
      type: 'other',
      transferredBytes: 990,
      encodedBodyBytes: 1980,
      durationMs: 99,
      sizeObservation: 'measured',
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|private|token|customer/)
  })

  it('does not turn hidden or invalid size evidence into a claim of a free transfer', () => {
    const result = summarizeResources([
      {
        name: 'data:text/plain,secret',
        initiatorType: 'img',
        transferSize: 0,
        encodedBodySize: 0,
        duration: NaN,
      },
      {
        name: 'https://example.test/a',
        initiatorType: 'script',
        transferSize: Infinity,
        encodedBodySize: -1,
        duration: -10,
      },
    ])
    expect(result.every((resource) => resource.sizeObservation === 'unavailable_or_cached')).toBe(
      true,
    )
    expect(result[0]?.origin).toBe('[redacted]')
    expect(result.every((resource) => resource.durationMs === undefined)).toBe(true)
  })

  it('keeps request totals and labels page timing failure as unavailable', async () => {
    const page = {
      evaluate: async () => {
        throw new Error('closed')
      },
    } as unknown as Page
    const result = await collectPerformanceEvidence(page, {
      requestCount: 4,
      transferredBytes: 234,
    })
    expect(result.resources).toEqual({ requestCount: 4, transferredBytes: 234 })
    expect(result.resourceDetails.observation).toBe('unavailable')
    expect(result.resourceDetails.largest).toEqual([])
    expect(result.navigation).toEqual({})
    expect(result.resourceDetails.limitations.join(' ')).toMatch(/not field performance/)
  })
})
