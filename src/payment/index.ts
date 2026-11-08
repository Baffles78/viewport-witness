/**
 * x402 payment adapter.
 *
 * Test mode deliberately bypasses payment and never claims settlement. Paid
 * modes use the official x402 v2 packages and request the `upfront` flow on
 * each enabled rail, so payment settles before the job handler may enqueue work.
 *
 * Testnet and production use Coinbase CDP API key authentication. The official
 * CDP SDK binds a short-lived JWT to each facilitator endpoint. Credentials are
 * never logged and the receiver wallet needs no signing key on this server.
 */

import { createHash, createHmac } from 'node:crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402'
import { paymentMiddleware } from '@x402/express'
import { x402ResourceServer } from '@x402/core/server'
import type { PaymentOption } from '@x402/core/http'
import type { Network } from '@x402/core/types'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { ExactSvmScheme } from '@x402/svm/exact/server'
import {
  decodeTransactionFromPayload,
  getTokenPayerFromTransaction,
  validateSvmAddress,
} from '@x402/svm'
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar'
import { randomUUID } from 'node:crypto'
import {
  decodePaymentHeader,
  legacyHeaderPaymentId,
  legacyMcpPaymentId,
  paymentIdentity,
} from './identity.js'
import type { JobRecord, PaymentMode } from '../types.js'
import type { JobStore } from '../db.js'
import { sameJobIntent, type JobIntent } from '../idempotency-replay.js'
import { reconcileJobStatus } from '../job-reconciliation.js'
import {
  admissionStorage,
  finalizeAdmission,
  installAdmissionHooks,
  PAYER_BUSY_DETAIL,
  unresolvedPaymentBody,
  type AdmissionContext,
} from './admission.js'

export interface PaymentResult {
  settled: boolean
  paymentId?: string
  customerId?: string
  mode: PaymentMode
  /** Durable job admitted before settlement and queued after it settled. */
  admittedJobId?: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      paymentResult?: PaymentResult
      /** Validated work, set by the route before the paid middleware runs. */
      jobIntent?: JobIntent
    }
  }
}

export interface PaymentAdmissionOptions {
  store: JobStore
  unresolvedLimit: number
  /** Unresolved attempts one payer may hold; omitted means no per-payer cap. */
  payerUnresolvedLimit?: number
  retentionDays: number
}

export interface PaymentMiddlewareOptions {
  payTo: string
  solanaPayTo?: string | undefined
  enableSolana?: boolean | undefined
  priceUsdc: string
  mode: PaymentMode
  enableMainnet: boolean
  facilitatorUrl?: string | undefined
  cdpApiKeyId?: string | undefined
  cdpApiKeySecret?: string | undefined
  customerHashSecret?: string | undefined
  route?:
    | 'POST /v1/checks'
    | 'POST /v1/verify'
    | 'POST /v1/compare'
    | 'POST /v1/extract'
    | 'POST /v1/security-gate'
    | 'POST /v1/history'
  description?: string
  /** Durable verify-then-admit-then-settle handling for job-creating routes. */
  admission?: PaymentAdmissionOptions | undefined
}

/** Marketplace descriptions for each paid route, shared by the app and tests. */
export const PAID_ROUTE_DESCRIPTIONS = {
  'POST /v1/checks':
    'Check a public website before deploy: test mobile website layout, accessibility, browser errors and screenshots across three viewports',
  'POST /v1/verify':
    'Verify text, elements and layout on a public website across phone and desktop sizes',
  'POST /v1/compare': 'Visual and QA comparison against a completed baseline job',
  'POST /v1/extract': 'DOM to Markdown: extract readable content from a public HTML webpage',
  'POST /v1/security-gate': 'Passive public web release security gate',
  'POST /v1/history':
    'Page history archive: past ViewportWitness screenshots and QA findings for one public URL',
} as const

export interface PaymentDiscovery {
  version: string
  paymentRequired: boolean
  price: string
  asset: string
  network: string
  payTo: string
  accepts: Array<{
    scheme: 'exact'
    network: string
    asset: 'USDC'
    payTo: string
  }>
  facilitatorUrl?: string
  testMode: boolean
  // Crawler-facing discovery fields (present when baseUrl is supplied)
  endpoint?: string
  method?: string
  description?: string
  skillMdUrl?: string
  openapiUrl?: string
  products?: Array<{ name: string; endpoint: string; price: string; description: string }>
}

