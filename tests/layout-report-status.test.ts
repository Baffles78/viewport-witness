import { describe, expect, it } from 'vitest'
import { WorkerRunner } from '../src/worker/runner.js'

type Observation = Record<string, unknown>
const compute = (viewports: Record<string, Observation>): string =>
  (WorkerRunner.prototype as unknown as {
    computeReportStatus: (value: Record<string, Observation>) => string
  }).computeReportStatus(viewports)

function viewport(layoutObservation: 'measured' | 'unavailable', overflowDetected = false) {
  return {
    loadStatus: 'success',
    pageCrash: false,
    consoleErrors: [],
    failedRequests: [],
    overflowDetected,
    offscreenElements: 0,
    screenshotBytes: 100,
    accessibility: { completed: true, violations: [] },
    layoutObservation,
  }
}

describe('report status with layout evidence', () => {
  it('is inconclusive when one otherwise clean viewport has no layout measurement', () => {
    expect(compute({
      phonePortrait: viewport('measured'),
      phoneLandscape: viewport('unavailable'),
      desktop: viewport('measured'),
    })).toBe('INCONCLUSIVE')
  })

  it('preserves an independently observed layout failure', () => {
    expect(compute({
      phonePortrait: viewport('measured', true),
      phoneLandscape: viewport('unavailable'),
      desktop: viewport('measured'),
    })).toBe('FAIL')
  })

  it('passes when all three clean viewports have measurements', () => {
    expect(compute({
      phonePortrait: viewport('measured'),
      phoneLandscape: viewport('measured'),
      desktop: viewport('measured'),
    })).toBe('PASS')
  })
})
