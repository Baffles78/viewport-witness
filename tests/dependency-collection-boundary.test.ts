import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { visualExclusionsSchema } from '../src/visual-exclusions.js'
import { assertionsSchema } from '../src/mcp/tool-schemas.js'
import { readFileSync } from 'node:fs'

describe('constrained collection dependency boundary', () => {
  it('ships no CDP SDK or advisory-affected Zod copy in either locked distribution', () => {
    for (const file of ['package-lock.json', 'client/npm-shrinkwrap.json']) {
      const inventory = JSON.parse(
        readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
      ) as { packages: Record<string, { version?: string }> }
      const entries = Object.entries(inventory.packages)
      expect(entries.some(([path]) => path.includes('node_modules/@coinbase/cdp-sdk'))).toBe(false)
      const zod = entries.filter(([path]) => path.endsWith('/zod'))
      expect(zod.length).toBeGreaterThan(0)
      for (const [, pkg] of zod) expect(pkg.version).toBe('4.6.7')
    }
  })
  it('rejects oversized hosted exclusion arrays before constructing element errors', () => {
    const result = visualExclusionsSchema.safeParse({
      desktop: Array.from({ length: 1000 }, () => null),
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected rejection')
    expect(result.error.issues).toHaveLength(1)
    expect(result.error.issues[0]?.code).toBe('too_big')
    expect(result.error.issues[0]?.path).toEqual(['desktop'])
  })

  it('rejects oversized MCP assertion arrays before constructing element errors', () => {
    const result = assertionsSchema.safeParse(Array.from({ length: 1000 }, () => null))
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected rejection')
    expect(result.error.issues).toHaveLength(1)
    expect(result.error.issues[0]?.code).toBe('too_big')
  })

  it('preserves legitimate comparison regions and assertions', () => {
    expect(
      visualExclusionsSchema.parse({ desktop: [{ x: 0, y: 0, width: 10, height: 10 }] }),
    ).toEqual({ desktop: [{ x: 0, y: 0, width: 10, height: 10 }] })
    expect(assertionsSchema.parse([{ type: 'noConsoleErrors' }])).toEqual([
      { type: 'noConsoleErrors' },
    ])
  })

  it('rejects alternate constrained map/set forms before evaluating elements', () => {
    let visited = 0
    const item = z.string().refine(() => {
      visited++
      return false
    })
    expect(
      z
        .set(item)
        .max(1)
        .safeParse(new Set(['a', 'b'])).success,
    ).toBe(false)
    expect(
      z
        .map(item, item)
        .max(1)
        .safeParse(
          new Map([
            ['a', 'b'],
            ['c', 'd'],
          ]),
        ).success,
    ).toBe(false)
    expect(visited).toBe(0)
  })
})
