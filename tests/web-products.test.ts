import { describe, expect, it, vi } from 'vitest'
import {
  buildExtractReport,
  buildSecurityReport,
  createPinnedLookup,
  fetchBoundedHtml,
  htmlToMarkdown,
  type PinnedRequester,
  type PublicResolver,
} from '../src/web-products.js'

const publicResolver: PublicResolver = vi.fn(async (hostname: string) =>
  hostname.includes('blocked')
    ? { safe: false, reason: 'blocked_ipv4_range:127.0.0.0/8', addresses: [] }
    : { safe: true, addresses: [{ address: '93.184.216.34', family: 4 }] },
)

function requester(status: number, body: string, headers: Record<string, string>): PinnedRequester {
  return vi.fn(async (url) => ({
    status,
    url: url.toString(),
    headers: new Headers(headers),
    body: Buffer.from(body),
  }))
}

describe('deterministic extraction', () => {
  it('selects main content, removes active chrome, and reduces tokens', () => {
    const html = `<html><nav>Huge navigation text</nav><main><h1>Agent Guide</h1><p>Useful content &amp; details.</p><script>alert(1)</script></main><footer>Legal links</footer></html>`
    const result = htmlToMarkdown(html, 500)
    expect(result.markdown).toContain('# Agent Guide')
    expect(result.markdown).toContain('Useful content & details.')
    expect(result.markdown).not.toContain('Huge navigation')
    expect(result.markdown.length).toBeLessThan(html.length)
  })

  it('enforces the requested output budget', () => {
    const result = htmlToMarkdown(`<main><p>${'word '.repeat(2000)}</p></main>`, 500)
    expect(result.markdown.length).toBeLessThanOrEqual(2045)
    expect(result.warnings).toContain('Output was truncated to the requested token budget.')
  })

  it('handles malformed nested HTML without leaking navigation or scripts', () => {
    const result = htmlToMarkdown(
      '<nav>skip</nav><main><h2>Nested<p>Useful <strong>answer<script>bad()</main>',
      500,
    )
    expect(result.markdown).not.toContain('bad()')
    expect(result.markdown).not.toContain('skip')
    expect(result.markdown).toContain('## Nested')
    expect(result.markdown).toContain('**answer**')
  })
})

describe('bounded HTML fetch', () => {
  it('validates every manual redirect and blocks an unsafe destination', async () => {
    const request = requester(302, '', { location: 'https://blocked.invalid/private' })
    await expect(
      fetchBoundedHtml('https://public.example.com/page', undefined, {
        resolver: publicResolver,
        requester: request,
      }),
    ).rejects.toThrow('blocked_destination')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects non-HTML and oversized declared responses', async () => {
    await expect(
      fetchBoundedHtml('https://public.example.com/page', undefined, {
        resolver: publicResolver,
        requester: requester(200, 'x', { 'content-type': 'application/json' }),
      }),
    ).rejects.toThrow('unsupported_content_type')
    await expect(
      fetchBoundedHtml('https://public.example.com/page', undefined, {
        resolver: publicResolver,
        requester: requester(200, 'x', {
          'content-type': 'text/html',
          'content-length': String(1024 * 1024 + 1),
        }),
      }),
    ).rejects.toThrow('response_too_large')
  })

  it('redacts query values from returned provenance URLs', async () => {
    const fetched = await fetchBoundedHtml(
      'https://public.example.com/page?token=secret',
      undefined,
      {
        resolver: publicResolver,
        requester: requester(200, '<main>ok</main>', { 'content-type': 'text/html' }),
      },
    )
    expect(fetched.finalUrl).not.toContain('secret')
    expect(fetched.finalUrl).toContain('token=%5Bredacted%5D')
  })

  it('pins the request to the validated address even if later DNS could rebind privately', async () => {
    const resolver: PublicResolver = vi.fn(async () => ({
      safe: true,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    }))
    const seen: string[] = []
    const request: PinnedRequester = vi.fn(async (url, pinned) => {
      seen.push(pinned.address)
      return {
        status: 200,
        url: url.toString(),
        headers: new Headers({ 'content-type': 'text/html' }),
        body: Buffer.from('<main>safe</main>'),
      }
    })
    await fetchBoundedHtml('https://rebind.example.net', undefined, {
      resolver,
      requester: request,
    })
    expect(seen).toEqual(['93.184.216.34'])
    expect(seen).not.toContain('127.0.0.1')
    expect(resolver).toHaveBeenCalledTimes(1)
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 })
    await new Promise<void>((resolve, reject) => {
      lookup('rebind.example.net', { family: 0, hints: 0, all: false }, (error, address) => {
        if (error) reject(error)
        else {
          expect(address).toBe('93.184.216.34')
          expect(address).not.toBe('127.0.0.1')
          resolve()
        }
      })
    })
  })

  it('preserves an outer job abort instead of reporting a fetch timeout', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchBoundedHtml('https://public.example.com/page', controller.signal, {
        resolver: publicResolver,
        requester: requester(200, '<main>unused</main>', { 'content-type': 'text/html' }),
      }),
    ).rejects.toThrow('job_aborted')
  })
})

describe('reports', () => {
  const base = {
    finalUrl: 'https://example.com/',
    html: '<main><h1>Hello</h1></main>',
    inputBytes: 34,
    contentType: 'text/html',
    redirects: 0,
    headers: new Headers(),
    fetchedAt: '2026-09-25T00:00:00.000Z',
  }
  it('returns hashes and provenance for extraction', () => {
    const report = buildExtractReport('id', 0, 1000, 'test', base, 500)
    expect(report.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(report.provenance.parser).toBe('viewport-witness-deterministic-v1')
  })
  it('fails passive security when high-severity controls are absent', () => {
    const report = buildSecurityReport('id', 0, 1000, 'test', {
      ...base,
      html: '<form action="http://example.com/login"></form><script src="https://cdn.example.net/a.js"></script>',
    })
    expect(report.status).toBe('FAIL')
    expect(report.findings.map((item) => item.code)).toContain('mixed_content')
    expect(report.findings.map((item) => item.code)).toContain('cross_origin_script_without_sri')
  })

  it('finds risky form behavior and bounds the returned findings', () => {
    const forms = Array.from({ length: 40 }, () => '<form><input type="password"></form>').join('')
    const report = buildSecurityReport('id', 0, 1000, 'test', { ...base, html: forms })
    expect(report.findings.map((item) => item.code)).toContain('form_action_implicit')
    expect(report.findings.map((item) => item.code)).toContain('password_form_uses_get')
    expect(report.findings.length).toBeLessThanOrEqual(30)
  })
})
