import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { summarizeAccessibility } from '../src/worker/accessibility-summary.js'
import { buildVerdict, computeReportStatus } from '../src/worker/verdict.js'
import { buildDiagnosis } from '../src/report-guidance.js'
import { parseClientOptions } from '../src/client/options.js'
import { ClientTargetError } from '../src/client/option-errors.js'
import { VIEWPORT_NAMES, type Viewport, type ViewportResult } from '../src/types.js'
import { makeViewport } from './helpers/qa-report-fixtures.js'

function repeatedRules(): Record<Viewport, ViewportResult> {
  return Object.fromEntries(
    VIEWPORT_NAMES.map((viewport) => [
      viewport,
      {
        ...makeViewport(viewport),
        accessibility: {
          completed: true,
          passes: 5,
          incomplete: 0,
          impact: { moderate: 3 },
          violations: ['rule-a', 'rule-b', 'rule-c'].map((id) => ({
            id,
            impact: 'moderate',
            description: 'Review this accessibility rule',
            helpUrl: 'https://example.com/help',
            nodes: [],
            count: 2,
          })),
        },
      },
    ]),
  ) as Record<Viewport, ViewportResult>
}

describe('report counts and unchanged blocking policy', () => {
  it('distinguishes three distinct rules from nine viewport-rule occurrences and eighteen affected nodes', () => {
    const viewports = repeatedRules()
    const summary = summarizeAccessibility(viewports)
    expect(summary).toEqual({
      distinctViolationRules: 3,
      violationRuleOccurrences: 9,
      incompleteRuleOccurrences: 0,
      scanCompletedViewports: 3,
      expectedViewports: 3,
      scanUnavailableViewports: [],
      viewportsWithIncompleteChecks: [],
    })
    const verdict = buildVerdict(computeReportStatus(viewports), viewports)
    expect(verdict.decision).toBe('safe_to_ship')
    expect(verdict.warnings).toBe(9)
    expect(verdict.blockingIssues).toBe(0)
    expect(verdict.reasons.join(' ')).toMatch(/3 distinct violation rule\(s\), 9 rule occurrences/)
    expect(verdict.reasons.join(' ')).toContain('PASS does not mean warning-free')
    expect(verdict.recommendedActions).toHaveLength(3)
    expect(
      verdict.recommendedActions.every((action) => action.code === 'accessibility_warnings'),
    ).toBe(true)
    expect(buildDiagnosis('PASS', viewports).overview).toContain('Review the warning guidance')
    expect(buildDiagnosis('PASS', viewports).overview).not.toContain('Start with the high-severity')
  })
  it('keeps incomplete counts visible without treating manual review as confirmed failure', () => {
    const viewports = repeatedRules()
    for (const viewport of VIEWPORT_NAMES)
      viewports[viewport].accessibility = {
        completed: true,
        passes: 5,
        incomplete: 2,
        impact: {},
        violations: [],
      }
    expect(computeReportStatus(viewports)).toBe('PASS')
    const coverage = summarizeAccessibility(viewports)
    expect(coverage.incompleteRuleOccurrences).toBe(6)
    expect(coverage.distinctViolationRules).toBe(0)
    expect(coverage.viewportsWithIncompleteChecks).toEqual(VIEWPORT_NAMES)
    const verdict = buildVerdict('PASS', viewports)
    expect(verdict.decision).toBe('safe_to_ship')
    expect(verdict.blockingIssues).toBe(0)
    expect(verdict.warnings).toBe(0) // Existing warning counter policy remains unchanged.
    expect(verdict.reasons.join(' ')).toContain('6 inconclusive rule checks')
    expect(verdict.reasons.join(' ')).toContain('3 of 3 viewport scans completed')
    expect(verdict.recommendedActions).toContainEqual(
      expect.objectContaining({ code: 'accessibility_manual_review', priority: 'medium' }),
    )
    const diagnosis = buildDiagnosis('PASS', viewports)
    expect(diagnosis.findings).toEqual([])
    expect(diagnosis.overview).toContain('6 accessibility rule checks were inconclusive')
    expect(diagnosis.overview).not.toContain('No actionable problems')
  })
  it('reports unavailable scans as unassessed and preserves INCONCLUSIVE', () => {
    const viewports = repeatedRules()
    viewports.desktop.accessibility = {
      completed: false,
      passes: 0,
      incomplete: 0,
      impact: {},
      violations: [],
    }
    expect(computeReportStatus(viewports)).toBe('INCONCLUSIVE')
    expect(summarizeAccessibility(viewports)).toMatchObject({
      scanCompletedViewports: 2,
      scanUnavailableViewports: ['desktop'],
    })
    expect(buildVerdict('INCONCLUSIVE', viewports).reasons.join(' ')).toContain(
      'Missing scans are unassessed',
    )
  })
  it('preserves high-priority blocking actions before warning actions under the twelve-item cap', () => {
    const viewports = repeatedRules()
    for (const viewport of VIEWPORT_NAMES)
      Object.assign(viewports[viewport], {
        loadStatus: 'timeout',
        pageCrash: true,
        consoleErrors: ['error'],
        overflowDetected: true,
        accessibility: {
          completed: true,
          passes: 0,
          incomplete: 0,
          impact: {},
          violations: [
            { id: 'severe', impact: 'serious', description: '', helpUrl: '', nodes: [], count: 1 },
            { id: 'minor', impact: 'minor', description: '', helpUrl: '', nodes: [], count: 1 },
          ],
        },
      })
    expect(computeReportStatus(viewports)).toBe('FAIL')
    const verdict = buildVerdict('FAIL', viewports)
    expect(verdict.recommendedActions).toHaveLength(12)
    expect(verdict.recommendedActions.every((action) => action.priority === 'high')).toBe(true)
    expect(verdict.recommendedActions).toContainEqual(
      expect.objectContaining({ code: 'layout', viewport: 'desktop' }),
    )
  })
})

