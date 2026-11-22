import { beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'

const root = process.cwd()
beforeAll(() => {
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc')], {
    cwd: root,
    stdio: 'pipe',
  })
}, 30000)

async function cli(script: string, args: string[], overrides: Record<string, string> = {}) {
  return new Promise<{ code: number; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      shell: false,
      env: {
        ...process.env,
        CDP_API_KEY_ID: '',
        CDP_API_KEY_SECRET: '',
        CDP_WALLET_SECRET: '',
        VW_PAYER_ADDRESS: '',
        ...overrides,
      },
    })
    let text = ''
    child.stdout.on('data', (value) => {
      text += String(value)
    })
    child.stderr.on('data', (value) => {
      text += String(value)
    })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code: code ?? 2, text }))
  })
}

describe('first-check real CLI safety', () => {
  it('reports missing CDP variable names before wallet loading or payment', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-cdp-cli-'))
    const result = await cli('scripts/first-check.mjs', [
      '--url',
      'https://example.com',
      '--run-id',
      'cdp-config',
      '--output',
      output,
      '--network',
      'base',
      '--recipient',
      '0x' + '22'.repeat(20),
      '--wallet',
      'cdp',
      '--execute',
    ])
    expect(result.code).toBe(2)
    expect(result.text).toContain('CDP setup missing local environment variables')
    expect(result.text).toContain('CDP_WALLET_SECRET')
    expect(result.text).toContain('No wallet loaded or payment attempted')
    expect(await fs.stat(path.join(output, 'checkpoint.json')).catch(() => null)).toBeNull()
  })

  it('checks an uncertain checkpoint under its lock without loading a caller-supplied adapter', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-resume-cli-'))
    const manifest = path.join(output, 'manifest.json')
    const state = path.join(output, 'checkpoint.json')
    const checkpoint = JSON.stringify({
      schema: 'viewport-witness-release/v1',
      pages: [{ state: 'payment-attempted', reservedAtomic: '80000' }],
    })
    await fs.writeFile(
      manifest,
      JSON.stringify({
        runId: 'uncertain-one',
        pages: ['https://example.com'],
        maxBudgetUsdc: '0.08',
      }),
    )
    await fs.writeFile(state, checkpoint)
    const refused = await cli('scripts/release-check.mjs', [
      '--manifest',
      manifest,
      '--state',
      state,
      '--resume-only',
    ])
    expect(refused.code).toBe(2)
    expect(refused.text).toContain('requires accepted checkpoint jobs')
    expect(await fs.readFile(state, 'utf8')).toBe(checkpoint)
    expect(await fs.stat(state + '.lock').catch(() => null)).toBeNull()
    const forbidden = await cli('scripts/release-check.mjs', [
      '--manifest',
      manifest,
      '--state',
      state,
      '--resume-only',
      '--wallet-module',
      'never-load-this.mjs',
    ])
    expect(forbidden.code).toBe(2)
    expect(forbidden.text).toContain('does not accept execution, adapter or wallet')
  })

  it('refuses missing checkpoint recovery rather than creating a new planned purchase', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-missing-resume-'))
    const manifest = 'manifest-' + 'a'.repeat(24) + '.json'
    await fs.writeFile(
      path.join(output, manifest),
      JSON.stringify({ runId: 'missing', pages: ['https://example.com'], maxBudgetUsdc: '0.08' }),
    )
    const result = await cli('scripts/first-check.mjs', [
      '--resume',
      '--output',
      output,
      '--manifest',
      manifest,
    ])
    expect(result.code).toBe(2)
    expect(result.text).toContain('No saved checkpoint exists')
    expect(await fs.stat(path.join(output, 'checkpoint.json')).catch(() => null)).toBeNull()
  })
})
