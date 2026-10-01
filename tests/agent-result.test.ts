import { describe, it, expect } from 'vitest'
import { buildAgentResult } from '../src/agent-result.js'
import type { QAReport, Viewport, ViewportResult } from '../src/types.js'

const NOW = '2026-10-01T12:00:00.000Z'
const FUTURE = '2026-10-08T00:00:00.000Z'
const PAST = '2026-09-01T00:00:00.000Z'

function makeViewport(vp: Viewport): ViewportResult {
  return {
    viewport: vp,
    dimensions: { width: 375, height: 812 },
    loadStatus: 'success',
    loadTimeMs: 1000,
    finalUrl: 'https://example.com',
    redirectCount: 0,
    screenshotUrl: `/v1/checks/r001/screenshots/${vp}`,
    screenshotDimensions: { w: 375, h: 812 },
    screenshotBytes: 10000,
    screenshotSha256: `sha256-${vp}`,
    consoleErrors: [],
    pageCrash: false,
    failedRequests: [],
    overflowDetected: false,
    offscreenElements: 0,
    layoutLocatorHints: [],
    performance: {
      navigation: {},
      paint: {},
      resources: { requestCount: 5, transferredBytes: 20000 },
    },
    accessibility: { completed: true, violations: [], passes: 10, incomplete: 0, impact: {} },
    interactionObservations: { visibleControls: 3, focusableControls: 3, keyboardReachable: true },
  }
}

