import { describe, it, expect, vi } from 'vitest'
import { runReleaseCheck, usdcAtomic, safeDisplayUrl } from '../src/release-check.js'
import type { ReleaseManifest, ReleaseState, PaymentAdapter } from '../src/release-check.js'

// --- helpers ----------------------------------------------------------------

function makeManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    runId: 'run-test-001',
    pages: ['https://example.com'],
    maxBudgetUsdc: '1.000000',
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body)
  const chunks = [new TextEncoder().encode(text)]
  let idx = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (idx < chunks.length) ctrl.enqueue(chunks[idx++]!)
      else ctrl.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'application/json' } })
}

function makeChallenge(url: string, amount = '80000') {
  const requirement = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    amount,
    payTo: '0xRevenue',
  }
  return { x402Version: 2, resource: { url }, accepts: [requirement] }
}

function challengeResponse(url: string, challengeAmount = '80000'): Response {
  const encoded = Buffer.from(JSON.stringify(makeChallenge(url, challengeAmount)), 'utf8').toString(
    'base64',
  )
  return new Response(null, { status: 402, headers: { 'payment-required': encoded } })
}

function terminalReport(
  id: string,
  url: string,
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'PASS',
) {
  const decision = status === 'PASS' ? 'safe_to_ship' : status === 'FAIL' ? 'failed' : 'review'
  return {
    id,
    url,
    kind: 'check',
    status,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    verdict: { decision, reasons: [], blockingIssues: status === 'FAIL' ? 1 : 0 },
    viewports: Object.fromEntries(
      ['phonePortrait', 'phoneLandscape', 'desktop'].map((vp) => [
        vp,
        {
          loadStatus: 'success',
          accessibility: { completed: true },
          screenshotUrl: `/screenshots/${vp}`,
          screenshotSha256: 'fixture-sha256',
        },
      ]),
    ),
  }
}

function makeCheckpoint() {
  let state: ReleaseState | null = null
  return {
    load: () => state,
    save: (s: ReleaseState) => {
      state = s
    },
    get: () => state,
  }
}

const noValidation = async (_url: string) => ({ valid: true as const, url: _url })

// --- tests ------------------------------------------------------------------

describe('usdcAtomic', () => {
  it('converts whole numbers', () => expect(usdcAtomic('1')).toBe(1000000n))
  it('converts fractional amounts', () => expect(usdcAtomic('0.08')).toBe(80000n))
  it('rejects invalid formats', () => {
    expect(() => usdcAtomic('')).toThrow()
    expect(() => usdcAtomic('abc')).toThrow()
    expect(() => usdcAtomic('1.2.3')).toThrow()
  })
})

describe('safeDisplayUrl', () => {
  it('strips query and hash', () => {
    expect(safeDisplayUrl('https://example.com/path?q=1#hash')).toContain('example.com')
    expect(safeDisplayUrl('https://example.com/path?q=1#hash')).not.toContain('?q=1')
  })
  it('strips credentials', () => {
    expect(safeDisplayUrl('https://user:pass@example.com')).not.toContain('user')
  })
})

describe('runReleaseCheck — validation', () => {
  it('rejects manifest with too many pages (>5)', async () => {
    const pages = [
      'https://a.com',
      'https://b.com',
      'https://c.com',
      'https://d.com',
      'https://e.com',
      'https://f.com',
    ]
    await expect(
      runReleaseCheck({ runId: 'r1', pages, maxBudgetUsdc: '1' }, { validateTarget: noValidation }),
    ).rejects.toThrow()
  })

  it('rejects manifest with duplicate pages', async () => {
    await expect(
      runReleaseCheck(
        { runId: 'r1', pages: ['https://a.com', 'https://a.com'], maxBudgetUsdc: '1' },
        { validateTarget: noValidation },
      ),
    ).rejects.toThrow()
  })

  it('rejects invalid runId characters', async () => {
    await expect(
      runReleaseCheck(
        { runId: 'bad/runid', pages: ['https://a.com'], maxBudgetUsdc: '1' },
        { validateTarget: noValidation },
      ),
    ).rejects.toThrow()
  })

  it('rejects unsupported service origin', async () => {
    await expect(
      runReleaseCheck(makeManifest(), {
        serviceUrl: 'https://evil.example.com',
        validateTarget: noValidation,
      }),
    ).rejects.toThrow('Unsupported service origin')
  })

  it('rejects private/loopback targets without test-mode service override', async () => {
    const validate = async (_url: string) => ({ valid: false as const, reason: 'private_address' })
    await expect(
      runReleaseCheck(makeManifest({ pages: ['https://192.168.1.1'] }), {
        validateTarget: validate,
      }),
    ).rejects.toThrow()
  })

  it('rejects paid execute without a checkpoint', async () => {
    await expect(
      runReleaseCheck(makeManifest(), {
        execute: true,
        testMode: true,
        serviceUrl: 'http://127.0.0.1:3000',
        validateTarget: noValidation,
      }),
    ).rejects.toThrow('checkpoint')
  })

  it('rejects paid execute in production without adapter', async () => {
    const cp = makeCheckpoint()
    await expect(
      runReleaseCheck(makeManifest(), {
        execute: true,
        checkpoint: cp,
        validateTarget: noValidation,
      }),
    ).rejects.toThrow('adapter')
  })
})

