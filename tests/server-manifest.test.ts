import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface ServerManifest {
  name: string
  description: string
  version: string
}

describe('official MCP Registry manifest', () => {
  it('keeps Registry-bounded fields valid', () => {
    const manifest = JSON.parse(readFileSync('server.json', 'utf8')) as ServerManifest
    expect(manifest.name).toBe('io.github.Baffles78/viewport-witness')
    expect(manifest.version).toBe('0.2.1')
    expect(manifest.description.length).toBeLessThanOrEqual(100)
  })
})