function makeReport(overrides: Partial<QAReport> = {}): QAReport {
  return {
    id: 'r001',
    url: 'https://example.com',
    kind: 'check',
    status: 'PASS',
    paymentMode: 'test',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: FUTURE,
    checksPerformed: ['viewport', 'accessibility'],
    limitations: [],
    contentHash: 'abc123',
    viewports: {
      phonePortrait: makeViewport('phonePortrait'),
      phoneLandscape: makeViewport('phoneLandscape'),
      desktop: makeViewport('desktop'),
    },
    summary: {
      totalViolations: 0,
      criticalViolations: 0,
      totalErrors: 0,
      overallLoadStatus: 'success',
    },
    verdict: {
      decision: 'safe_to_ship',
      blockingIssues: 0,
      warnings: 0,
      reasons: [],
      recommendedActions: [],
    },
    diagnosis: { overview: 'No issues found.', findings: [] },
    ...overrides,
  } as QAReport
}

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

  describe('failed findings and truncation', () => {
    it('returns failed for FAIL status with failed verdict', () => {
      const report = makeReport({
        status: 'FAIL',
        verdict: {
          decision: 'failed',
          blockingIssues: 2,
          warnings: 0,
          reasons: [],
          recommendedActions: [],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.decision).toBe('failed')
      expect(result.allowedNextSteps).toContain('recheck')
    })

    it('truncates findings to at most 12', () => {
      const findings = Array.from({ length: 20 }, (_, i) => ({
        code: `issue-${i}`,
        severity: 'low' as const,
        viewports: [] as Viewport[],
        diagnosis: 'test',
        fix: 'fix it',
        locatorHints: [],
      }))
      const report = makeReport({
        status: 'FAIL',
        verdict: {
          decision: 'failed',
          blockingIssues: 1,
          warnings: 0,
          reasons: [],
          recommendedActions: [],
        },
        diagnosis: { overview: 'issues', findings },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.findings.length).toBeLessThanOrEqual(12)
    })

    it('truncates locators to at most 5 per finding', () => {
      const report = makeReport({
        diagnosis: {
          overview: 'test',
          findings: [
            {
              code: 'a11y:issue',
              severity: 'high',
              viewports: ['desktop'] as Viewport[],
              diagnosis: 'test violation',
              fix: 'fix it',
              locatorHints: Array.from({ length: 8 }, (_, i) => `#el-${i}`),
            },
          ],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.findings[0]!.locators.length).toBeLessThanOrEqual(5)
    })

    it('truncates each locator to at most 200 chars', () => {
      const longLocator = '#' + 'a'.repeat(250)
      const report = makeReport({
        diagnosis: {
          overview: 'test',
          findings: [
            {
              code: 'overflow',
              severity: 'high',
              viewports: ['desktop'] as Viewport[],
              diagnosis: 'layout overflow',
              fix: 'fix layout',
              locatorHints: [longLocator],
            },
          ],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.findings[0]!.locators[0]!.length).toBeLessThanOrEqual(200)
    })

    it('truncates fix to at most 500 chars', () => {
      const longFix = 'fix step. '.repeat(100)
      const report = makeReport({
        diagnosis: {
          overview: 'test',
          findings: [
            {
              code: 'overflow',
              severity: 'medium',
              viewports: ['desktop'] as Viewport[],
              diagnosis: 'layout overflow',
              fix: longFix,
              locatorHints: [],
            },
          ],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.findings[0]!.fix.length).toBeLessThanOrEqual(500)
    })

    it('strips control characters from locators', () => {
      const report = makeReport({
        diagnosis: {
          overview: 'test',
          findings: [
            {
              code: 'test',
              severity: 'low',
              viewports: [] as Viewport[],
              diagnosis: 'test',
              fix: 'fix',
              locatorHints: ['#button\x00\x01\x1f\x7f<script>alert(1)</script>'],
            },
          ],
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      const locator = result.findings[0]!.locators[0]!
      expect(locator).not.toMatch(/[\x00-\x1f\x7f]/)
      expect(locator).not.toContain('<script>')
    })
  })

  describe('compare eligibility', () => {
    it('allows compare for check kind with all screenshots and evidenceBound', () => {
      const result = buildAgentResult(makeReport({ kind: 'check' }), { now: NOW })
      expect(result.allowedNextSteps).toContain('compare')
    })

    it('disallows compare when a screenshot is missing', () => {
      const report = makeReport({ kind: 'check' })
      const viewports = {
        phonePortrait: {
          ...makeViewport('phonePortrait'),
          screenshotUrl: '',
          screenshotSha256: '',
        },
        phoneLandscape: makeViewport('phoneLandscape'),
        desktop: makeViewport('desktop'),
      }
      const result = buildAgentResult({ ...report, viewports } as QAReport, { now: NOW })
      expect(result.allowedNextSteps).not.toContain('compare')
    })

    it('disallows compare for expired check', () => {
      const report = makeReport({ kind: 'check', expiresAt: PAST })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.allowedNextSteps).not.toContain('compare')
    })

    it('disallows compare when evidenceBound is false', () => {
      const report = makeReport({
        kind: 'check',
        viewports: {
          phonePortrait: {
            ...makeViewport('phonePortrait'),
            accessibility: {
              completed: false,
              violations: [],
              passes: 0,
              incomplete: 0,
              impact: {},
            },
          },
          phoneLandscape: makeViewport('phoneLandscape'),
          desktop: makeViewport('desktop'),
        },
      })
      const result = buildAgentResult(report, { now: NOW })
      expect(result.allowedNextSteps).not.toContain('compare')
    })
  })

  describe('malformed input', () => {
    it('returns inconclusive with none step for missing id', () => {
      const result = buildAgentResult({ ...makeReport(), id: '' } as QAReport, { now: NOW })
      expect(result.decision).toBe('inconclusive')
      expect(result.allowedNextSteps).toContain('none')
    })

    it('returns inconclusive with none step for missing kind', () => {
      const result = buildAgentResult(
        { ...makeReport(), kind: '' as QAReport['kind'] },
        { now: NOW },
      )
      expect(result.decision).toBe('inconclusive')
      expect(result.allowedNextSteps).toContain('none')
    })

    it('returns inconclusive with none step for missing expiresAt', () => {
      const result = buildAgentResult({ ...makeReport(), expiresAt: '' }, { now: NOW })
      expect(result.decision).toBe('inconclusive')
      expect(result.allowedNextSteps).toContain('none')
    })

    it('does not throw when report is null', () => {
      expect(() => buildAgentResult(null as unknown as QAReport, { now: NOW })).not.toThrow()
      expect(buildAgentResult(null as unknown as QAReport, { now: NOW }).decision).toBe(
        'inconclusive',
      )
    })

    it('does not throw when diagnosis is missing', () => {
      const report = { ...makeReport() }
      delete report.diagnosis
      expect(() => buildAgentResult(report, { now: NOW })).not.toThrow()
      expect(buildAgentResult(report, { now: NOW }).findings).toEqual([])
    })

    it('does not throw when viewports is missing', () => {
      const report = { ...makeReport() }
      delete (report as Partial<QAReport>).viewports
      expect(() => buildAgentResult(report, { now: NOW })).not.toThrow()
    })
  })

  describe('data trust', () => {
    it('includes dataTrust in all results', () => {
      expect(buildAgentResult(makeReport(), { now: NOW }).dataTrust).toBeTruthy()
      expect(buildAgentResult(null as unknown as QAReport, { now: NOW }).dataTrust).toBeTruthy()
      expect(buildAgentResult(makeReport({ expiresAt: PAST }), { now: NOW }).dataTrust).toBeTruthy()
    })

    it('dataTrust mentions untrusted and not instructions', () => {
      const result = buildAgentResult(makeReport(), { now: NOW })
      expect(result.dataTrust).toMatch(/untrusted/)
      expect(result.dataTrust).toMatch(/instructions/)
    })
  })

  describe('schema fields', () => {
    it('always has schema v1', () => {
      expect(buildAgentResult(makeReport(), { now: NOW }).schema).toBe(
        'viewport-witness-agent-result/v1',
      )
      expect(buildAgentResult(null as unknown as QAReport, { now: NOW }).schema).toBe(
        'viewport-witness-agent-result/v1',
      )
    })

    it('uses provided now for expiry check', () => {
      const report = makeReport({ expiresAt: '2026-10-01T11:59:00.000Z' })
      const justBefore = buildAgentResult(report, { now: '2026-10-01T11:58:00.000Z' })
      const justAfter = buildAgentResult(report, { now: '2026-10-01T12:00:00.000Z' })
      expect(justBefore.decision).toBe('safe_to_ship')
      expect(justAfter.decision).toBe('inconclusive')
    })
  })
})
