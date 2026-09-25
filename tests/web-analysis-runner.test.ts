import { describe, expect, it } from 'vitest'
import { runBoundedWebAnalysis } from '../src/web-analysis-runner.js'

const nestedHtml = `${'<blockquote>'.repeat(30_000)}payload${'</blockquote>'.repeat(30_000)}`
const fetched = {
  finalUrl: 'https://example.com/',
  html: nestedHtml,
  inputBytes: Buffer.byteLength(nestedHtml),
  contentType: 'text/html',
  redirects: 0,
  headers: new Headers({ 'content-type': 'text/html' }),
  fetchedAt: '2026-09-25T00:00:00.000Z',
}

describe('isolated parser budget', () => {
  it('preserves a pre-existing outer job abort', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runBoundedWebAnalysis(
        {
          kind: 'extract',
          id: 'pre-aborted',
          createdAt: 0,
          expiresAt: 1000,
          paymentMode: 'test',
          fetched,
          maxOutputTokens: 500,
        },
        1000,
        controller.signal,
      ),
    ).rejects.toThrow('job_aborted')
  })

  it('reports an exhausted parser budget separately', async () => {
    await expect(
      runBoundedWebAnalysis(
        {
          kind: 'extract',
          id: 'no-budget',
          createdAt: 0,
          expiresAt: 1000,
          paymentMode: 'test',
          fetched,
          maxOutputTokens: 500,
        },
        0,
        new AbortController().signal,
      ),
    ).rejects.toThrow('parser_timeout')
  })

  for (const kind of ['extract', 'security'] as const) {
    it(`terminates adversarial nested markup for ${kind}`, async () => {
      await expect(
        runBoundedWebAnalysis(
          {
            kind,
            id: `nested-${kind}`,
            createdAt: 0,
            expiresAt: 1000,
            paymentMode: 'test',
            fetched,
            maxOutputTokens: 500,
          },
          5,
          new AbortController().signal,
        ),
      ).rejects.toThrow('parser_timeout')
    })
  }
})
