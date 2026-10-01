import { createHash } from 'node:crypto'
import {
  safeDisplayUrl,
  usdcAtomic,
  type ReleaseManifest,
  type ReleaseState,
} from './release-check.js'

interface Summary {
  schema: string
  runId: string
  manifestHash: string
  dryRun: boolean
  pages: Array<{
    index: number
    url: string
    reportUrl: string
    decision: string
    terminal: boolean
  }>
}
/** Plans only. Never invokes a wallet, executes a fix, or pays for a replacement job. */
export function buildRecheckManifest(
  manifest: ReleaseManifest,
  summary: Summary,
  checkpoint: ReleaseState,
  next: { runId: string; maxBudgetUsdc: string },
) {
  if (
    !manifest ||
    !/^[-a-zA-Z0-9_]{1,60}$/.test(next.runId) ||
    next.runId === manifest.runId ||
    usdcAtomic(next.maxBudgetUsdc) <= 0n ||
    usdcAtomic(next.maxBudgetUsdc) > usdcAtomic(manifest.maxBudgetUsdc)
  )
    throw new Error(
      'A distinct run ID and positive budget no larger than the prior approval are required',
    )
  const expectedHash = createHash('sha256')
    .update(JSON.stringify({ manifest, service: 'https://qa.honeygate.app', testMode: false }))
    .digest('hex')
  if (
    summary.schema !== 'viewport-witness-release-summary/v1' ||
    summary.dryRun !== false ||
    summary.runId !== manifest.runId ||
    summary.manifestHash !== expectedHash ||
    checkpoint.schema !== 'viewport-witness-release/v1' ||
    checkpoint.manifestHash !== expectedHash ||
    !Array.isArray(summary.pages) ||
    summary.pages.length !== manifest.pages.length ||
    checkpoint.pages.length !== manifest.pages.length
  )
    throw new Error('Summary and checkpoint must match the original production release manifest')
  const indices = new Set<number>()
  const selected: number[] = [],
    pending: number[] = []
  for (const row of summary.pages) {
    const page = checkpoint.pages[row.index]
    if (
      !Number.isInteger(row.index) ||
      row.index < 0 ||
      row.index >= manifest.pages.length ||
      indices.has(row.index) ||
      !page ||
      page.index !== row.index ||
      page.targetHash !==
        createHash('sha256').update(JSON.stringify(manifest.pages[row.index])).digest('hex') ||
      !['PASS', 'FAIL', 'INCONCLUSIVE'].includes(row.decision) ||
      row.url !== safeDisplayUrl(manifest.pages[row.index]!) ||
      page.decision !== row.decision ||
      row.terminal !== page.terminal ||
      (page.state === 'accepted' &&
        row.reportUrl !== `https://qa.honeygate.app/v1/checks/${page.jobId}`)
    )
      throw new Error('Release evidence is inconsistent; inspect the original jobs')
    indices.add(row.index)
    if (page.state !== 'accepted' || row.terminal !== true) pending.push(row.index)
    else if (row.decision !== 'PASS') selected.push(row.index)
  }
  if (pending.length)
    return { status: 'resume_or_reconcile' as const, indices: pending, manifest: null }
  if (!selected.length)
    return { status: 'nothing_to_recheck' as const, indices: [], manifest: null }
  return {
    status: 'planned' as const,
    indices: selected,
    manifest: {
      ...manifest,
      runId: next.runId,
      pages: selected.map((index) => manifest.pages[index]!),
      maxBudgetUsdc: next.maxBudgetUsdc,
    },
  }
}
