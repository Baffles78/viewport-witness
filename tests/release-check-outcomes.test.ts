import { describe, it, expect, vi } from 'vitest'
import { runReleaseCheck } from '../src/release-check.js'
import type { ReleaseState, PaymentAdapter } from '../src/release-check.js'
import { makeManifest, jsonResponse, challengeResponse, terminalReport, makeCheckpoint, noValidation } from './helpers/release-check-fixtures.js'

// --- helpers ----------------------------------------------------------------

// --- tests ------------------------------------------------------------------

describe('runReleaseCheck — FAIL and INCONCLUSIVE outcomes', () => {
  it('returns FAIL when any page fails', async () => {
    const jobId = 'fa110000-0000-0000-0000-000000000001'
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: jobId, idempotent: true }, 202))
      .mockResolvedValueOnce(jsonResponse(terminalReport(jobId, 'https://example.com', 'FAIL')))
    const cp = makeCheckpoint()
    const result = await runReleaseCheck(makeManifest(), {
      serviceUrl: 'http://127.0.0.1:3000',
      testMode: true,
      execute: true,
      fetchFn: fetch,
      checkpoint: cp,
      validateTarget: noValidation,
      sleep: async () => {},
    })
    expect(result.decision).toBe('FAIL')
  })

  it('returns INCONCLUSIVE when polling times out', async () => {
    const jobId = 'a0110000-0000-0000-0000-000000000002'
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: jobId, idempotent: true }, 202))
      .mockResolvedValue(
        jsonResponse({ id: jobId, url: 'https://example.com', kind: 'check', status: 'running' }),
      )
    const cp = makeCheckpoint()
    const result = await runReleaseCheck(makeManifest(), {
      serviceUrl: 'http://127.0.0.1:3000',
      testMode: true,
      execute: true,
      fetchFn: fetch,
      checkpoint: cp,
      pollAttempts: 2,
      pollIntervalMs: 0,
      validateTarget: noValidation,
      sleep: async () => {},
    })
    expect(result.decision).toBe('INCONCLUSIVE')
  })

  it('resumes without repayment after accepted timeout (job already in checkpoint)', async () => {
    const jobId = 'eeee0000-0000-0000-0000-000000000003'
    let saved: ReleaseState | null = null
    // Pre-seed checkpoint with accepted state
    const cp = {
      load: () => saved,
      save: (s: ReleaseState) => {
        saved = s
      },
    }
    // First run: get job accepted, then timeout
    const fetch1 = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: jobId, idempotent: true }, 202))
      .mockResolvedValue(
        jsonResponse({ id: jobId, url: 'https://example.com', kind: 'check', status: 'running' }),
      )
    await runReleaseCheck(makeManifest(), {
      serviceUrl: 'http://127.0.0.1:3000',
      testMode: true,
      execute: true,
      fetchFn: fetch1,
      checkpoint: cp,
      pollAttempts: 1,
      pollIntervalMs: 0,
      validateTarget: noValidation,
      sleep: async () => {},
    })
    // Second run: checkpoint has accepted job; adapter should NOT be called again
    const adapter: PaymentAdapter = vi.fn().mockRejectedValue(new Error('Should not be called'))
    const fetch2 = vi
      .fn()
      .mockResolvedValue(jsonResponse(terminalReport(jobId, 'https://example.com', 'PASS')))
    const result2 = await runReleaseCheck(makeManifest(), {
      serviceUrl: 'http://127.0.0.1:3000',
      testMode: true,
      execute: true,
      fetchFn: fetch2,
      checkpoint: cp,
      validateTarget: noValidation,
      sleep: async () => {},
      adapter,
    })
    expect(adapter).not.toHaveBeenCalled()
    expect(result2.decision).toBe('PASS')
  })
})

describe('runReleaseCheck — uncertain payment blocks retry', () => {
  it('awaits asynchronous durable reservation and never pays when saving fails', async () => {
    const endpoint = 'http://127.0.0.1:3000/v1/checks'
    const adapter = vi.fn()
    const checkpoint = {
      load: () => null,
      save: async () => {
        await Promise.resolve()
        throw new Error('disk unavailable')
      },
    }
    await expect(
      runReleaseCheck(makeManifest(), {
        serviceUrl: 'http://127.0.0.1:3000',
        testMode: true,
        execute: true,
        fetchFn: vi.fn().mockResolvedValue(challengeResponse(endpoint)),
        checkpoint,
        adapter,
        validateTarget: noValidation,
      }),
    ).rejects.toThrow('disk unavailable')
    expect(adapter).not.toHaveBeenCalled()
  })
  it('refuses to invoke adapter again for a payment-attempted page', async () => {
    const endpoint = 'http://127.0.0.1:3000/v1/checks'
    // Seed checkpoint with payment-attempted state
    const manifestHash = (() => {
      const { createHash } = require('node:crypto') // eslint-disable-line @typescript-eslint/no-require-imports
      return createHash('sha256')
        .update(
          JSON.stringify({
            manifest: makeManifest(),
            service: 'http://127.0.0.1:3000',
            testMode: true,
          }),
        )
        .digest('hex')
    })()
    const injectedState: ReleaseState = {
      schema: 'viewport-witness-release/v1',
      manifestHash,
      pages: [
        {
          index: 0,
          targetHash: (() => {
            const { createHash } = require('node:crypto') // eslint-disable-line @typescript-eslint/no-require-imports
            return createHash('sha256').update(JSON.stringify('https://example.com')).digest('hex')
          })(),
          state: 'payment-attempted',
          reservedAtomic: '80000',
        },
      ],
    }
    let state: ReleaseState | null = injectedState
    const cp2 = {
      load: () => state,
      save: (s: ReleaseState) => {
        state = s
      },
    }
    const challengeRes = challengeResponse(endpoint)
    const fetch = vi.fn().mockResolvedValue(challengeRes)
    const adapter: PaymentAdapter = vi.fn().mockRejectedValue(new Error('adapter was called'))
    await expect(
      runReleaseCheck(makeManifest(), {
        serviceUrl: 'http://127.0.0.1:3000',
        testMode: true,
        execute: true,
        fetchFn: fetch,
        checkpoint: cp2,
        adapter,
        validateTarget: noValidation,
      }),
    ).rejects.toThrow('uncertain')
    expect(adapter).not.toHaveBeenCalled()
  })
})

