import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import TurndownService from 'turndown'
import type { ExtractReport, PaymentMode } from './types.js'
import type { BoundedHtml } from './web-products.js'

// extract_page product: fetched HTML to deterministic Markdown.
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
    contentHash: createHash('sha256').update(parsed.markdown).digest('hex'),
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