function unavailable(error: string, detail: string): RequestHandler {
  return (_req: Request, res: Response): void => {
    res.status(503).json({ error, detail })
  }
}

// One id per signed payment, whatever its encoding or transport. A header
// that cannot be decoded keeps a raw hash so it can still be serialized; such
// a payment fails verification and is never stored.
export function paymentFingerprint(req: Request): string | undefined {
  const signature = req.header('payment-signature') ?? req.header('x-payment')
  if (!signature) return undefined
  return (
    paymentIdentity(decodePaymentHeader(signature)) ??
    `raw_${createHash('sha256').update(signature).digest('hex')}`
  )
}

// Ids the same payment may carry in rows written before ids were unified.
export function paymentFingerprintAliases(req: Request): string[] {
  const signature = req.header('payment-signature') ?? req.header('x-payment')
  if (!signature) return []
  return [legacyHeaderPaymentId(signature), legacyMcpPaymentId(decodePaymentHeader(signature))].filter(
    (id): id is string => Boolean(id),
  )
}

export function customerFingerprint(
  paymentHeader: string | undefined,
  secret: string | undefined,
): string | undefined {
  if (!paymentHeader || !secret || secret.length < 32 || paymentHeader.length > 64 * 1024) {
    return undefined
  }
  try {
    const envelope = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as {
      accepted?: { network?: unknown }
      payload?: {
        authorization?: { from?: unknown }
        permit2Authorization?: { from?: unknown }
        transaction?: unknown
      }
    }
    const hasAuthorization = envelope.payload?.authorization !== undefined
    const hasPermit2Authorization = envelope.payload?.permit2Authorization !== undefined
    const hasSolanaTransaction = envelope.payload?.transaction !== undefined
    const variantCount =
      Number(hasAuthorization) + Number(hasPermit2Authorization) + Number(hasSolanaTransaction)
    if (variantCount !== 1) {
      return undefined
    }

    let candidate: string
    if (hasSolanaTransaction) {
      if (
        typeof envelope.accepted?.network !== 'string' ||
        !envelope.accepted.network.startsWith('solana:') ||
        typeof envelope.payload?.transaction !== 'string'
      ) {
        return undefined
      }
      const transaction = decodeTransactionFromPayload({
        transaction: envelope.payload.transaction,
      })
      candidate = getTokenPayerFromTransaction(transaction)
      if (!validateSvmAddress(candidate)) {
        return undefined
      }
    } else {
      const evmCandidate = hasAuthorization
        ? envelope.payload?.authorization?.from
        : envelope.payload?.permit2Authorization?.from
      if (typeof evmCandidate !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(evmCandidate)) {
        return undefined
      }
      candidate = evmCandidate.toLowerCase()
    }
    return `cust_${createHmac('sha256', secret).update(candidate).digest('hex')}`
  } catch {
    return undefined
  }
}