describe('runReleaseCheck — unsupported challenge/assets/service/targets', () => {
  it('rejects challenge with wrong x402Version', async () => {
    const endpoint = 'http://127.0.0.1:3000/v1/checks'
    const encoded = Buffer.from(
      JSON.stringify({ x402Version: 1, resource: { url: endpoint }, accepts: [] }),
      'utf8',
    ).toString('base64')
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 402, headers: { 'payment-required': encoded } }),
      )
    const cp = makeCheckpoint()
    await expect(
      runReleaseCheck(makeManifest(), {
        serviceUrl: 'http://127.0.0.1:3000',
        testMode: true,
        execute: true,
        fetchFn: fetch,
        checkpoint: cp,
        validateTarget: noValidation,
      }),
    ).rejects.toThrow()
  })

  it('rejects challenge with unrecognised asset', async () => {
    const endpoint = 'http://127.0.0.1:3000/v1/checks'
    const challenge = {
      x402Version: 2,
      resource: { url: endpoint },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0xBADBADBAD',
          amount: '80000',
          payTo: '0xRevenue',
        },
      ],
    }
    const encoded = Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64')
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 402, headers: { 'payment-required': encoded } }),
      )
    const cp = makeCheckpoint()
    await expect(
      runReleaseCheck(makeManifest(), {
        serviceUrl: 'http://127.0.0.1:3000',
        testMode: true,
        execute: true,
        fetchFn: fetch,
        checkpoint: cp,
        validateTarget: noValidation,
      }),
    ).rejects.toThrow('No supported exact USDC requirement')
  })

  it('rejects challenge where requirement.network is not a string', async () => {
    const endpoint = 'http://127.0.0.1:3000/v1/checks'
    const challenge = {
      x402Version: 2,
      resource: { url: endpoint },
      accepts: [
        {
          scheme: 'exact',
          network: null,
          asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          amount: '80000',
          payTo: '0xRevenue',
        },
      ],
    }
    const encoded = Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64')
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 402, headers: { 'payment-required': encoded } }),
      )
    const cp = makeCheckpoint()
    await expect(
      runReleaseCheck(makeManifest(), {
        serviceUrl: 'http://127.0.0.1:3000',
        testMode: true,
        execute: true,
        fetchFn: fetch,
        checkpoint: cp,
        validateTarget: noValidation,
      }),
    ).rejects.toThrow()
  })
})

describe('runReleaseCheck — redacted human Markdown', () => {
  it('strips query params and credentials from URLs in Markdown output', async () => {
    const jobId = 'eeee0000-0000-0000-0000-000000000004'
    const pageUrl = 'https://example.com/page?token=secret&user=admin'
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: jobId, idempotent: true }, 202))
      .mockResolvedValue(jsonResponse(terminalReport(jobId, pageUrl, 'PASS')))
    const cp = makeCheckpoint()
    const result = await runReleaseCheck(makeManifest({ pages: [pageUrl] }), {
      serviceUrl: 'http://127.0.0.1:3000',
      testMode: true,
      execute: true,
      fetchFn: fetch,
      checkpoint: cp,
      validateTarget: noValidation,
      sleep: async () => {},
    })
    expect(result.markdown).not.toContain('token=secret')
    expect(result.markdown).not.toContain('user=admin')
  })
})

describe('runReleaseCheck — changed manifest refuses old checkpoint', () => {
  it('throws when checkpoint manifestHash does not match new manifest', async () => {
    const cp = {
      load: () => ({
        schema: 'viewport-witness-release/v1' as const,
        manifestHash: 'aaaa0000000000000000000000000000aaaa0000000000000000000000000000',
        pages: [
          {
            index: 0,
            targetHash: 'bbbb0000000000000000000000000000bbbb0000000000000000000000000000',
            state: 'planned' as const,
            reservedAtomic: '0',
          },
        ],
      }),
      save: () => {},
    }
    await expect(
      runReleaseCheck(makeManifest(), {
        serviceUrl: 'http://127.0.0.1:3000',
        testMode: true,
        checkpoint: cp,
        validateTarget: noValidation,
      }),
    ).rejects.toThrow('Checkpoint does not match')
  })
})
