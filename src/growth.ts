import { AsyncLocalStorage } from 'node:async_hooks'
import type { RequestHandler, ErrorRequestHandler } from 'express'
import type { JobStore } from './db.js'
import type { PaymentMode } from './types.js'

export const GROWTH_SOURCES = [
  'unknown',
  'github-action',
  'agent-client',
  'mcp',
  'registry',
  'report-share',
  'monitor',
  'test-client',
] as const
export const GROWTH_PRODUCTS = [
  'check',
  'verify',
  'compare',
  'extract',
  'security',
  'discovery',
] as const
export const GROWTH_EVENTS = [
  'document_request',
  'unpaid_challenge',
  'payment_header_attempt',
  'input_rejected_after_parser',
  'payment_rejected_response',
  'service_unavailable_response',
  'payment_accepted_response',
  'job_created',
  'accepted_paid_job',
  'job_complete',
  'job_failed',
  'payment_pending_failed',
  'parser_rejected_response',
] as const
export type GrowthSource = (typeof GROWTH_SOURCES)[number]
export type GrowthProduct = (typeof GROWTH_PRODUCTS)[number]
export type GrowthEvent = (typeof GROWTH_EVENTS)[number]
export const growthContext = new AsyncLocalStorage<{ source: GrowthSource; mode: PaymentMode }>()

export function growthSource(value: unknown): GrowthSource {
  return typeof value === 'string' && GROWTH_SOURCES.includes(value as GrowthSource)
    ? (value as GrowthSource)
    : 'unknown'
}

const productPaths: Record<string, GrowthProduct> = {
  '/v1/checks': 'check',
  '/v1/verify': 'verify',
  '/v1/compare': 'compare',
  '/v1/extract': 'extract',
  '/v1/security-gate': 'security',
}
const documentPaths = new Set([
  '/',
  '/agents',
  '/openapi.json',
  '/skill.md',
  '/llms.txt',
  '/.well-known/x402',
  '/.well-known/mcp.json',
])

export function growthMiddleware(store: JobStore, mode: PaymentMode): RequestHandler {
  return (req, res, next) => {
    // Registered before express.json(); its error observer marks only normalized parser categories.
    const source = growthSource(req.headers['x-viewportwitness-source'])
    // Labels (including monitor/test-client) are caller-declared, never verified attribution.
    // Only allowlisted categories survive. Raw headers, bodies, URLs and IPs are never retained.
    const product = req.method === 'POST' ? productPaths[req.path] : undefined
    const document = req.method === 'GET' && documentPaths.has(req.path)
    const paymentHeader = req.headers['payment-signature'] ?? req.headers['x-payment']
    const hasPaymentHeader = typeof paymentHeader === 'string' && paymentHeader.length > 0
    // Presence is an attempt, not proof of a valid signature, buyer or settled payment.
    if (product && hasPaymentHeader) {
      try {
        store.recordGrowth(product, source, 'payment_header_attempt', mode)
      } catch {
        /* Observer failure must not affect payment or request processing. */
      }
    }
    res.once('finish', () => {
      try {
        if (document && res.statusCode === 200)
          store.recordGrowth('discovery', source, 'document_request', mode)
        if (product && res.statusCode === 402)
          store.recordGrowth(product, source, 'unpaid_challenge', mode)
        if (product && [400, 422].includes(res.statusCode))
          store.recordGrowth(product, source, 'input_rejected_after_parser', mode)
        if (product && res.locals['growthParserRejected'] === true)
          store.recordGrowth(product, source, 'parser_rejected_response', mode)
        if (product && hasPaymentHeader && res.statusCode === 402)
          store.recordGrowth(product, source, 'payment_rejected_response', mode)
        if (product && res.statusCode === 503)
          store.recordGrowth(product, source, 'service_unavailable_response', mode)
        if (product && mode !== 'test' && req.paymentResult?.settled === true && req.paymentResult.mode === mode)
          store.recordGrowth(product, source, 'payment_accepted_response', mode)
      } catch {
        /* Observer failure cannot interrupt a delivered response. */
      }
    })
    growthContext.run(
      { source: source === 'unknown' && req.path === '/mcp' ? 'mcp' : source, mode },
      next,
    )
  }
}

export function growthErrorObserver(): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    // Do not retain error messages, stacks, rejected bodies or headers.
    if (error && typeof error === 'object' && 'type' in error
      && ['entity.parse.failed', 'entity.too.large', 'request.aborted', 'request.size.invalid'].includes(String(error.type))) {
      res.locals['growthParserRejected'] = true
    }
    next(error)
  }
}
