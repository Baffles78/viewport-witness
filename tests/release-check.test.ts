import { describe, it, expect, vi } from 'vitest'
import { runReleaseCheck, usdcAtomic, safeDisplayUrl } from '../src/release-check.js'
import { makeManifest, jsonResponse, challengeResponse, terminalReport, makeCheckpoint, noValidation } from './helpers/release-check-fixtures.js'

// --- helpers ----------------------------------------------------------------

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

describe('real asynchronous report lifecycle', () => {
  it('keeps polling queued/running responses without a target URL, then validates the terminal target', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id, status: 'queued' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id, status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id, status: 'running' }))
      .mockResolvedValueOnce(jsonResponse(terminalReport(id, 'https://example.com')))
    const result = await runReleaseCheck(makeManifest(), {
      serviceUrl: 'http://127.0.0.1:3000',
      testMode: true,
      execute: true,
      fetchFn,
      checkpoint: makeCheckpoint(),
      validateTarget: noValidation,
      pollAttempts: 3,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(result.decision).toBe('PASS')
    expect(fetchFn).toHaveBeenCalledTimes(4)
  })
})

describe('same-job recovery conformance', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const options = (fetchFn: typeof fetch, checkpoint = makeCheckpoint()) => ({
    serviceUrl: 'http://127.0.0.1:3000',
    testMode: true,
    execute: true,
    fetchFn,
    checkpoint,
    validateTarget: noValidation,
    pollAttempts: 3,
    pollIntervalMs: 0,
    sleep: async () => {},
  })

  it('continues the same ID through retryable and running to a report', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id, status: 'queued' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id, status: 'retryable', nextAction: 'poll_same_job' }))
      .mockResolvedValueOnce(jsonResponse({ id, status: 'running', nextAction: 'poll_same_job' }))
      .mockResolvedValueOnce(jsonResponse(terminalReport(id, 'https://example.com')))
    const result = await runReleaseCheck(makeManifest(), options(fetchFn))
    expect(result.decision).toBe('PASS')
    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/v1/checks'))).toHaveLength(1)
  })

  it('stops at a permanent job failure without resubmitting', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id, status: 'queued' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id, status: 'failed', nextAction: 'stop' }))
    const result = await runReleaseCheck(makeManifest(), options(fetchFn))
    expect(result.decision).toBe('INCONCLUSIVE')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('treats an expired completed report as inconclusive', async () => {
    const expired = {
      ...terminalReport(id, 'https://example.com'),
      expiresAt: '2000-01-01T00:00:00.000Z',
      jobStatus: 'complete',
      nextAction: 'inspect_report',
    }
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id, status: 'queued' }, 202))
      .mockResolvedValueOnce(jsonResponse(expired))
    const result = await runReleaseCheck(makeManifest(), options(fetchFn))
    expect(result.decision).toBe('INCONCLUSIVE')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('keeps the accepted ID after an interrupted poll and resumes without another POST', async () => {
    const checkpoint = makeCheckpoint()
    const firstFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id, status: 'queued' }, 202))
      .mockRejectedValueOnce(new Error('network interrupted'))
    const first = await runReleaseCheck(makeManifest(), options(firstFetch, checkpoint))
    expect(first.decision).toBe('INCONCLUSIVE')
    expect(checkpoint.get()?.pages[0]?.jobId).toBe(id)

    const secondFetch = vi.fn().mockResolvedValue(jsonResponse(terminalReport(id, 'https://example.com')))
    const second = await runReleaseCheck(makeManifest(), options(secondFetch, checkpoint))
    expect(second.decision).toBe('PASS')
    expect(secondFetch).toHaveBeenCalledTimes(1)
    expect(String(secondFetch.mock.calls[0]?.[0])).toContain('/v1/checks/' + id)
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
