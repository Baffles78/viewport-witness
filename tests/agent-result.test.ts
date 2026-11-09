import { describe, it, expect } from 'vitest'
import { buildAgentResult } from '../src/agent-result.js'
import { NOW, PAST, makeViewport, makeReport } from './helpers/qa-report-fixtures.js'

describe('buildAgentResult', () => {
  describe('valid PASS report', () => {
    it('returns safe_to_ship for complete 3-viewport PASS with safe_to_ship verdict', () => {
      const result = buildAgentResult(makeReport(), { now: NOW })
      expect(result.schema).toBe('viewport-witness-agent-result/v1')
      expect(result.decision).toBe('safe_to_ship')
      expect(result.evidenceBound).toBe(true)
      expect(result.reportID).toBe('r001')
      expect(result.kind).toBe('check')
      expect(result.dataTrust).toBeTruthy()
    })

    it('does not include recheck for safe_to_ship', () => {
      const result = buildAgentResult(makeReport(), { now: NOW })
      expect(result.allowedNextSteps).not.toContain('recheck')
      expect(result.allowedNextSteps).toContain('inspect_report')
    })

    it('includes compare for check kind with complete evidence', () => {
      const result = buildAgentResult(makeReport({ kind: 'check' }), { now: NOW })
      expect(result.allowedNextSteps).toContain('compare')
    })

    it('excludes compare for verify kind', () => {
      const result = buildAgentResult(makeReport({ kind: 'verify' }), { now: NOW })
      expect(result.allowedNextSteps).not.toContain('compare')
    })

    it('excludes compare for extract kind', () => {
      const result = buildAgentResult(makeReport({ kind: 'extract' }), { now: NOW })
      expect(result.allowedNextSteps).not.toContain('compare')
    })

    it('excludes compare for security kind', () => {
      const result = buildAgentResult(makeReport({ kind: 'security' }), { now: NOW })
      expect(result.allowedNextSteps).not.toContain('compare')
    })

    it('is not safe_to_ship when blockingIssues > 0 despite safe_to_ship verdict', () => {
      const report = makeReport({
        verdict: {
          decision: 'safe_to_ship',
          blockingIssues: 1,
          warnings: 0,
          reasons: [],
          recommendedActions: [],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.decision).not.toBe('safe_to_ship')
    })

    it('is not safe_to_ship when evidenceBound is false', () => {
      const report = makeReport({
        viewports: {
          phonePortrait: { ...makeViewport('phonePortrait'), loadStatus: 'timeout' },
          phoneLandscape: makeViewport('phoneLandscape'),
          desktop: makeViewport('desktop'),
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.decision).not.toBe('safe_to_ship')
      expect(result.evidenceBound).toBe(false)
    })
  })

  describe('missing viewport evidence', () => {
    it('returns inconclusive when phonePortrait is absent', () => {
      const report = makeReport({
        viewports: {
          phoneLandscape: makeViewport('phoneLandscape'),
          desktop: makeViewport('desktop'),
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.decision).toBe('inconclusive')
      expect(result.evidenceBound).toBe(false)
    })

    it('returns inconclusive when all viewports are absent', () => {
      const result = buildAgentResult(makeReport({ viewports: {} }), { now: NOW })
      expect(result.decision).toBe('inconclusive')
    })

    it('does not include recheck or compare on missing viewport', () => {
      const report = makeReport({ viewports: { desktop: makeViewport('desktop') } })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.allowedNextSteps).not.toContain('recheck')
      expect(result.allowedNextSteps).not.toContain('compare')
      expect(result.allowedNextSteps).toContain('inspect_report')
    })
  })

  describe('expiry', () => {
    it('returns inconclusive for expired report', () => {
      const result = buildAgentResult(makeReport({ expiresAt: PAST }), { now: NOW })
      expect(result.decision).toBe('inconclusive')
    })

    it('does not include recheck or compare on expired report', () => {
      const result = buildAgentResult(makeReport({ expiresAt: PAST }), { now: NOW })
      expect(result.allowedNextSteps).not.toContain('recheck')
      expect(result.allowedNextSteps).not.toContain('compare')
      expect(result.allowedNextSteps).toContain('inspect_report')
    })

    it('treats invalid expiresAt date as expired', () => {
      const result = buildAgentResult(makeReport({ expiresAt: 'not-a-date' }), { now: NOW })
      expect(result.decision).toBe('inconclusive')
    })

    it('preserves expiresAt in result even when expired', () => {
      const result = buildAgentResult(makeReport({ expiresAt: PAST }), { now: NOW })
      expect(result.reportExpiresAt).toBe(PAST)
    })
  })

  describe('verdict mismatch', () => {
    it('returns inconclusive on PASS status with failed verdict', () => {
      const report = makeReport({
        status: 'PASS',
        verdict: {
          decision: 'failed',
          blockingIssues: 0,
          warnings: 0,
          reasons: [],
          recommendedActions: [],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.decision).toBe('inconclusive')
      expect(result.allowedNextSteps).not.toContain('recheck')
      expect(result.allowedNextSteps).not.toContain('compare')
    })

    it('returns inconclusive on FAIL status with safe_to_ship verdict', () => {
      const report = makeReport({
        status: 'FAIL',
        verdict: {
          decision: 'safe_to_ship',
          blockingIssues: 0,
          warnings: 0,
          reasons: [],
          recommendedActions: [],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.decision).toBe('inconclusive')
    })

    it('returns inconclusive on INCONCLUSIVE status with safe_to_ship verdict', () => {
      const report = makeReport({
        status: 'INCONCLUSIVE',
        verdict: {
          decision: 'safe_to_ship',
          blockingIssues: 0,
          warnings: 0,
          reasons: [],
          recommendedActions: [],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.decision).toBe('inconclusive')
    })
  })

  describe('review decision', () => {
    it('returns review for review verdict with FAIL status', () => {
      const report = makeReport({
        status: 'FAIL',
        verdict: {
          decision: 'review',
          blockingIssues: 0,
          warnings: 2,
          reasons: ['warnings'],
          recommendedActions: [],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.decision).toBe('review')
    })

    it('includes recheck for review decision', () => {
      const report = makeReport({
        status: 'FAIL',
        verdict: {
          decision: 'review',
          blockingIssues: 0,
          warnings: 1,
          reasons: [],
          recommendedActions: [],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.allowedNextSteps).toContain('recheck')
    })

    it('preserves review distinction from failed', () => {
      const review = makeReport({
        status: 'FAIL',
        verdict: {
          decision: 'review',
          blockingIssues: 0,
          warnings: 1,
          reasons: [],
          recommendedActions: [],
        },
      })
      const failed = makeReport({
        status: 'FAIL',
        verdict: {
          decision: 'failed',
          blockingIssues: 1,
          warnings: 0,
          reasons: [],
          recommendedActions: [],
        },
      })
      expect(buildAgentResult(review, { now: NOW }).decision).toBe('review')
      expect(buildAgentResult(failed, { now: NOW }).decision).toBe('failed')
    })
  })
})
