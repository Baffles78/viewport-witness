import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { buildComparison } from '../src/worker/comparison.js'

type Comparison = {
  evidenceComplete: boolean
  evidenceLimitations: string[]
  visual: Record<string, { changedPixels: number; changedPercent: number; diffImageUrl: string }>
  accessibility: { newViolationIds: string[]; resolvedViolationIds: string[] }
  errors: { baseline: number; current: number; delta: number }
}

async function png(file: string, red: number): Promise<void> {
  const image = new PNG({ width: 4, height: 4 })
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = red
    image.data[i + 3] = 255
  }
  await fs.writeFile(file, PNG.sync.write(image))
}

function viewport(violations: string[], errors = 0) {
  return {
    accessibility: { violations: violations.map((id) => ({ id })) },
    consoleErrors: Array.from({ length: errors }, () => 'e'),
    failedRequests: [],
  }
}

async function compare(): Promise<Comparison> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-compare-'))
  await fs.mkdir(path.join(dir, 'current'))
  const shots: Record<string, { path: string; sha256: string }> = {}
  for (const [job, red] of [['base', 0], ['current', 255]] as const) {
    for (const v of ['phonePortrait', 'phoneLandscape']) {
      const file = path.join(dir, `${job}-${v}.png`)
      await png(file, v === 'phonePortrait' ? red : 0)
      shots[`${job}:${v}`] = { path: file, sha256: `${job}-${v}` }
    }
  }
  const reportPath = path.join(dir, 'base.json')
  await fs.writeFile(
    reportPath,
    JSON.stringify({ summary: { totalErrors: 1 }, viewports: { desktop: viewport(['old', 'kept']) } }),
  )
  const store = {
    getJob: (id: string) => (id === 'base' ? { status: 'complete', reportPath } : undefined),
    getScreenshot: (job: string, v: string) => shots[`${job}:${v}`] ?? null,
  }
  return (await buildComparison(store as never, dir, 'current', 'base', {
    phonePortrait: viewport(['kept', 'new'], 2),
    phoneLandscape: viewport([]),
  } as never)) as unknown as Comparison
}

describe('baseline comparison', () => {
  it('diffs screenshots, accessibility ids and error counts', async () => {
    const result = await compare()
    expect(result.visual.phonePortrait.changedPixels).toBe(16)
    expect(result.visual.phonePortrait.changedPercent).toBe(100)
    expect(result.visual.phonePortrait.diffImageUrl).toBe('/v1/checks/current/diffs/phonePortrait')
    expect(result.visual.phoneLandscape.changedPixels).toBe(0)
    expect(result.evidenceComplete).toBe(false)
    expect(result.evidenceLimitations).toEqual(['desktop: screenshot evidence is missing.'])
    expect(result.accessibility).toEqual({ newViolationIds: ['new'], resolvedViolationIds: ['old'] })
    expect(result.errors).toEqual({ baseline: 1, current: 2, delta: 1 })
  })
})
