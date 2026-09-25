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
import type { PaymentMode } from '../types.js'

export interface PaymentResult {
  settled: boolean
  paymentId?: string
  customerId?: string
  mode: PaymentMode
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      paymentResult?: PaymentResult
    }
  }
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
  description?: string
}

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

function paymentFingerprint(req: Request): string | undefined {
  const signature = req.header('payment-signature') ?? req.header('x-payment')
  if (!signature) return undefined
  return createHash('sha256').update(signature).digest('hex')
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
function createBazaarDiscovery(route: PaymentMiddlewareOptions['route']) {
  const input =
    route === 'POST /v1/verify'
      ? { url: 'https://example.com', assertions: [{ type: 'noConsoleErrors' }] }
      : route === 'POST /v1/compare'
        ? { url: 'https://example.com', baselineJobId: '550e8400-e29b-41d4-a716-446655440000' }
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
      items: { type: 'object' },
    }
    required.push('assertions')
  }
  if (route === 'POST /v1/compare') {
    properties['baselineJobId'] = { type: 'string', format: 'uuid' }
    required.push('baselineJobId')
  }
  return declareDiscoveryExtension({
    bodyType: 'json',
    input,
    inputSchema: {
      required,
      additionalProperties: false,
      properties,
    },
    output: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'queued',
        pollUrl: '/v1/checks/550e8400-e29b-41d4-a716-446655440000',
        paymentMode: 'production',
      },
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job UUID' },
          status: { type: 'string', enum: ['queued'], description: 'Initial job status' },
          pollUrl: { type: 'string', description: 'URL to poll for job status and results' },
          paymentMode: {
            type: 'string',
            enum: ['testnet', 'production'],
            description: 'Payment mode used for this job',
          },
        },
        required: ['id', 'status', 'pollUrl', 'paymentMode'],
        additionalProperties: false,
      },
    },
  })
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
  const x402 = paymentMiddleware(
    {
      [route]: {
        accepts,
        description,
        mimeType: 'application/json',
        serviceName: 'ViewportWitness by Apex Labs',
        tags: ['browser-qa', 'accessibility', 'screenshots', 'qa', 'layout'],
        extensions: bazaarDiscovery,
      },
    },
    resourceServer,
  )

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