describe('runReleaseCheck — preflight dry-run', () => {
  it('returns dryRun result without calling adapter when execute=false', async () => {
    const endpoint = 'http://127.0.0.1:3000/v1/checks'
    const fetch = vi.fn().mockResolvedValue(challengeResponse(endpoint))
    const result = await runReleaseCheck(makeManifest({ pages: ['https://example.com'] }), {
      serviceUrl: 'http://127.0.0.1:3000',
      testMode: true,
      fetchFn: fetch,
      validateTarget: noValidation,
    })
    expect(result.dryRun).toBe(true)
    expect(result.decision).toBe('INCONCLUSIVE')
    expect(fetch).toHaveBeenCalled()
    expect(result.markdown).toContain('No payment adapter invoked')
  })

  it('quote cap aborts before any adapter when budget is exceeded', async () => {
    const endpoint = 'http://127.0.0.1:3000/v1/checks'
    const fetch = vi.fn().mockResolvedValue(challengeResponse(endpoint, '80000'))
    const adapterCalled = vi.fn()
    const cp = makeCheckpoint()
    await expect(
      runReleaseCheck(
        makeManifest({ pages: ['https://a.com', 'https://b.com'], maxBudgetUsdc: '0.00001' }),
        {
          serviceUrl: 'http://127.0.0.1:3000',
          testMode: true,
          execute: true,
          fetchFn: fetch,
          checkpoint: cp,
          validateTarget: noValidation,
          adapter: adapterCalled,
        },
      ),
    ).rejects.toThrow('budget')
    expect(adapterCalled).not.toHaveBeenCalled()
  })
})

describe('runReleaseCheck — 5-page local mocked run', () => {
  it('completes a full 5-page check with mocked fetch and reports PASS', async () => {
    const pages = [
      'https://a.com',
      'https://b.com',
      'https://c.com',
      'https://d.com',
      'https://e.com',
    ]
    const endpoint = 'http://127.0.0.1:3000/v1/checks'
    const jobIds = pages.map((_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`)
    let fetchCall = 0
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url === endpoint) {
        const i = fetchCall++ % pages.length
        return Promise.resolve(jsonResponse({ id: jobIds[i], idempotent: true }, 202))
      }
      const match = jobIds.findIndex((id) => url === `http://127.0.0.1:3000/v1/checks/${id}`)
      if (match >= 0)
        return Promise.resolve(jsonResponse(terminalReport(jobIds[match]!, pages[match]!)))
      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    })
    const cp = makeCheckpoint()
    const result = await runReleaseCheck(
      { runId: 'five-page-run', pages, maxBudgetUsdc: '5' },
      {
        serviceUrl: 'http://127.0.0.1:3000',
        testMode: true,
        execute: true,
        fetchFn: fetch,
        checkpoint: cp,
        validateTarget: noValidation,
        sleep: async () => {},
      },
    )
    expect(result.dryRun).toBe(false)
    expect(result.decision).toBe('PASS')
    expect((result.pages as unknown[]).length).toBe(5)
    expect(result.markdown).toContain('PASS')
    expect(result.markdown).not.toContain('https://a.com?')
  })
})

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