// Bazaar discovery extension: describes the request/response schema for marketplace indexing.
// Request: strict {url:string} only. Response: the accepted 202 job object, not the eventual report.
export function createBazaarDiscovery(route: PaymentMiddlewareOptions['route']) {
  const input =
    route === 'POST /v1/verify'
      ? { url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }] }
      : route === 'POST /v1/compare'
        ? { url: 'https://example.com', baselineJobId: '550e8400-e29b-41d4-a716-446655440000' }
        : route === 'POST /v1/history'
          ? { url: 'https://example.com', limit: 5 }
          : { url: 'https://example.com' }
  const properties: Record<string, unknown> = {
    url: {
      type: 'string',
      format: 'uri',
      description: 'Public HTTPS URL to check',
      example: 'https://example.com',
    },
  }
  const required = ['url']
  if (route === 'POST /v1/verify') {
    properties['assertions'] = {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description: 'Pass/fail assertions',
      items: {
        type: 'object',
        description:
          'noHorizontalOverflow|noConsoleErrors|textVisible|titleIncludes|selectorExists|selectorVisible',
      },
    }
    required.push('assertions')
  }
  if (route === 'POST /v1/compare') {
    properties['baselineJobId'] = {
      type: 'string',
      format: 'uuid',
      description: 'Completed, unexpired ViewportWitness check job used as the visual baseline.',
    }
    required.push('baselineJobId')
  }
  if (route === 'POST /v1/extract') {
    properties['maxOutputTokens'] = {
      type: 'integer',
      minimum: 500,
      maximum: 12000,
      description: 'Optional approximate Markdown output budget.',
    }
  }
  if (route === 'POST /v1/history') {
    properties['limit'] = {
      type: 'integer',
      minimum: 1,
      description: 'Maximum archived snapshots to return, newest first.',
    }
    properties['before'] = {
      type: 'string',
      format: 'date-time',
      description: 'Only return snapshots captured before this time, for paging.',
    }
    return declareDiscoveryExtension({
      bodyType: 'json',
      input,
      inputSchema: { type: 'object', required, additionalProperties: false, properties },
      output: {
        example: {
          url: 'https://example.com/',
          snapshots: [
            {
              snapshotId: '550e8400-e29b-41d4-a716-446655440000',
              capturedAt: '2026-10-01T12:00:00.000Z',
              status: 'PASS',
              snapshotUrl: '/v1/history/snapshots/550e8400-e29b-41d4-a716-446655440000',
            },
          ],
          nextBefore: null,
        },
        schema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            snapshots: { type: 'array', items: { type: 'object' } },
            nextBefore: { type: ['string', 'null'] },
          },
          required: ['url', 'snapshots', 'nextBefore'],
        },
      },
    })
  }
  const isCheck = route === 'POST /v1/checks'
  const jobStatuses = ['payment_pending', 'queued', 'running', 'retryable', 'complete', 'failed']
  return declareDiscoveryExtension({
    bodyType: 'json',
    input,
    inputSchema: {
      type: 'object',
      required,
      additionalProperties: false,
      properties,
    },
    output: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'queued',
        ...(isCheck ? { jobStatus: 'queued', nextAction: 'poll_same_job' } : {}),
        pollUrl: '/v1/checks/550e8400-e29b-41d4-a716-446655440000',
        paymentMode: 'production',
      },
      // Kept compact: this travels in the 402 PAYMENT-REQUIRED header, which
      // must fit the production proxy's 4 KiB header buffer. Optional replay
      // and reconciliation fields are documented in OpenAPI instead.
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: jobStatuses },
          ...(isCheck ? {
            jobStatus: { type: 'string' },
            nextAction: { type: 'string', enum: ['poll_same_job', 'inspect_report', 'stop'] },
          } : {}),
          pollUrl: { type: 'string' },
          paymentMode: { type: 'string', enum: ['testnet', 'production'] },
        },
        required: [
          'id', 'status', 'pollUrl', 'paymentMode',
          ...(isCheck ? ['jobStatus', 'nextAction'] : []),
        ],
      },
    },
  })
}

function bazaarTags(route: PaymentMiddlewareOptions['route']): string[] {
  switch (route) {
    case 'POST /v1/verify':
      return ['website-assertions', 'browser-testing', 'regression-testing', 'accessibility', 'qa']
    case 'POST /v1/compare':
      return ['visual-regression', 'screenshot-diff', 'website-testing', 'browser-qa', 'qa']
    case 'POST /v1/extract':
      return [
        'web-to-markdown',
        'html-to-markdown',
        'content-extraction',
        'web-content',
        'markdown',
      ]
    case 'POST /v1/history':
      return ['page-history', 'website-snapshots', 'screenshot-archive', 'browser-qa', 'qa']
    case 'POST /v1/security-gate':
      return [
        'website-security',
        'security-headers',
        'cookie-security',
        'mixed-content',
        'release-gate',
      ]
    default:
      return ['browser-qa', 'website-testing', 'screenshots', 'accessibility', 'responsive-design']
  }
}

