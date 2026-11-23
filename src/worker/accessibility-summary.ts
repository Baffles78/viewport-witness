import {
  VIEWPORT_NAMES,
  type AccessibilityCoverage,
  type Viewport,
  type ViewportResult,
} from '../types.js'

/** Rule entries, not affected nodes. Incomplete checks are not confirmed violations. */
export function summarizeAccessibility(
  viewports: Partial<Record<Viewport, ViewportResult>>,
): AccessibilityCoverage {
  const distinctRules = new Set<string>()
  let violationRuleOccurrences = 0
  let incompleteRuleOccurrences = 0
  let scanCompletedViewports = 0
  const scanUnavailableViewports: Viewport[] = []
  const viewportsWithIncompleteChecks: Viewport[] = []
  for (const viewport of VIEWPORT_NAMES) {
    const accessibility = viewports[viewport]?.accessibility
    if (!accessibility?.completed) scanUnavailableViewports.push(viewport)
    else scanCompletedViewports++
    for (const violation of accessibility?.violations ?? []) {
      violationRuleOccurrences++
      if (typeof violation.id === 'string') distinctRules.add(violation.id)
    }
    const incomplete = accessibility?.incomplete ?? 0
    if (Number.isSafeInteger(incomplete) && incomplete > 0) {
      incompleteRuleOccurrences += incomplete
      viewportsWithIncompleteChecks.push(viewport)
    }
  }
  return {
    distinctViolationRules: distinctRules.size,
    violationRuleOccurrences,
    incompleteRuleOccurrences,
    scanCompletedViewports,
    expectedViewports: VIEWPORT_NAMES.length,
    scanUnavailableViewports,
    viewportsWithIncompleteChecks,
  }
}
