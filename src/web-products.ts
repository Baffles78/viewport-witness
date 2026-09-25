import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import TurndownService from 'turndown'
import { validatePublicHttpsUrl } from './ssrf.js'
import type { ExtractReport, PaymentMode, SecurityFinding, SecurityReport } from './types.js'

const BYTE_LIMIT = 1024 * 1024
const REDIRECT_LIMIT = 5
const FETCH_TIMEOUT_MS = 8_000
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

export interface BoundedHtml {
  finalUrl: string
  html: string
  inputBytes: number
  contentType: string
  redirects: number
  headers: Headers
  fetchedAt: string
}

function safePublicUrl(raw: string): string {
  const parsed = new URL(raw)
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, '[redacted]')
  return parsed.toString()
}

export async function fetchBoundedHtml(
  rawUrl: string,
  outerSignal?: AbortSignal,
): Promise<BoundedHtml> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  outerSignal?.addEventListener('abort', abort, { once: true })
  let timeout: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new Error('fetch_timeout'))
    }, FETCH_TIMEOUT_MS)
  })
  const work = (async (): Promise<BoundedHtml> => {
    let current = rawUrl
    let redirects = 0
    while (true) {
      if (controller.signal.aborted) throw new Error('fetch_timeout')
      const validation = await validatePublicHttpsUrl(current)
      if (controller.signal.aborted) throw new Error('fetch_timeout')
      if (!validation.valid)
        throw new Error(`blocked_destination:${validation.reason ?? 'unknown'}`)
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9' },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error('redirect_without_location')
        if (redirects >= REDIRECT_LIMIT) throw new Error('redirect_limit_exceeded')
        await response.body?.cancel()
        current = new URL(location, current).toString()
        redirects += 1
        continue
      }
      if (!response.ok) throw new Error(`upstream_http_${response.status}`)
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase()
      if (!contentType || !HTML_TYPES.has(contentType)) throw new Error('unsupported_content_type')
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > BYTE_LIMIT) throw new Error('response_too_large')
      if (!response.body) throw new Error('empty_response')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > BYTE_LIMIT) {
          await reader.cancel()
          throw new Error('response_too_large')
        }
        chunks.push(part.value)
      }
      const body = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        bytes,
      )
      return {
        finalUrl: safePublicUrl(response.url || current),
        html: new TextDecoder('utf-8', { fatal: false }).decode(body),
        inputBytes: bytes,
        contentType,
        redirects,
        headers: response.headers,
        fetchedAt: new Date().toISOString(),
      }
    }
  })()
  try {
    return await Promise.race([work, deadline])
  } catch (error) {
    if (controller.signal.aborted) throw new Error('fetch_timeout')
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    outerSignal?.removeEventListener('abort', abort)
  }
}

