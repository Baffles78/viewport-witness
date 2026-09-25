import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildExtractReport,
  buildSecurityReport,
  fetchBoundedHtml,
  htmlToMarkdown,
} from '../src/web-products.js'

vi.mock('../src/ssrf.js', () => ({
  validatePublicHttpsUrl: vi.fn(async (url: string) => ({ valid: !url.includes('blocked') })),
}))

afterEach(() => vi.unstubAllGlobals())

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
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://blocked.invalid/private' },
          }),
      ),
    )
    await expect(fetchBoundedHtml('https://public.example/page')).rejects.toThrow(
      'blocked_destination',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects non-HTML and oversized declared responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('x', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    )
    await expect(fetchBoundedHtml('https://public.example/page')).rejects.toThrow(
      'unsupported_content_type',
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('x', {
            status: 200,
            headers: { 'content-type': 'text/html', 'content-length': String(1024 * 1024 + 1) },
          }),
      ),
    )
    await expect(fetchBoundedHtml('https://public.example/page')).rejects.toThrow(
      'response_too_large',
    )
  })

  it('redacts query values from returned provenance URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<main>ok</main>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    )
    const fetched = await fetchBoundedHtml('https://public.example/page?token=secret')
    expect(fetched.finalUrl).not.toContain('secret')
    expect(fetched.finalUrl).toContain('token=%5Bredacted%5D')
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
