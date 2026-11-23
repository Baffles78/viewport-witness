import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('published quickstart stages', () => {
  it('starts with the pinned free doctor and retains explicit payment/recovery controls', () => {
    const text = readFileSync(new URL('../docs/QUICKSTART.md', import.meta.url), 'utf8')
    const command = text.match(/```sh\s+([^`]+)```/)?.[1]?.trim()
    expect(command).toBe('npx --yes --package=https://github.com/Baffles78/viewport-witness/releases/download/client-v0.3.1/viewport-witness-client-0.3.1.tgz -- viewport-witness doctor --url https://example.com')
    expect(text).not.toContain('client-v0.2.0')
    expect(text).toContain('default is doctor plus an unpaid preview')
    expect(text).toContain('spendingApproved: false')
    expect(text).toContain('--recipient APPROVED_RECIPIENT --execute')
    expect(text).toContain('--resume --output out/my-deployment-001')
    expect(text).toContain('Do not rerun with changed policy to bypass an uncertain payment')
  })
})
