import type { MachineVerdict, QAReport, Viewport, ViewportResult } from '../types.js'
import { VIEWPORT_NAMES } from '../types.js'
import { summarizeAccessibility } from './accessibility-summary.js'

// Decides PASS / FAIL / INCONCLUSIVE from the per-viewport results.
export function computeReportStatus(
  viewports: Partial<Record<Viewport, ViewportResult>>,
): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  const results = Object.values(viewports).filter(
    (v): v is ViewportResult => v !== undefined,
  )

  if (results.length === 0) return 'INCONCLUSIVE'

  const hasLoadFailure = results.some((r) => r.loadStatus !== 'success')
  const hasCriticalViolations = results.some((r) =>
    r.accessibility.violations.some((v) => v.impact === 'critical' || v.impact === 'serious'),
  )

  const hasFunctionalFailure = results.some(
    (r) =>
      r.pageCrash ||
      r.consoleErrors.length > 0 ||
      r.failedRequests.length > 0 ||
      r.overflowDetected ||
      r.offscreenElements > 0,
  )

  if (hasLoadFailure || hasCriticalViolations || hasFunctionalFailure) return 'FAIL'

  const allViewportsCovered = VIEWPORT_NAMES.every((v) => viewports[v] !== undefined)
  if (!allViewportsCovered) return 'INCONCLUSIVE'

  const evidenceComplete = results.every(
    (r) => r.screenshotBytes > 0 && r.accessibility.completed && r.layoutObservation === 'measured',
  )
  if (!evidenceComplete) return 'INCONCLUSIVE'

  return 'PASS'
}

// Turns the report status and viewport results into the machine verdict agents act on.
export function buildVerdict(
  status: QAReport['status'],
  viewports: Partial<Record<Viewport, ViewportResult>>,
): MachineVerdict {
  const actions: MachineVerdict['recommendedActions'] = []
  const reasons: string[] = []
  const coverage = summarizeAccessibility(viewports)
  let blockingIssues = 0
  let warnings = 0
  for (const [viewport, result] of Object.entries(viewports) as Array<[Viewport, ViewportResult]>) {
    if (result.loadStatus !== 'success' || result.pageCrash) {
      blockingIssues++
      reasons.push(`${viewport}: page did not load cleanly.`)
      actions.push({
        code: 'load_failure',
        priority: 'high',
        viewport,
        detail: 'Fix the page load or crash.',
      })
    }
    const severe = result.accessibility.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    ).length
    if (severe > 0) {
      blockingIssues += severe
      reasons.push(`${viewport}: ${severe} serious or critical accessibility rule finding(s).`)
      actions.push({
        code: 'accessibility',
        priority: 'high',
        viewport,
        detail: 'Fix serious accessibility violations.',
      })
    }
    if (result.consoleErrors.length + result.failedRequests.length > 0) {
      blockingIssues++
      reasons.push(`${viewport}: browser or network errors were observed.`)
      actions.push({
        code: 'browser_errors',
        priority: 'high',
        viewport,
        detail: 'Review console errors and failed requests.',
      })
    }
    if (result.overflowDetected || result.offscreenElements > 0) {
      blockingIssues++
      reasons.push(`${viewport}: content overflow or off-screen elements detected.`)
      actions.push({
        code: 'layout',
        priority: 'high',
        viewport,
        detail: 'Correct the responsive layout.',
      })
    }
    const moderate = result.accessibility.violations.filter(
      (violation) => violation.impact === 'moderate' || violation.impact === 'minor',
    ).length
    warnings += moderate
    if (moderate > 0) {
      actions.push({
        code: 'accessibility_warnings',
        priority: 'medium',
        viewport,
        detail:
          'Review moderate and minor accessibility findings. These warnings do not independently fail the current blocking-check policy.',
      })
    }
  }
  if (status === 'INCONCLUSIVE') {
    warnings++
    reasons.push('The evidence set is incomplete.')
    actions.push({
      code: 'incomplete_evidence',
      priority: 'medium',
      detail: 'Retry the check before shipping.',
    })
  }
  if (coverage.violationRuleOccurrences > 0) {
    reasons.push(
      `Accessibility: ${coverage.distinctViolationRules} distinct violation rule(s), ${coverage.violationRuleOccurrences} rule occurrences across viewports. A rule repeated in three viewports counts as three occurrences, not three distinct rules or affected elements.`,
    )
  }
  if (warnings > 0 && status === 'PASS')
    reasons.unshift(
      'Blocking checks passed, but accessibility warnings remain. Review the recommended actions; PASS does not mean warning-free.',
    )
  if (coverage.incompleteRuleOccurrences > 0) {
    reasons.push(
      `Accessibility manual review: ${coverage.incompleteRuleOccurrences} inconclusive rule checks across ${coverage.viewportsWithIncompleteChecks.length} viewport(s). These are not confirmed violations and do not independently change PASS/FAIL.`,
    )
    actions.push({
      code: 'accessibility_manual_review',
      priority: 'medium',
      detail:
        'Manually inspect accessibility checks marked incomplete in the affected viewports. A completed automated scan does not mean every rule was conclusively assessed.',
    })
  }
  if (coverage.incompleteRuleOccurrences > 0 || coverage.scanUnavailableViewports.length > 0)
    reasons.push(
      `Accessibility scan coverage: ${coverage.scanCompletedViewports} of ${coverage.expectedViewports} viewport scans completed. Missing scans are unassessed, not a zero-violation result.`,
    )
  if (reasons.length === 0)
    reasons.push(
      'Blocking checks passed in the collected evidence; no confirmed accessibility warnings or incomplete rule checks were reported.',
    )
  // Warnings must not displace high-priority blockers when the output cap is reached.
  const priority = { high: 0, medium: 1, low: 2 }
  actions.sort((a, b) => priority[a.priority] - priority[b.priority])
  return {
    decision: status === 'PASS' ? 'safe_to_ship' : status === 'FAIL' ? 'failed' : 'review',
    blockingIssues,
    warnings,
    reasons: reasons.slice(0, 12),
    recommendedActions: actions.slice(0, 12),
  }
}
