// Shared QA report fixtures for agent-result tests.
import type { QAReport, Viewport, ViewportResult } from '../../src/types.js'

export const NOW = '2026-10-01T12:00:00.000Z'
export const FUTURE = '2026-10-08T00:00:00.000Z'
export const PAST = '2026-09-01T00:00:00.000Z'

export function makeViewport(vp: Viewport): ViewportResult {
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
    layoutObservation: 'measured',
    performance: {
      navigation: {},
      paint: {},
      resources: { requestCount: 5, transferredBytes: 20000 },
    },
    accessibility: { completed: true, violations: [], passes: 10, incomplete: 0, impact: {} },
    interactionObservations: { visibleControls: 3, focusableControls: 3, keyboardReachable: true },
  }
}

export function makeReport(overrides: Partial<QAReport> = {}): QAReport {
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