export function createPaymentMiddleware(opts: PaymentMiddlewareOptions): RequestHandler {
  const {
    mode,
    enableMainnet,
    facilitatorUrl,
    cdpApiKeyId,
    cdpApiKeySecret,
    customerHashSecret,
    payTo,
    solanaPayTo,
    enableSolana = false,
    priceUsdc,
    route = 'POST /v1/checks',
    description = 'ViewportWitness browser QA report across three viewports',
  } = opts

  if (mode === 'test') {
    return (req: Request, _res: Response, next: NextFunction): void => {
      req.paymentResult = { settled: false, mode: 'test' }
      next()
    }
  }

  if (mode === 'production' && !enableMainnet) {
    return unavailable(
      'mainnet_payments_disabled',
      'Production payment mode requires ENABLE_MAINNET_PAYMENTS=true and a reviewed release.',
    )
  }

  if (!cdpApiKeyId || !cdpApiKeySecret) {
    return unavailable(
      'payment_not_configured',
      'CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for testnet and production payment modes.',
    )
  }

  if (enableSolana && !solanaPayTo) {
    return unavailable(
      'payment_not_configured',
      'A Solana payment destination is required when Solana payments are enabled.',
    )
  }

  const network: Network = mode === 'production' ? 'eip155:8453' : 'eip155:84532'
  const solanaNetwork: Network =
    mode === 'production'
      ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
  const facilitator = createCdpFacilitatorClient({
    apiKeyId: cdpApiKeyId,
    apiKeySecret: cdpApiKeySecret,
    ...(facilitatorUrl ? { baseUrl: facilitatorUrl } : {}),
  })
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme())
  if (enableSolana) {
    resourceServer.register(solanaNetwork, new ExactSvmScheme())
  }
  resourceServer.registerExtension(bazaarResourceServerExtension)
  const bazaarDiscovery = createBazaarDiscovery(route)

  const accepts: PaymentOption[] = [
    {
      scheme: 'exact' as const,
      network,
      payTo,
      price: `$${priceUsdc}`,
      // Prevent unpaid browser work if post-handler settlement fails.
      extra: { paymentFlow: 'upfront' },
    },
    ...(enableSolana && solanaPayTo
      ? [
          {
            scheme: 'exact' as const,
            network: solanaNetwork,
            payTo: solanaPayTo,
            price: `$${priceUsdc}`,
            extra: { paymentFlow: 'upfront' },
          },
        ]
      : []),
  ]
  if (opts.admission) {
    installAdmissionHooks(resourceServer, facilitator, opts.admission.store, opts.admission.unresolvedLimit, {
      ...(opts.admission.payerUnresolvedLimit !== undefined
        ? { payerUnresolvedLimit: opts.admission.payerUnresolvedLimit }
        : {}),
    })
  }
  const x402 = paymentMiddleware(
    {
      [route]: {
        accepts,
        description,
        mimeType: 'application/json',
        serviceName: 'ViewportWitness by Apex Labs',
        tags: bazaarTags(route),
        extensions: bazaarDiscovery,
      },
    },
    resourceServer,
  )

  const legacy = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await x402(req, res, (err?: unknown) => {
        if (err) {
          next(err)
          return
        }
        const paymentId = paymentFingerprint(req)
        const paymentHeader = req.header('payment-signature') ?? req.header('x-payment')
        const customerId = customerFingerprint(paymentHeader, customerHashSecret)
        req.paymentResult = {
          settled: true,
          mode,
          ...(paymentId ? { paymentId } : {}),
          ...(customerId ? { customerId } : {}),
        }
        next()
      })
    } catch (error: unknown) {
      if (!res.headersSent) {
        res.status(503).json({
          error: 'payment_infrastructure_unavailable',
          detail: 'Payment verification or settlement is temporarily unavailable.',
        })
      } else {
        next(error)
      }
    }
  }

  const admission = opts.admission
  if (!admission) return legacy

  // Serializes one payment payload within this process. The durable unique
  // payment_id and BEGIN IMMEDIATE admission protect across processes.
  const inFlight = new Map<string, Promise<void>>()

  const replayBody = (job: JobRecord): Record<string, unknown> =>
    job.status === 'payment_pending' && job.settlementState !== 'rejected'
      ? { ...unresolvedPaymentBody(job.id, mode), paymentReplay: true }
      : {
          id: job.id,
          status: job.status,
          ...reconcileJobStatus(job.status),
          pollUrl: `/v1/checks/${job.id}`,
          paymentMode: mode,
          paymentReplay: true,
        }

  // Returns true when a response was sent for an already-recorded payment.
  const answerExisting = (req: Request, res: Response, paymentIds: string[]): boolean => {
    let existing: JobRecord | null = null
    for (const id of paymentIds) {
      existing = admission.store.getJobByPaymentId(id)
      if (existing) break
    }
    if (!existing) return false
    if (!req.jobIntent || !sameJobIntent(existing, req.jobIntent)) {
      res.status(409).json({
        error: 'payment_replay_conflict',
        code: 'payment_replay_conflict',
        nextAction: 'stop',
      })
      return true
    }
    res.status(202).json(replayBody(existing))
    return true
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentHeader = req.header('payment-signature') ?? req.header('x-payment')
    if (!paymentHeader) {
      // Unsigned: x402 returns the challenge. Nothing is stored.
      await legacy(req, res, next)
      return
    }
    const paymentId = paymentFingerprint(req) as string
    const paymentAliases = paymentFingerprintAliases(req)
    const lookupIds = [paymentId, ...paymentAliases]
    const intent = req.jobIntent
    if (!intent) {
      res.status(500).json({ error: 'validation_state_missing', code: 'internal_error' })
      return
    }

    // A retried payment never reaches the facilitator again: it gets its own
    // job (or its unresolved status) back, and only for the same work.
    if (answerExisting(req, res, lookupIds)) return
    let waiting = inFlight.get(paymentId)
    while (waiting) {
      await waiting
      if (answerExisting(req, res, lookupIds)) return
      waiting = inFlight.get(paymentId)
    }
    if (admission.store.countUnresolvedPayments() >= admission.unresolvedLimit) {
      res.setHeader('Retry-After', '300')
      res.status(503).json({
        error: 'payment_admission_paused',
        code: 'payment_admission_paused',
        detail: 'New paid work is paused while earlier payments are reconciled. Nothing was charged.',
      })
      return
    }

    const rawKey = req.headers['idempotency-key']
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey
    const customerId = customerFingerprint(paymentHeader, customerHashSecret)
    const ctx: AdmissionContext = {
      jobId: randomUUID(),
      paymentId,
      ...(paymentAliases.length ? { paymentAliases } : {}),
      intent,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(customerId ? { customerId } : {}),
      expiresAt: Date.now() + admission.retentionDays * 24 * 60 * 60 * 1000,
      phase: 'start',
    }

    let release!: () => void
    inFlight.set(paymentId, new Promise<void>((resolve) => { release = resolve }))

    // x402 writes its own error responses. Replace them when they would be
    // misleading: after settle was dispatched (outcome not proven) or when the
    // attempt was not admitted for a reason that is not a payment problem.
    const originalJson = res.json.bind(res)
    const originalSend = res.send.bind(res)
    let overridden = false
    const override = (): boolean => {
      if (overridden) return false
      if (ctx.phase === 'admitted' || ctx.phase === 'settled') {
        overridden = true
        const outcome = finalizeAdmission(admission.store, ctx, 'settle_response_not_success')
        res.removeHeader('PAYMENT-REQUIRED')
        // x402 may have attached a failed settlement receipt; while the outcome
        // is unproven no header may tell the client the payment failed.
        if (outcome !== 'settled') res.removeHeader('PAYMENT-RESPONSE')
        res.status(202)
        originalJson(outcome === 'settled'
          ? {
              id: ctx.jobId,
              status: 'queued',
              ...reconcileJobStatus('queued'),
              pollUrl: `/v1/checks/${ctx.jobId}`,
              paymentMode: mode,
            }
          : unresolvedPaymentBody(ctx.jobId, mode))
        return true
      }
      if (ctx.phase === 'not_admitted' && ctx.notAdmitted) {
        overridden = true
        res.removeHeader('PAYMENT-REQUIRED')
        res.removeHeader('PAYMENT-RESPONSE')
        const { reason, existing } = ctx.notAdmitted
        if (reason === 'payment_exists' && existing && sameJobIntent(existing, intent)) {
          res.status(202)
          originalJson(replayBody(existing))
        } else if (reason === 'payer_busy') {
          res.setHeader('Retry-After', '60')
          res.status(429)
          originalJson({ error: 'payment_payer_busy', code: 'payment_payer_busy', detail: PAYER_BUSY_DETAIL })
        } else if (reason === 'key_bound' || reason === 'payment_exists') {
          const code = reason === 'key_bound' ? 'idempotency_key_conflict' : 'payment_replay_conflict'
          res.status(409)
          originalJson({ error: code, code, detail: 'Nothing was charged for this request.' })
        } else {
          const code = reason === 'capacity' ? 'payment_admission_paused' : 'payment_admission_unavailable'
          res.setHeader('Retry-After', reason === 'capacity' ? '300' : '30')
          res.status(503)
          originalJson({ error: code, code, detail: 'Nothing was charged for this request. Retry later.' })
        }
        return true
      }
      return false
    }
    res.json = ((body?: unknown) => (override() ? res : originalJson(body))) as Response['json']
    res.send = ((body?: unknown) => (override() ? res : originalSend(body))) as Response['send']
    const restore = (): void => {
      res.json = originalJson
      res.send = originalSend
    }

    try {
      await admissionStorage.run(ctx, () =>
        x402(req, res, (err?: unknown) => {
          restore()
          if (err) {
            finalizeAdmission(admission.store, ctx, 'handler_error')
            next(err)
            return
          }
          const outcome = finalizeAdmission(admission.store, ctx, 'settlement_not_confirmed')
          if (outcome !== 'settled') {
            res.status(202).json(unresolvedPaymentBody(ctx.jobId, mode))
            return
          }
          req.paymentResult = {
            settled: true,
            mode,
            paymentId,
            admittedJobId: ctx.jobId,
            ...(customerId ? { customerId } : {}),
          }
          next()
        }),
      )
    } catch (error: unknown) {
      restore()
      const outcome = finalizeAdmission(admission.store, ctx, 'settle_exception')
      if (!res.headersSent) {
        if (outcome !== 'none') {
          res.status(202).json(unresolvedPaymentBody(ctx.jobId, mode))
        } else {
          res.status(503).json({
            error: 'payment_infrastructure_unavailable',
            detail: 'Payment verification is temporarily unavailable. Nothing was charged.',
          })
        }
      } else if (outcome === 'none') {
        next(error)
      }
    } finally {
      restore()
      // A disconnect cannot cancel a dispatched settle; the row stays
      // unresolved until settlement evidence arrives.
      if (ctx.phase === 'admitted') {
        finalizeAdmission(admission.store, ctx, 'request_ended_before_settlement')
      }
      inFlight.delete(paymentId)
      release()
    }
  }
}