export function htmlToMarkdown(
  html: string,
  maxOutputTokens: number,
): { markdown: string; warnings: string[] } {
  const warnings: string[] = []
  const $ = load(html)
  $('script, style, noscript, svg, canvas, template, nav, footer, aside').remove()
  const selected = $('main').first().length
    ? $('main').first()
    : $('article').first().length
      ? $('article').first()
      : $('body').first()
  if (!$('main').first().length && !$('article').first().length) {
    warnings.push('No main or article element was found; the document body was used.')
  }
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  })
  turndown.remove(['button', 'input', 'select', 'textarea'])
  let markdown = turndown
    .turndown(selected.html() ?? '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const maxChars = maxOutputTokens * 4
  if (markdown.length > maxChars) {
    markdown = `${markdown.slice(0, maxChars).trimEnd()}\n\n[Output truncated by maxOutputTokens]`
    warnings.push('Output was truncated to the requested token budget.')
  }
  return { markdown, warnings }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildExtractReport(
  id: string,
  createdAt: number,
  expiresAt: number,
  paymentMode: PaymentMode,
  fetched: BoundedHtml,
  maxOutputTokens: number,
): ExtractReport {
  const parsed = htmlToMarkdown(fetched.html, maxOutputTokens)
  return {
    id,
    kind: 'extract',
    status: 'PASS',
    paymentMode,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    sourceUrl: fetched.finalUrl,
    markdown: parsed.markdown,
    contentHash: hash(parsed.markdown),
    inputBytes: fetched.inputBytes,
    outputBytes: Buffer.byteLength(parsed.markdown),
    estimatedInputTokens: Math.ceil(fetched.html.length / 4),
    estimatedOutputTokens: Math.ceil(parsed.markdown.length / 4),
    warnings: parsed.warnings,
    provenance: {
      fetchedAt: fetched.fetchedAt,
      redirects: fetched.redirects,
      contentType: fetched.contentType,
      parser: 'viewport-witness-deterministic-v1',
    },
  }
}

function finding(
  code: string,
  severity: SecurityFinding['severity'],
  evidence: string,
  remediation: string,
): SecurityFinding {
  return { code, severity, evidence: evidence.slice(0, 300), remediation }
}

export function buildSecurityReport(
  id: string,
  createdAt: number,
  expiresAt: number,
  paymentMode: PaymentMode,
  fetched: BoundedHtml,
): SecurityReport {
  const findings: SecurityFinding[] = []
  const h = fetched.headers
  if (!h.get('content-security-policy'))
    findings.push(
      finding(
        'missing_csp',
        'high',
        'Content-Security-Policy header is absent.',
        'Add a restrictive Content-Security-Policy header.',
      ),
    )
  if (!h.get('strict-transport-security'))
    findings.push(
      finding(
        'missing_hsts',
        'medium',
        'Strict-Transport-Security header is absent.',
        'Add HSTS after confirming all traffic is HTTPS.',
      ),
    )
  if (!h.get('x-content-type-options'))
    findings.push(
      finding(
        'missing_nosniff',
        'medium',
        'X-Content-Type-Options header is absent.',
        'Set X-Content-Type-Options: nosniff.',
      ),
    )
  if (!h.get('referrer-policy'))
    findings.push(
      finding(
        'missing_referrer_policy',
        'low',
        'Referrer-Policy header is absent.',
        'Set a privacy-preserving Referrer-Policy.',
      ),
    )
  const server = h.get('server')
  if (server && /\d/.test(server))
    findings.push(
      finding(
        'server_version_disclosure',
        'low',
        `Server header exposes a version-like value: ${server}`,
        'Remove product version details from the Server header.',
      ),
    )
  const cookies =
    typeof h.getSetCookie === 'function'
      ? h.getSetCookie()
      : h.get('set-cookie')
        ? [h.get('set-cookie') as string]
        : []
  for (const cookie of cookies.slice(0, 10)) {
    if (!/;\s*secure(?:;|$)/i.test(cookie))
      findings.push(
        finding(
          'cookie_missing_secure',
          'high',
          'A Set-Cookie header lacks Secure.',
          'Add the Secure flag to cookies.',
        ),
      )
    if (!/;\s*httponly(?:;|$)/i.test(cookie))
      findings.push(
        finding(
          'cookie_missing_httponly',
          'medium',
          'A Set-Cookie header lacks HttpOnly.',
          'Add HttpOnly unless browser scripts must read the cookie.',
        ),
      )
    if (!/;\s*samesite=/i.test(cookie))
      findings.push(
        finding(
          'cookie_missing_samesite',
          'medium',
          'A Set-Cookie header lacks SameSite.',
          'Set an appropriate SameSite policy.',
        ),
      )
  }
  const mixed = [
    ...fetched.html.matchAll(/(?:src|href|action)\s*=\s*["'](http:\/\/[^"']+)/gi),
  ].slice(0, 10)
  for (const match of mixed) {
    let evidence = 'an insecure HTTP URL'
    try {
      evidence = safePublicUrl(match[1] as string)
    } catch {
      // Keep malformed evidence generic.
    }
    findings.push(
      finding(
        'mixed_content',
        'high',
        `HTTPS page references insecure URL: ${evidence}`,
        'Use HTTPS for this resource or form target.',
      ),
    )
  }
  const origin = new URL(fetched.finalUrl).origin
  const document = load(fetched.html)
  document('form')
    .slice(0, 20)
    .each((_index, element) => {
      const form = document(element)
      const action = form.attr('action')?.trim()
      const method = (form.attr('method') ?? 'get').toLowerCase()
      const hasPassword = form.find('input[type="password"]').length > 0
      if (!action) {
        findings.push(
          finding(
            'form_action_implicit',
            'low',
            'A form has no explicit action and submits to the current page.',
            'Set an explicit HTTPS action so the submission destination is reviewable.',
          ),
        )
      } else {
        try {
          const actionUrl = new URL(action, fetched.finalUrl)
          if (actionUrl.protocol !== 'https:') {
            findings.push(
              finding(
                'form_insecure_action',
                'high',
                `A form submits using ${actionUrl.protocol}`,
                'Submit forms only to an HTTPS endpoint.',
              ),
            )
          }
        } catch {
          findings.push(
            finding(
              'form_action_invalid',
              'medium',
              'A form action is not a valid URL reference.',
              'Use a valid relative path or HTTPS URL for the form action.',
            ),
          )
        }
      }
      if (hasPassword && method === 'get') {
        findings.push(
          finding(
            'password_form_uses_get',
            'high',
            'A password field is submitted with GET, which can expose it in URLs and logs.',
            'Use POST for forms containing passwords and avoid logging sensitive form bodies.',
          ),
        )
      }
    })
  for (const match of [
    ...fetched.html.matchAll(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>/gi),
  ].slice(0, 20)) {
    const attrs = `${match[1] ?? ''} ${match[3] ?? ''}`
    try {
      const scriptUrl = new URL(match[2] as string, fetched.finalUrl)
      if (scriptUrl.origin !== origin && !/\bintegrity\s*=/i.test(attrs))
        findings.push(
          finding(
            'cross_origin_script_without_sri',
            'medium',
            `Cross-origin script lacks integrity metadata: ${scriptUrl.origin}`,
            'Add a valid integrity attribute and crossorigin policy, or serve the script locally.',
          ),
        )
    } catch {
      /* malformed URLs are ignored by this passive check */
    }
  }
  const unique = [
    ...new Map(findings.map((item) => [`${item.code}:${item.evidence}`, item])).values(),
  ].slice(0, 30)
  const status = unique.some((item) => item.severity === 'high')
    ? 'FAIL'
    : unique.length
      ? 'INCONCLUSIVE'
      : 'PASS'
  return {
    id,
    kind: 'security',
    status,
    paymentMode,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    sourceUrl: fetched.finalUrl,
    contentHash: hash(fetched.html),
    findings: unique,
    checksPerformed: [
      'security-headers',
      'cookie-flags',
      'mixed-content',
      'cross-origin-script-sri',
      'server-header-disclosure',
    ],
    limitations: [
      'Passive single-response review only; no extra paths, forms, scripts, repositories, or code are executed.',
    ],
    provenance: {
      fetchedAt: fetched.fetchedAt,
      redirects: fetched.redirects,
      contentType: fetched.contentType,
    },
  }
}
