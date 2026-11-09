import { describe, expect, it } from 'vitest'
import { buildVerdict as build } from '../src/worker/verdict.js'

type Verdict = {
  decision: string
  blockingIssues: number
  warnings: number
  reasons: string[]
  recommendedActions: Array<{ code: string; viewport?: string }>
}
const buildVerdict = (status: string, viewports: Record<string, unknown>): Verdict =>
  build(status as never, viewports as never) as Verdict

function clean(overrides: Record<string, unknown> = {}) {
  return {
    loadStatus: 'success',
    pageCrash: false,
    consoleErrors: [],
    failedRequests: [],
    overflowDetected: false,
    offscreenElements: 0,
    accessibility: { completed: true, violations: [] },
    ...overrides,
  }
}

describe('machine verdict', () => {
  it('is safe to ship when every viewport is clean', () => {
    const verdict = buildVerdict('PASS', { phonePortrait: clean(), desktop: clean() })
    expect(verdict).toEqual({
      decision: 'safe_to_ship',
      blockingIssues: 0,
      warnings: 0,
      reasons: ['All required checks passed across all three viewports.'],
      recommendedActions: [],
    })
  })

  it('counts each blocking problem and names the viewport', () => {
    const verdict = buildVerdict('FAIL', {
      phonePortrait: clean({
        loadStatus: 'timeout',
        consoleErrors: ['boom'],
        overflowDetected: true,
        accessibility: {
          completed: true,
          violations: [{ impact: 'serious' }, { impact: 'critical' }, { impact: 'minor' }],
        },
      }),
    })
    expect(verdict.decision).toBe('failed')
    expect(verdict.blockingIssues).toBe(5)
    expect(verdict.warnings).toBe(1)
    expect(verdict.recommendedActions.map((a) => a.code)).toEqual([
      'load_failure',
      'accessibility',
      'browser_errors',
      'layout',
    ])
    expect(verdict.recommendedActions.every((a) => a.viewport === 'phonePortrait')).toBe(true)
  })

  it('asks for a retry when evidence is incomplete', () => {
    const verdict = buildVerdict('INCONCLUSIVE', { desktop: clean() })
    expect(verdict.decision).toBe('review')
    expect(verdict.warnings).toBe(1)
    expect(verdict.recommendedActions).toEqual([
      { code: 'incomplete_evidence', priority: 'medium', detail: 'Retry the check before shipping.' },
    ])
  })
})
