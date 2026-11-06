import { describe, expect, it } from 'vitest'
import { summarizeAssertions } from '../src/worker/assertions.js'
import type { ViewportResult } from '../src/types.js'

describe('assertion summary', () => {
  it('counts unavailable observations separately from measured failures', () => {
    const unavailable = {
      assertion: { type: 'noHorizontalOverflow' as const },
      passed: false,
      measured: false,
      detail: 'Horizontal overflow could not be measured.',
    }
    const failed = {
      assertion: { type: 'noConsoleErrors' as const },
      passed: false,
      detail: 'One console error observed.',
    }
    const passed = {
      assertion: { type: 'noHorizontalOverflow' as const },
      passed: true,
      measured: true,
      detail: 'No horizontal overflow detected.',
    }
    const summary = summarizeAssertions({
      phonePortrait: { assertions: [unavailable, failed] } as ViewportResult,
      desktop: { assertions: [passed] } as ViewportResult,
    })
    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.unavailable).toBe(1)
    expect(summary.results.phonePortrait).toEqual([unavailable, failed])
  })

  it('has no failure when only an unmeasured assertion is present', () => {
    const summary = summarizeAssertions({
      desktop: {
        assertions: [{
          assertion: { type: 'noHorizontalOverflow' },
          passed: false,
          measured: false,
          detail: 'Horizontal overflow could not be measured.',
        }],
      } as ViewportResult,
    })
    expect(summary.failed).toBe(0)
    expect(summary.unavailable).toBe(1)
  })
})
