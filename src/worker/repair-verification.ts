import { createHash } from 'node:crypto'
import {
  VIEWPORT_NAMES,
  type AssertionResult,
  type QAReport,
  type Viewport,
  type ViewportResult,
} from '../types.js'

export type RepairState = 'fixed' | 'still_broken' | 'newly_broken' | 'could_not_verify'

export interface RepairFinding {
  key: string
  viewport: Viewport
  check: string
  state: RepairState
  granularity: 'check' | 'accessibility_rule' | 'assertion'
  baselineLocators: string[]
  currentLocators: string[]
}

export interface RepairVerification {
  schema: 'viewport-witness-repair-verification/v1'
  sameUrl: boolean
  findings: RepairFinding[]
  limitations: string[]
}

type Observation = { broken: boolean; measured: boolean; locators?: string[] }
type Views = Partial<Record<Viewport, ViewportResult>>

function loadMeasured(result: ViewportResult | undefined): boolean {
  return (
    !!result &&
    result.loadStatus === 'success' &&
    !result.pageCrash &&
    result.screenshotBytes > 0 &&
    typeof result.screenshotSha256 === 'string' &&
    result.screenshotSha256.trim().length > 0
  )
}

function state(before: Observation, after: Observation): RepairState | undefined {
  if (!before.measured || !after.measured) return 'could_not_verify'
  if (before.broken) return after.broken ? 'still_broken' : 'fixed'
  return after.broken ? 'newly_broken' : undefined
}

function observation(result: ViewportResult | undefined, check: string): Observation {
  if (!result) return { measured: false, broken: false }
  const loaded = loadMeasured(result)
  switch (check) {
    case 'page-load':
      return {
        measured:
          loaded ||
          result.loadStatus === 'timeout' ||
          result.loadStatus === 'error' ||
          result.pageCrash === true,
        broken: result.loadStatus !== 'success' || result.pageCrash,
      }
    case 'console-errors':
      return {
        measured: loaded && Array.isArray(result.consoleErrors),
        broken: result.consoleErrors?.length > 0,
      }
    case 'failed-requests':
      return {
        measured: loaded && Array.isArray(result.failedRequests),
        broken: result.failedRequests?.length > 0,
      }
    default:
      return {
        measured: loaded && result.layoutObservation === 'measured',
        broken: result.overflowDetected || result.offscreenElements > 0,
        locators: result.layoutLocatorHints,
      }
  }
}

function accessibility(result: ViewportResult | undefined, rule: string): Observation {
  const violations = result?.accessibility?.violations ?? []
  const violation = violations.find((item) => item.id === rule)
  return {
    // A reported violation proves this rule failed even if another rule was incomplete.
    // Absence only supports clearance when the scan is complete and not capped.
    measured:
      !!result &&
      loadMeasured(result) &&
      result.accessibility?.completed === true &&
      (!!violation || (result.accessibility.incomplete === 0 && violations.length < 50)),
    broken: !!violation,
    locators: violation?.nodes?.flatMap((node) => (node.locator ? [node.locator] : [])) ?? [],
  }
}

function assertionKey(result: AssertionResult): string {
  const assertion = result.assertion
  const expected =
    'selector' in assertion ? assertion.selector : 'value' in assertion ? assertion.value : ''
  return `${assertion.type}:${createHash('sha256').update(expected).digest('hex').slice(0, 20)}`
}

function assertionObservation(result: AssertionResult | undefined, loaded: boolean): Observation {
  return {
    measured:
      loaded &&
      !!result &&
      result.measured !== false &&
      result.detail !== 'Assertion could not be evaluated.',
    broken: result?.passed === false,
    locators: result && 'selector' in result.assertion ? [result.assertion.selector] : [],
  }
}

/** Compares observed check/rule outcomes, never claims an identical DOM node was repaired. */
export function buildRepairVerification(
  baseline: Pick<QAReport, 'url' | 'viewports'>,
  current: { url: string; viewports: Views },
): RepairVerification {
  const sameUrl = typeof baseline.url === 'string' && baseline.url === current.url
  const findings: RepairFinding[] = []
  const limitations = [
    'Verification is at check, accessibility-rule and exact-assertion level; it does not identify the same DOM node across visits. A rule may affect different nodes.',
    'Both-clear checks are omitted. Missing, incomplete, capped or changed-expectation evidence cannot prove a fix. No additional browser visit or payment is made.',
    'Successful page observations require original screenshot bytes and a recorded screenshot hash. Actual load failures can be observed without a screenshot.',
  ]
  if (!sameUrl)
    limitations.push(
      'The exact target URLs differ or are unavailable; outcomes could not be verified.',
    )
  const add = (
    viewport: Viewport,
    check: string,
    granularity: RepairFinding['granularity'],
    before: Observation,
    after: Observation,
  ): void => {
    const outcome = sameUrl ? state(before, after) : 'could_not_verify'
    if (!outcome) return
    findings.push({
      key: `${viewport}:${check}`,
      viewport,
      check,
      state: outcome,
      granularity,
      baselineLocators: (before.locators ?? []).slice(0, 5).map((locator) => locator.slice(0, 300)),
      currentLocators: (after.locators ?? []).slice(0, 5).map((locator) => locator.slice(0, 300)),
    })
  }
  for (const viewport of VIEWPORT_NAMES) {
    const before = baseline.viewports?.[viewport]
    const after = current.viewports[viewport]
    for (const check of ['page-load', 'console-errors', 'failed-requests', 'responsive-layout']) {
      add(viewport, check, 'check', observation(before, check), observation(after, check))
    }
    const rules = [
      ...new Set([
        ...(before?.accessibility?.violations ?? []).map((item) => item.id),
        ...(after?.accessibility?.violations ?? []).map((item) => item.id),
      ]),
    ].sort()
    for (const rule of rules.slice(0, 100)) {
      add(
        viewport,
        `accessibility:${rule}`,
        'accessibility_rule',
        accessibility(before, rule),
        accessibility(after, rule),
      )
    }
    if (rules.length > 100)
      limitations.push(`${viewport}: accessibility rule comparison capped at 100 rules.`)
    const beforeAssertions = new Map(
      (before?.assertions ?? []).slice(0, 20).map((item) => [assertionKey(item), item]),
    )
    const afterAssertions = new Map(
      (after?.assertions ?? []).slice(0, 20).map((item) => [assertionKey(item), item]),
    )
    for (const key of [
      ...new Set([...beforeAssertions.keys(), ...afterAssertions.keys()]),
    ].sort()) {
      add(
        viewport,
        `assertion:${key}`,
        'assertion',
        assertionObservation(beforeAssertions.get(key), loadMeasured(before)),
        assertionObservation(afterAssertions.get(key), loadMeasured(after)),
      )
    }
    if ((before?.assertions?.length ?? 0) > 20 || (after?.assertions?.length ?? 0) > 20) {
      limitations.push(`${viewport}: assertion comparison capped at 20 assertions per visit.`)
    }
  }
  return { schema: 'viewport-witness-repair-verification/v1', sameUrl, findings, limitations }
}
