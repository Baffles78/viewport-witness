import type { QAReport, Viewport, ViewportResult } from '../types.js'

export function summarizeAssertions(
  viewports: Partial<Record<Viewport, ViewportResult>>,
): NonNullable<QAReport['assertions']> {
  const results: NonNullable<QAReport['assertions']>['results'] = {}
  let passed = 0
  let failed = 0
  let unavailable = 0
  for (const [viewport, result] of Object.entries(viewports) as Array<[Viewport, ViewportResult]>) {
    const viewportAssertions = result.assertions ?? []
    results[viewport] = viewportAssertions
    passed += viewportAssertions.filter((assertion) => assertion.passed).length
    failed += viewportAssertions.filter(
      (assertion) => !assertion.passed && assertion.measured !== false,
    ).length
    unavailable += viewportAssertions.filter((assertion) => assertion.measured === false).length
  }
  return { passed, failed, unavailable, results }
}
