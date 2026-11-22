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

  it('selects the supplied CDP connector only for an explicit Base execution', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-cdp-first-'))
    const prepared = await prepareFirstCheck([
      '--url',
      'https://example.com',
      '--run-id',
      'cdp-one',
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
    expect(prepared.walletKind).toBe('cdp')
    expect(prepared.clientArgs).toContain('--execute')
    expect(prepared.clientArgs.at(-1)).toMatch(/examples[\\/]wallets[\\/]existing-cdp-base\.mjs$/)
    const reference = JSON.parse(await fs.readFile(path.join(output, 'first-check.json'), 'utf8'))
    expect(reference.manifest).toBe(path.basename(prepared.manifestPath))
    expect(reference.schema).toBe('viewport-witness-first-check/v1')
    await expect(
      prepareFirstCheck(['--url', 'https://example.com', '--wallet', 'cdp']),
    ).rejects.toThrow('explicit --network base')
    await expect(
      prepareFirstCheck([
        '--url',
        'https://example.com',
        '--wallet',
        'cdp',
        '--network',
        'base',
        '--wallet-module',
        'custom.mjs',
      ]),
    ).rejects.toThrow('not both')
  })

  it('recovers an accepted job with only its output directory and no wallet options', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-first-resume-'))
    const first = await prepareFirstCheck([
      '--url',
      'https://example.com',
      '--run-id',
      'resume-one',
      '--output',
      output,
      '--network',
      'base',
      '--recipient',
      '0x' + '22'.repeat(20),
      '--wallet-module',
      'existing.mjs',
      '--execute',
    ])
    await fs.writeFile(
      path.join(output, 'checkpoint.json'),
      JSON.stringify({
        schema: 'viewport-witness-release/v1',
        pages: [{ state: 'accepted', jobId: '11111111-1111-4111-8111-111111111111' }],
      }),
    )
    const prepared = await prepareFirstCheck(['--resume', '--output', output])
    expect(prepared.manifestPath).toBe(first.manifestPath)
    expect(prepared.clientArgs).toContain('--resume-only')
    expect(prepared.clientArgs).not.toContain('--execute')
    expect(prepared.clientArgs).not.toContain('--wallet-module')
    expect(prepared.clientArgs).not.toContain('--adapter')
    expect(prepared.clientArgs).toContain(path.join(output, 'resumed'))
    await expect(prepareFirstCheck(['--resume', '--output', output, '--execute'])).rejects.toThrow(
      'no wallet',
    )
    await expect(
      prepareFirstCheck(['--resume', '--output', output, '--url', 'https://other.example']),
    ).rejects.toThrow('no wallet')
  })

  it('refuses uncertain recovery and manifest traversal without changing the checkpoint', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-uncertain-resume-'))
    const first = await prepareFirstCheck([
      '--url',
      'https://example.com',
      '--run-id',
      'legacy',
      '--output',
      output,
    ])
    const checkpoint = JSON.stringify({
      schema: 'viewport-witness-release/v1',
      pages: [{ state: 'payment-attempted', reservedAtomic: '80000' }],
    })
    await fs.writeFile(path.join(output, 'checkpoint.json'), checkpoint)
    await expect(prepareFirstCheck(['--resume', '--output', output])).rejects.toThrow('Legacy run')
    await expect(
      prepareFirstCheck([
        '--resume',
        '--output',
        output,
        '--manifest',
        path.basename(first.manifestPath),
      ]),
    ).rejects.toThrow('reconcile uncertain')
    await expect(
      prepareFirstCheck([
        '--resume',
        '--output',
        output,
        '--manifest',
        '../manifest-' + 'a'.repeat(24) + '.json',
      ]),
    ).rejects.toThrow('basename')
    expect(await fs.readFile(path.join(output, 'checkpoint.json'), 'utf8')).toBe(checkpoint)
  })

  it('does not redirect recovery when a second preview uses the output folder', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-reference-'))
    await prepareFirstCheck([
      '--url',
      'https://example.com',
      '--run-id',
      'original',
      '--output',
      output,
      '--network',
      'base',
      '--recipient',
      '0x' + '22'.repeat(20),
      '--wallet-module',
      'existing.mjs',
      '--execute',
    ])
    const before = await fs.readFile(path.join(output, 'first-check.json'), 'utf8')
    await prepareFirstCheck([
      '--url',
      'https://example.com/other',
      '--run-id',
      'preview-two',
      '--output',
      output,
    ])
    expect(await fs.readFile(path.join(output, 'first-check.json'), 'utf8')).toBe(before)
  })
})
