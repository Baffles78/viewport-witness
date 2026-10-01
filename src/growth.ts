import { AsyncLocalStorage } from 'node:async_hooks'
import type { RequestHandler } from 'express'
import type { JobStore } from './db.js'
import type { PaymentMode } from './types.js'

export const GROWTH_SOURCES = [
  'unknown',
  'github-action',
  'agent-client',
  'mcp',
  'registry',
  'report-share',
] as const
export const GROWTH_PRODUCTS = [
  'check',
  'verify',
  'compare',
  'extract',
  'security',
  'discovery',
] as const
export const GROWTH_EVENTS = ['document_request', 'unpaid_challenge'] as const
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
    const source = growthSource(req.headers['x-viewportwitness-source'])
    // Only allowlisted labels survive. Headers, referrers, bodies and IPs are never retained.
    const product = req.method === 'POST' ? productPaths[req.path] : undefined
    const document = req.method === 'GET' && documentPaths.has(req.path)
    res.once('finish', () => {
      try {
        if (document && res.statusCode === 200)
          store.recordGrowth('discovery', source, 'document_request', mode)
        if (product && res.statusCode === 402)
          store.recordGrowth(product, source, 'unpaid_challenge', mode)
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
