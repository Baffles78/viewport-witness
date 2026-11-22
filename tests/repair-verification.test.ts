import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRepairVerification } from '../src/worker/repair-verification.js'
import { buildComparison } from '../src/worker/comparison.js'
import type { JobStore } from '../src/db.js'
import { makeReport } from './helpers/qa-report-fixtures.js'
import type { ViewportResult } from '../src/types.js'

function violate(view: ViewportResult, locator = 'button:nth-of-type(1)'): void {
  view.accessibility.violations.push({
    id: 'button-name',
    impact: 'serious',
    description: 'Buttons need names',
    helpUrl: 'https://example.com/rule',
    count: 1,
    nodes: [{ html: '[redacted]', failureSummary: 'Missing name', locator }],
  })
}

describe('repair verification', () => {
  it.each(['bytes', 'hash'] as const)(
    'requires current screenshot %s before claiming a repair',
    (missing) => {
      const before = makeReport(),
        after = makeReport()
      before.viewports.desktop!.overflowDetected = true
      violate(before.viewports.desktop!)
      before.viewports.desktop!.consoleErrors = ['error']
      if (missing === 'bytes') after.viewports.desktop!.screenshotBytes = 0
      else after.viewports.desktop!.screenshotSha256 = ''
      const findings = buildRepairVerification(before, after).findings.filter(
        (item) => item.viewport === 'desktop',
      )
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.every((item) => item.state === 'could_not_verify')).toBe(true)
    },
  )

  it('observes actual load failure without a screenshot but requires a screenshot to prove recovery', () => {
    const before = makeReport(),
      after = makeReport()
    before.viewports.desktop!.loadStatus = 'error'
    before.viewports.desktop!.screenshotBytes = 0
    before.viewports.desktop!.screenshotSha256 = ''
    expect(buildRepairVerification(before, after).findings).toContainEqual(
      expect.objectContaining({ key: 'desktop:page-load', state: 'fixed' }),
    )
    after.viewports.desktop!.screenshotBytes = 0
    expect(buildRepairVerification(before, after).findings).toContainEqual(
      expect.objectContaining({ key: 'desktop:page-load', state: 'could_not_verify' }),
    )
  })
  it('adds repair outcomes to comparisons using the stored current target URL', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-repair-'))
    try {
      const baseline = makeReport(),
        current = makeReport()
      baseline.viewports.desktop!.overflowDetected = true
      const reportPath = path.join(dir, 'baseline.json')
      await fs.writeFile(reportPath, JSON.stringify(baseline))
      let currentUrl = baseline.url
      const store = {
        getJob: (id: string) =>
          id === 'base'
            ? { status: 'complete', reportPath, url: baseline.url }
            : { url: currentUrl },
        getScreenshot: () => null,
      } as unknown as JobStore
      const matched = await buildComparison(store, dir, 'current', 'base', current.viewports)
      expect(matched.repairVerification?.findings).toContainEqual(
        expect.objectContaining({ key: 'desktop:responsive-layout', state: 'fixed' }),
      )
      currentUrl = 'https://different.example.com'
      const mismatched = await buildComparison(store, dir, 'current', 'base', current.viewports)
      expect(mismatched.repairVerification?.sameUrl).toBe(false)
      expect(
        mismatched.repairVerification?.findings.every((item) => item.state === 'could_not_verify'),
      ).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
  it('reports fixed, still broken and newly broken independently per viewport/check', () => {
    const before = makeReport(),
      after = makeReport()
    before.viewports.desktop!.overflowDetected = true
    before.viewports.phonePortrait!.consoleErrors = ['before']
    after.viewports.phonePortrait!.consoleErrors = ['after']
    after.viewports.phoneLandscape!.failedRequests = [
      { url: 'https://example.com', status: 404, reason: 'http_404' },
    ]
    const result = buildRepairVerification(before, after)
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'desktop:responsive-layout', state: 'fixed' }),
        expect.objectContaining({ key: 'phonePortrait:console-errors', state: 'still_broken' }),
        expect.objectContaining({ key: 'phoneLandscape:failed-requests', state: 'newly_broken' }),
      ]),
    )
    expect(result.findings).toHaveLength(3)
  })

  it('preserves viewport identity when an accessibility problem moves to another viewport', () => {
    const before = makeReport(),
      after = makeReport()
    violate(before.viewports.desktop!)
    violate(after.viewports.phonePortrait!)
    const result = buildRepairVerification(before, after)
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'desktop:accessibility:button-name', state: 'fixed' }),
        expect.objectContaining({
          key: 'phonePortrait:accessibility:button-name',
          state: 'newly_broken',
        }),
      ]),
    )
  })

  it('does not claim an identical node was repaired when the same rule affects a different node', () => {
    const before = makeReport(),
      after = makeReport()
    violate(before.viewports.desktop!, 'button:nth-of-type(1)')
    violate(after.viewports.desktop!, 'button:nth-of-type(2)')
    const result = buildRepairVerification(before, after)
    expect(result.findings[0]).toMatchObject({
      state: 'still_broken',
      granularity: 'accessibility_rule',
      baselineLocators: ['button:nth-of-type(1)'],
      currentLocators: ['button:nth-of-type(2)'],
    })
    expect(result.limitations.join(' ')).toContain('different nodes')
  })

  it.each(['incomplete', 'capped', 'failed', 'missing'] as const)(
    'cannot prove a removed rule fixed when current evidence is %s',
    (kind) => {
      const before = makeReport(),
        after = makeReport()
      violate(before.viewports.desktop!)
      if (kind === 'incomplete') after.viewports.desktop!.accessibility.incomplete = 1
      if (kind === 'failed') after.viewports.desktop!.accessibility.completed = false
      if (kind === 'missing') delete after.viewports.desktop
      if (kind === 'capped') {
        for (let i = 0; i < 50; i++) {
          violate(after.viewports.desktop!)
          after.viewports.desktop!.accessibility.violations[i]!.id = `rule-${i}`
        }
      }
      expect(buildRepairVerification(before, after).findings).toContainEqual(
        expect.objectContaining({
          key: 'desktop:accessibility:button-name',
          state: 'could_not_verify',
        }),
      )
    },
  )

  it('requires measured layout and successfully loaded pages for clearance', () => {
    const before = makeReport(),
      after = makeReport()
    before.viewports.desktop!.overflowDetected = true
    after.viewports.desktop!.layoutObservation = 'unavailable'
    before.viewports.phonePortrait!.consoleErrors = ['error']
    after.viewports.phonePortrait!.loadStatus = 'timeout'
    const result = buildRepairVerification(before, after)
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'desktop:responsive-layout', state: 'could_not_verify' }),
        expect.objectContaining({ key: 'phonePortrait:console-errors', state: 'could_not_verify' }),
      ]),
    )
  })

  it('matches exact assertions, ignoring order and refusing changed expectations', () => {
    const before = makeReport(),
      after = makeReport()
    before.viewports.desktop!.assertions = [
      {
        assertion: { type: 'selectorVisible', selector: '#old' },
        passed: false,
        detail: 'Not found',
      },
      { assertion: { type: 'titleIncludes', value: 'Hello' }, passed: false, detail: 'Not found' },
    ]
    after.viewports.desktop!.assertions = [
      { assertion: { type: 'titleIncludes', value: 'Hello' }, passed: true, detail: 'Found' },
      { assertion: { type: 'selectorVisible', selector: '#new' }, passed: true, detail: 'Found' },
    ]
    const findings = buildRepairVerification(before, after).findings
    expect(
      findings
        .filter((item) => item.granularity === 'assertion')
        .map((item) => item.state)
        .sort(),
    ).toEqual(['could_not_verify', 'could_not_verify', 'fixed'])
  })

  it('does not mistake legacy assertion evaluation failure for a measured failure', () => {
    const before = makeReport(),
      after = makeReport()
    before.viewports.desktop!.assertions = [
      {
        assertion: { type: 'titleIncludes', value: 'Hello' },
        passed: false,
        detail: 'Assertion could not be evaluated.',
      },
    ]
    after.viewports.desktop!.assertions = [
      { assertion: { type: 'titleIncludes', value: 'Hello' }, passed: true, detail: 'Found' },
    ]
    expect(buildRepairVerification(before, after).findings[0]?.state).toBe('could_not_verify')
  })

  it('refuses different or missing target URLs and tolerates older incomplete evidence', () => {
    const before = makeReport(),
      after = makeReport({ url: 'https://example.org' })
    before.viewports.desktop!.overflowDetected = true
    expect(buildRepairVerification(before, after)).toMatchObject({ sameUrl: false })
    expect(
      buildRepairVerification(before, after).findings.every(
        (item) => item.state === 'could_not_verify',
      ),
    ).toBe(true)
    const legacy = { viewports: {} } as typeof before
    expect(
      buildRepairVerification(legacy, after).findings.every(
        (item) => item.state === 'could_not_verify',
      ),
    ).toBe(true)
  })
})
