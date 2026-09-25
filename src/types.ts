export type PaymentMode = 'test' | 'testnet' | 'production'

export type JobStatus =
  'payment_pending' | 'queued' | 'running' | 'complete' | 'failed' | 'retryable'

export type Viewport = 'phonePortrait' | 'phoneLandscape' | 'desktop'

export type JobKind = 'check' | 'verify' | 'compare' | 'extract' | 'security'

export interface ExtractReport {
  id: string
  kind: 'extract'
  status: 'PASS'
  paymentMode: PaymentMode
  createdAt: string
  expiresAt: string
  sourceUrl: string
  markdown: string
  contentHash: string
  inputBytes: number
  outputBytes: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  warnings: string[]
  provenance: { fetchedAt: string; redirects: number; contentType: string; parser: string }
}

export interface SecurityFinding {
  code: string
  severity: 'high' | 'medium' | 'low'
  evidence: string
  remediation: string
}

export interface SecurityReport {
  id: string
  kind: 'security'
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  paymentMode: PaymentMode
  createdAt: string
  expiresAt: string
  sourceUrl: string
  contentHash: string
  findings: SecurityFinding[]
  checksPerformed: string[]
  limitations: string[]
  provenance: { fetchedAt: string; redirects: number; contentType: string }
}

export type StoredReport = QAReport | ExtractReport | SecurityReport

export type PageAssertion =
  | { type: 'textVisible'; value: string }
  | { type: 'selectorExists'; selector: string }
  | { type: 'selectorVisible'; selector: string }
  | { type: 'titleIncludes'; value: string }
  | { type: 'noHorizontalOverflow' }
  | { type: 'noConsoleErrors' }

export interface AssertionResult {
  assertion: PageAssertion
  passed: boolean
  detail: string
}

export interface ViewportDimensions {
  width: number
  height: number
}

export const VIEWPORTS: Record<Viewport, ViewportDimensions> = {
  phonePortrait: { width: 375, height: 812 },
  phoneLandscape: { width: 812, height: 375 },
  desktop: { width: 1440, height: 900 },
}

export interface AccessibilityViolation {
  id: string
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null
  description: string
  helpUrl: string
  nodes: Array<{
    html: string
    failureSummary: string
    locator?: string
  }>
  count: number
}

export interface PerformanceEvidence {
  navigation: {
    dnsMs?: number
    connectMs?: number
    tlsMs?: number
    requestMs?: number
    responseMs?: number
    timeToFirstByteMs?: number
    domInteractiveMs?: number
    domContentLoadedMs?: number
    loadEventMs?: number
  }
  paint: {
    firstPaintMs?: number
    firstContentfulPaintMs?: number
    largestContentfulPaintMs?: number
    cumulativeLayoutShift?: number
  }
  resources: {
    requestCount: number
    transferredBytes: number
  }
}

export interface ViewportResult {
  viewport: Viewport
  dimensions: ViewportDimensions
  loadStatus: 'success' | 'timeout' | 'error'
  loadTimeMs: number
  finalUrl: string
  redirectCount: number
  screenshotUrl: string
  screenshotDimensions: { w: number; h: number }
  screenshotBytes: number
  screenshotSha256: string
  consoleErrors: string[]
  pageCrash: boolean
  failedRequests: Array<{ url: string; status: number | null; reason: string }>
  overflowDetected: boolean
  offscreenElements: number
  layoutLocatorHints: string[]
  performance: PerformanceEvidence
  accessibility: {
    completed: boolean
    violations: AccessibilityViolation[]
    passes: number
    incomplete: number
    impact: Record<string, number>
  }
  interactionObservations: {
    visibleControls: number
    focusableControls: number
    keyboardReachable: boolean
  }
  assertions?: AssertionResult[]
}

export interface MachineVerdict {
  decision: 'safe_to_ship' | 'review' | 'failed'
  blockingIssues: number
  warnings: number
  reasons: string[]
  recommendedActions: Array<{
    code: string
    priority: 'high' | 'medium' | 'low'
    viewport?: Viewport
    detail: string
  }>
}

export interface VisualComparisonResult {
  viewport: Viewport
  changedPixels: number
  changedPercent: number
  diffImageUrl: string
  baselineScreenshotSha256: string
  currentScreenshotSha256: string
}

export interface QAReport {
  id: string
  url: string
  kind: JobKind
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  paymentMode: PaymentMode
  createdAt: string
  expiresAt: string
  checksPerformed: string[]
  limitations: string[]
  contentHash: string
  viewports: Partial<Record<Viewport, ViewportResult>>
  summary: {
    totalViolations: number
    criticalViolations: number
    totalErrors: number
    overallLoadStatus: string
  }
  verdict: MachineVerdict
  diagnosis: {
    overview: string
    findings: Array<{
      code: string
      severity: 'high' | 'medium' | 'low'
      viewports: Viewport[]
      diagnosis: string
      fix: string
      locatorHints: string[]
    }>
  }
  assertions?: {
    passed: number
    failed: number
    results: Partial<Record<Viewport, AssertionResult[]>>
  }
  comparison?: {
    baselineJobId: string
    evidenceComplete: boolean
    evidenceLimitations: string[]
    visual: Partial<Record<Viewport, VisualComparisonResult>>
    accessibility: {
      newViolationIds: string[]
      resolvedViolationIds: string[]
    }
    errors: { baseline: number; current: number; delta: number }
  }
}

export interface JobRecord {
  id: string
  url: string
  status: JobStatus
  idempotencyKey: string | null
  paymentId: string | null
  customerId: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  expiresAt: number
  reportPath: string | null
  error: string | null
  retryCount: number
  kind: JobKind
  request: { assertions?: PageAssertion[]; maxOutputTokens?: number }
  baselineJobId: string | null
}
