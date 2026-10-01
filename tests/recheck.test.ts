import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildRecheckManifest } from '../src/recheck.js'
import type { ReleaseManifest, ReleaseState } from '../src/release-check.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function evidence() {
  const manifest: ReleaseManifest = {
    runId: 'original',
    pages: ['https://example.com', 'https://example.com/fix?version=2'],
    maxBudgetUsdc: '0.16',
    allowedNetwork: 'eip155:8453',
    allowedPayTo: `0x${'22'.repeat(20)}`,
  }
  const manifestHash = hash({ manifest, service: 'https://qa.honeygate.app', testMode: false })
  const checkpoint: ReleaseState = {
    schema: 'viewport-witness-release/v1',
    manifestHash,
    pages: manifest.pages.map((page, index) => ({
      index,
      targetHash: hash(page),
      state: 'accepted',
      reservedAtomic: '80000',
      jobId: `job-${index}`,
      terminal: true,
      decision: index === 0 ? 'PASS' : 'FAIL',
    })),
  }
  const summary = {
    schema: 'viewport-witness-release-summary/v1',
    runId: manifest.runId,
    manifestHash,
    dryRun: false,
    pages: checkpoint.pages.map((page) => ({
      index: page.index,
      url: page.index ? 'https://example.com/fix' : 'https://example.com/',
      reportUrl: `https://qa.honeygate.app/v1/checks/${page.jobId}`,
      decision: page.decision!,
      terminal: true,
    })),
  }
  return { manifest, checkpoint, summary }
}
const next = { runId: 'after-fix', maxBudgetUsdc: '0.08' }
describe('recheck planning', () => {
  it('selects failed pages and preserves original URLs and payment policy', () => {
    const { manifest, checkpoint, summary } = evidence()
    const result = buildRecheckManifest(manifest, summary, checkpoint, next)
    expect(result.status).toBe('planned')
    expect(result.manifest?.pages).toEqual(['https://example.com/fix?version=2'])
    expect(result.manifest?.allowedPayTo).toBe(manifest.allowedPayTo)
    expect(result.manifest?.maxBudgetUsdc).toBe('0.08')
    expect(manifest.runId).toBe('original')
  })
  it.each(['payment-attempted', 'planned', 'accepted'] as const)(
    'blocks new purchases for unfinished %s evidence',
    (state) => {
      const { manifest, checkpoint, summary } = evidence()
      checkpoint.pages[1]!.state = state
      checkpoint.pages[1]!.terminal = false
      summary.pages[1]!.terminal = false
      expect(buildRecheckManifest(manifest, summary, checkpoint, next)).toEqual({
        status: 'resume_or_reconcile',
        indices: [1],
        manifest: null,
      })
    },
  )
  it('rejects stale/tampered summaries, duplicate indices and unpaid previews', () => {
    for (const mutate of [
      (data: ReturnType<typeof evidence>) => {
        data.summary.manifestHash = 'wrong'
      },
      (data: ReturnType<typeof evidence>) => {
        data.summary.dryRun = true
      },
      (data: ReturnType<typeof evidence>) => {
        data.summary.pages[1]!.index = 0
      },
      (data: ReturnType<typeof evidence>) => {
        data.checkpoint.pages[1]!.targetHash = 'wrong'
      },
      (data: ReturnType<typeof evidence>) => {
        data.summary.pages[1]!.reportUrl = 'https://attacker.example/job'
      },
    ]) {
      const data = evidence()
      mutate(data)
      expect(() =>
        buildRecheckManifest(data.manifest, data.summary, data.checkpoint, next),
      ).toThrow()
    }
  })
  it('requires a fresh run ID and explicit bounded budget', () => {
    const { manifest, summary, checkpoint } = evidence()
    for (const proposed of [
      { ...next, runId: 'original' },
      { ...next, maxBudgetUsdc: '0' },
      { ...next, maxBudgetUsdc: '0.17' },
    ])
      expect(() => buildRecheckManifest(manifest, summary, checkpoint, proposed)).toThrow()
  })
  it('does not propose another purchase for an all-pass run', () => {
    const { manifest, summary, checkpoint } = evidence()
    summary.pages[1]!.decision = 'PASS'
    checkpoint.pages[1]!.decision = 'PASS'
    expect(buildRecheckManifest(manifest, summary, checkpoint, next).status).toBe(
      'nothing_to_recheck',
    )
  })
})