export function getPaymentDiscovery(
  opts: PaymentMiddlewareOptions,
  baseUrl?: string,
): PaymentDiscovery {
  const baseNetworkId = opts.mode === 'production' ? 'eip155:8453' : 'eip155:84532'
  const baseNetwork =
    opts.mode === 'production' ? `base (${baseNetworkId})` : `base-sepolia (${baseNetworkId})`
  const accepts: PaymentDiscovery['accepts'] = [
    { scheme: 'exact', network: baseNetworkId, asset: 'USDC', payTo: opts.payTo },
  ]
  if (opts.enableSolana && opts.solanaPayTo) {
    accepts.push({
      scheme: 'exact',
      network:
        opts.mode === 'production'
          ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
          : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: 'USDC',
      payTo: opts.solanaPayTo,
    })
  }
  return {
    version: '2',
    paymentRequired: opts.mode !== 'test',
    price: `$${opts.priceUsdc} USDC`,
    asset: 'USDC',
    network: baseNetwork,
    payTo: opts.payTo,
    accepts,
    ...(opts.facilitatorUrl ? { facilitatorUrl: opts.facilitatorUrl } : {}),
    testMode: opts.mode === 'test',
    ...(baseUrl
      ? {
          endpoint: `POST ${baseUrl}/v1/checks`,
          method: 'POST',
          description:
            'Browser QA report across three viewports — screenshots, accessibility, layout',
          skillMdUrl: `${baseUrl}/skill.md`,
          openapiUrl: `${baseUrl}/openapi.json`,
          products: [
            {
              name: 'check_page',
              endpoint: `POST ${baseUrl}/v1/checks`,
              price: '$0.08 USDC',
              description: 'Three-viewport browser QA report',
            },
            {
              name: 'verify_page',
              endpoint: `POST ${baseUrl}/v1/verify`,
              price: '$0.10 USDC',
              description: 'Read-only assertions across three viewports',
            },
            {
              name: 'compare_page',
              endpoint: `POST ${baseUrl}/v1/compare`,
              price: '$0.12 USDC',
              description: 'Visual and QA comparison to a baseline report',
            },
            {
              name: 'extract_page',
              endpoint: `POST ${baseUrl}/v1/extract`,
              price: '$0.005 USDC',
              description: 'Deterministic public HTML to clean Markdown',
            },
            {
              name: 'web_release_gate',
              endpoint: `POST ${baseUrl}/v1/security-gate`,
              price: '$0.05 USDC',
              description: 'Passive release security checks for one public page',
            },
            {
              name: 'mcp',
              endpoint: `POST ${baseUrl}/mcp`,
              price: 'per tool',
              description: 'Remote MCP interface for AI agents',
            },
          ],
        }
      : {}),
  }
}
