import { describe, expect, it } from 'vitest'
import { buildDiagnosis } from '../src/report-guidance.js'
import type { Viewport, ViewportResult } from '../src/types.js'

function result(overrides: Partial<ViewportResult> = {}): ViewportResult {
  return {
    viewport: 'phonePortrait',
    dimensions: { width: 375, height: 812 },
    loadStatus: 'success',
    loadTimeMs: 500,
    finalUrl: 'https://example.com',
    redirectCount: 0,
    screenshotUrl: '/shot',
    screenshotDimensions: { w: 375, h: 812 },
    screenshotBytes: 100,
    screenshotSha256: 'a'.repeat(64),
    consoleErrors: [],
    pageCrash: false,
    failedRequests: [],
    overflowDetected: false,
    offscreenElements: 0,
    layoutLocatorHints: [],
    performance: {
      navigation: {},
      paint: {},
      resources: { requestCount: 4, transferredBytes: 2048 },
    },
    accessibility: { completed: true, violations: [], passes: 1, incomplete: 0, impact: {} },
    interactionObservations: {
      visibleControls: 0,
      focusableControls: 0,
      keyboardReachable: false,
    },
    ...overrides,
  }
}

describe('buildDiagnosis', () => {
  it('returns concise all-clear guidance when collected evidence passes', () => {
    expect(buildDiagnosis('PASS', { phonePortrait: result() })).toEqual({
      overview: 'No actionable problems were found in the collected evidence.',
      findings: [],
    })
  })

  it('combines matching problems across viewports and preserves bounded structural hints', () => {
    const viewports: Partial<Record<Viewport, ViewportResult>> = {
      phonePortrait: result({
        overflowDetected: true,
        offscreenElements: 2,
        layoutLocatorHints: ['body:nth-of-type(1) > main:nth-of-type(1) > div:nth-of-type(2)'],
      }),
      desktop: result({
        viewport: 'desktop',
        dimensions: { width: 1440, height: 900 },
        overflowDetected: true,
        offscreenElements: 1,
        layoutLocatorHints: ['body:nth-of-type(1) > main:nth-of-type(1) > table:nth-of-type(1)'],
      }),
    }
    const diagnosis = buildDiagnosis('FAIL', viewports)
    expect(diagnosis.findings).toHaveLength(1)
    expect(diagnosis.findings[0]).toMatchObject({
      code: 'responsive-layout',
      severity: 'high',
      viewports: ['phonePortrait', 'desktop'],
    })
    expect(diagnosis.findings[0]?.locatorHints).toHaveLength(2)
  })

  it('uses specific accessibility repair advice without exposing page markup', () => {
    const diagnosis = buildDiagnosis('FAIL', {
      phonePortrait: result({
        accessibility: {
          completed: true,
          passes: 0,
          incomplete: 0,
          impact: { serious: 1 },
          violations: [
            {
              id: 'image-alt',
              impact: 'serious',
              description: 'Ensure images have alternative text',
              helpUrl: 'https://example.com/help',
              count: 1,
              nodes: [
                {
                  html: '[redacted]',
                  failureSummary: 'Fix the image',
                  locator: 'body:nth-of-type(1) > img:nth-of-type(1)',
                },
              ],
            },
          ],
        },
      }),
    })
    expect(diagnosis.findings[0]).toMatchObject({
      code: 'accessibility:image-alt',
      fix: 'Add useful alt text to informative images and alt="" to decorative images.',
      locatorHints: ['body:nth-of-type(1) > img:nth-of-type(1)'],
    })
    expect(JSON.stringify(diagnosis)).not.toContain('<img')
  })
})
