import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import type { PaymentMode, SecurityFinding, SecurityReport } from './types.js'
import { safePublicUrl, type BoundedHtml } from './web-products.js'

// web_release_gate product: passive release-security findings from one fetched page.
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
    contentHash: createHash('sha256').update(fetched.html).digest('hex'),
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
