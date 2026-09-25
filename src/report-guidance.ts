import type { QAReport, Viewport, ViewportResult } from './types.js'

const VIEWPORTS: Viewport[] = ['phonePortrait', 'phoneLandscape', 'desktop']
const MAX_FINDINGS = 12
const MAX_LOCATORS = 5

type Finding = QAReport['diagnosis']['findings'][number]

export interface DiagnosisEvidence {
  assertions?: NonNullable<QAReport['assertions']>
  comparison?: NonNullable<QAReport['comparison']>
}

const ACCESSIBILITY_FIXES: Record<string, string> = {
  'button-name':
    'Give each button a short visible label or an aria-label that describes its action.',
  'color-contrast':
    'Increase the contrast between the foreground and background colors until it meets WCAG AA.',
  'document-title': 'Add a short, descriptive <title> inside the document head.',
  'heading-order': 'Arrange heading levels in a logical order without skipping levels.',
  'html-has-lang': 'Add the page language to the <html> element, for example lang="en".',
  'image-alt': 'Add useful alt text to informative images and alt="" to decorative images.',
  label: 'Connect a visible label to each form control with for/id or an accessible name.',
  'link-name': 'Give each link a clear accessible name using visible text or aria-label.',
}

function addFinding(findings: Finding[], next: Finding): void {
  const existing = findings.find((finding) => finding.code === next.code)
  if (!existing) {
    findings.push(next)
    return
  }
  existing.viewports = VIEWPORTS.filter(
    (viewport) => existing.viewports.includes(viewport) || next.viewports.includes(viewport),
  )
  existing.locatorHints = [...new Set([...existing.locatorHints, ...next.locatorHints])].slice(
    0,
    MAX_LOCATORS,
  )
}

function severityForImpact(impact: string | null): Finding['severity'] {
  if (impact === 'critical' || impact === 'serious') return 'high'
  if (impact === 'moderate') return 'medium'
  return 'low'
}

export function buildDiagnosis(
  status: QAReport['status'],
  viewports: Partial<Record<Viewport, ViewportResult>>,
  evidence: DiagnosisEvidence = {},
): QAReport['diagnosis'] {
  const findings: Finding[] = []

  for (const viewport of VIEWPORTS) {
    const result = viewports[viewport]
    if (!result) continue

    if (result.loadStatus !== 'success' || result.pageCrash) {
      addFinding(findings, {
        code: 'page-load',
        severity: 'high',
        viewports: [viewport],
        diagnosis: 'The page did not finish loading cleanly in one or more tested viewports.',
        fix: 'Reproduce the failed viewport, then fix the first browser or server error that prevents the page from completing its load.',
        locatorHints: [],
      })
    }
    if (result.failedRequests.length > 0) {
      addFinding(findings, {
        code: 'failed-requests',
        severity: 'high',
        viewports: [viewport],
        diagnosis: 'One or more page resources returned an error or were blocked.',
        fix: 'Check the reported host and status for each failed request, then repair or remove the broken resource reference.',
        locatorHints: [],
      })
    }
    if (result.consoleErrors.length > 0) {
      addFinding(findings, {
        code: 'console-errors',
        severity: 'high',
        viewports: [viewport],
        diagnosis: 'The browser recorded JavaScript errors while rendering the page.',
        fix: 'Start with the first console error, correct its script or data dependency, and rerun the check.',
        locatorHints: [],
      })
    }
    if (result.overflowDetected || result.offscreenElements > 0) {
      addFinding(findings, {
        code: 'responsive-layout',
        severity: 'high',
        viewports: [viewport],
        diagnosis:
          'Content extends beyond the tested viewport and may be clipped or require sideways scrolling.',
        fix: 'Inspect the hinted elements and their parents for fixed widths, large margins, nowrap, or absolute positioning; prefer max-width: 100% and wrapping layouts.',
        locatorHints: result.layoutLocatorHints.slice(0, MAX_LOCATORS),
      })
    }

    for (const violation of result.accessibility.violations.slice(0, 50)) {
      addFinding(findings, {
        code: `accessibility:${violation.id}`,
        severity: severityForImpact(violation.impact),
        viewports: [viewport],
        diagnosis: violation.description.slice(0, 240),
        fix:
          ACCESSIBILITY_FIXES[violation.id] ??
          `Follow the linked ${violation.id} guidance and correct each affected element, starting with the locator hints below.`,
        locatorHints: violation.nodes
          .flatMap((node) => (node.locator ? [node.locator] : []))
          .slice(0, MAX_LOCATORS),
      })
    }
  }

  if (evidence.assertions && evidence.assertions.failed > 0) {
    const failedViewports = VIEWPORTS.filter((viewport) =>
      (evidence.assertions?.results[viewport] ?? []).some((assertion) => !assertion.passed),
    )
    addFinding(findings, {
      code: 'failed-assertions',
      severity: 'high',
      viewports: failedViewports,
      diagnosis: `${evidence.assertions.failed} requested assertion${evidence.assertions.failed === 1 ? '' : 's'} failed across the tested viewports.`,
      fix: 'Review the failed assertion results, correct the page behavior or expectation, and rerun the same verification.',
      locatorHints: [],
    })
  }

  if (evidence.comparison && !evidence.comparison.evidenceComplete) {
    const missingViewports = VIEWPORTS.filter((viewport) => !evidence.comparison?.visual[viewport])
    addFinding(findings, {
      code: 'incomplete-comparison-evidence',
      severity: 'high',
      viewports: missingViewports,
      diagnosis:
        'The baseline comparison is missing or could not decode required screenshot evidence.',
      fix: 'Create a fresh complete baseline, confirm all three baseline screenshots are available, and run the comparison again.',
      locatorHints: [],
    })
  }

  if (evidence.comparison) {
    const changedViewports = VIEWPORTS.filter(
      (viewport) => (evidence.comparison?.visual[viewport]?.changedPixels ?? 0) > 0,
    )
    if (changedViewports.length > 0) {
      addFinding(findings, {
        code: 'visual-changes',
        severity: 'medium',
        viewports: changedViewports,
        diagnosis:
          'The current page differs visually from the saved baseline in one or more viewports.',
        fix: 'Inspect the supplied diff images, approve intentional changes, and repair unexpected changes before replacing the baseline.',
        locatorHints: [],
      })
    }
  }

  findings.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 }
    return rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code)
  })

  const overview =
    findings.length === 0
      ? status === 'PASS'
        ? 'No actionable problems were found in the collected evidence.'
        : 'The check did not collect enough evidence for a specific diagnosis. Retry it before shipping.'
      : `${findings.length} actionable problem ${findings.length === 1 ? 'type was' : 'types were'} found. Start with the high-severity fixes and rerun the same check.`

  return { overview, findings: findings.slice(0, MAX_FINDINGS) }
}
