import type { MachineVerdict, QAReport, Viewport, ViewportResult } from '../types.js'
import { VIEWPORT_NAMES } from '../types.js'

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
  let blockingIssues = 0
  let warnings = 0
  for (const [viewport, result] of Object.entries(viewports) as Array<
    [Viewport, ViewportResult]
  >) {
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
      reasons.push(`${viewport}: ${severe} serious accessibility issue(s).`)
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
  if (reasons.length === 0) reasons.push('All required checks passed across all three viewports.')
  return {
    decision: status === 'PASS' ? 'safe_to_ship' : status === 'FAIL' ? 'failed' : 'review',
    blockingIssues,
    warnings,
    reasons: reasons.slice(0, 12),
    recommendedActions: actions.slice(0, 12),
  }
}