describe('specific unsafe target diagnosis and onboarding guide', () => {
  it.each([
    ['http://public.example.com/SENTINEL', 'TARGET_HTTPS_REQUIRED'],
    ['https://user:SENTINEL_PASSWORD@example.com/?token=SENTINEL', 'TARGET_CREDENTIALS_FORBIDDEN'],
    ['https://127.0.0.1/SENTINEL', 'TARGET_NOT_PUBLIC'],
    ['https://example.com:8080/SENTINEL', 'TARGET_PORT_UNSUPPORTED'],
    ['SENTINEL_NOT_A_URL', 'TARGET_URL_INVALID'],
  ])('classifies unsafe input without reflecting URL contents: %s', (url, code) => {
    try {
      parseClientOptions(['--url', url])
      throw new Error('Expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(ClientTargetError)
      expect((error as ClientTargetError).code).toBe(code)
      expect(
        `${(error as ClientTargetError).code} ${(error as ClientTargetError).fix}`,
      ).not.toContain('SENTINEL')
    }
  })
  it('starts the guide with an executable pinned published npx doctor command, before source build instructions', () => {
    const guide = readFileSync(new URL('../docs/CLIENT-SETUP.md', import.meta.url), 'utf8')
    const firstCommand = guide.match(/```powershell\s+([^`]+)```/)?.[1]?.trim()
    expect(firstCommand).toBe(
      'npx --yes --package=https://github.com/Baffles78/viewport-witness/releases/download/client-v0.3.0/viewport-witness-client-0.3.0.tgz -- viewport-witness doctor --url https://example.com',
    )
    expect(guide.indexOf(firstCommand!)).toBeLessThan(guide.indexOf('npm ci'))
    expect(guide).toContain('no checkout, build, manual installation or credentials')
    expect(guide).toContain('not a replacement of')
  })
})
