export type PaymentMode = 'test' | 'testnet' | 'production'

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'retryable'

export type Viewport = 'phonePortrait' | 'phoneLandscape' | 'desktop'

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
  }>
  count: number
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
}

export interface QAReport {
  id: string
  url: string
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
}

export interface JobRecord {
  id: string
  url: string
  status: JobStatus
  idempotencyKey: string | null
  paymentId: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  expiresAt: number
  reportPath: string | null
  error: string | null
  retryCount: number
}
