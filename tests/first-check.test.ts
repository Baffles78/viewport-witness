import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error JavaScript CLI entrypoint is tested through its exported preparation API.
import { prepareFirstCheck } from '../scripts/first-check.mjs'

describe('first-check buyer entrypoint', () => {
  it('prepares a no-payment run without requesting or loading wallet code', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-first-check-'))
    const prepared = await prepareFirstCheck([
      '--url',
      'https://example.com',
      '--run-id',
      'deploy-123',
      '--output',
      output,
    ])
    const manifest = JSON.parse(await fs.readFile(prepared.manifestPath, 'utf8'))
    expect(manifest).toEqual({
      runId: 'deploy-123',
      pages: ['https://example.com'],
      maxBudgetUsdc: '0.08',
    })
    expect(prepared.clientArgs).not.toContain('--execute')
    expect(prepared.clientArgs).not.toContain('--wallet-module')
  })

  it('requires explicit run, wallet and payment policy for execution', async () => {
    await expect(prepareFirstCheck(['--url', 'https://example.com', '--execute'])).rejects.toThrow(
      'Execution requires',
    )
  })

  it('preserves a prior manifest and checkpoint when execution parameters change', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-first-check-'))
    const first = await prepareFirstCheck([
      '--url',
      'https://example.com',
      '--run-id',
      'deploy-123',
      '--output',
      output,
    ])
    const original = await fs.readFile(first.manifestPath, 'utf8')
    await fs.writeFile(path.join(output, 'checkpoint.json'), '{"uncertain":true}')
    await expect(
      prepareFirstCheck([
        '--url',
        'https://example.com/new',
        '--run-id',
        'deploy-123',
        '--output',
        output,
      ]),
    ).rejects.toThrow('checkpoint')
    expect(await fs.readFile(first.manifestPath, 'utf8')).toBe(original)
  })
})
