/**
 * x402 payment adapter.
 *
 * Test mode deliberately bypasses payment and never claims settlement. Paid
 * modes use the official x402 v2 packages and request the EVM `upfront` flow,
 * so payment is settled before the job handler may enqueue browser work.
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
import { ExactEvmScheme } from '@x402/evm/exact/server'
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from '@x402/extensions/bazaar'
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
  priceUsdc: string
  mode: PaymentMode
  enableMainnet: boolean
  facilitatorUrl?: string | undefined
  cdpApiKeyId?: string | undefined
  cdpApiKeySecret?: string | undefined
  customerHashSecret?: string | undefined
}

export interface PaymentDiscovery {
  version: string
  paymentRequired: boolean
  price: string
  asset: string
  network: string
  payTo: string
  facilitatorUrl?: string
  testMode: boolean
  // Crawler-facing discovery fields (present when baseUrl is supplied)
  endpoint?: string
  method?: string
  description?: string
  skillMdUrl?: string
  openapiUrl?: string
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
      payload?: {
        authorization?: { from?: unknown }
        permit2Authorization?: { from?: unknown }
      }
    }
    const hasAuthorization = envelope.payload?.authorization !== undefined
    const hasPermit2Authorization = envelope.payload?.permit2Authorization !== undefined
    if (hasAuthorization === hasPermit2Authorization) {
      return undefined
    }
    const candidate = hasAuthorization
      ? envelope.payload?.authorization?.from
      : envelope.payload?.permit2Authorization?.from
    if (typeof candidate !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(candidate)) {
      return undefined
    }
    return `cust_${createHmac('sha256', secret).update(candidate.toLowerCase()).digest('hex')}`
  } catch {
    return undefined
  }
}

// Bazaar discovery extension: describes the request/response schema for marketplace indexing.
// Request: strict {url:string} only. Response: the accepted 202 job object, not the eventual report.
const bazaarDiscovery = declareDiscoveryExtension({
  bodyType: 'json',
  input: { url: 'https://example.com' },
  inputSchema: {
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'Public HTTPS URL to check',
        example: 'https://example.com',
      },
    },
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

export function createPaymentMiddleware(opts: PaymentMiddlewareOptions): RequestHandler {
  const {
    mode,
    enableMainnet,
    facilitatorUrl,
    cdpApiKeyId,
    cdpApiKeySecret,
    customerHashSecret,
    payTo,
    priceUsdc,
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

  const network = mode === 'production' ? 'eip155:8453' : 'eip155:84532'
  const facilitator = createCdpFacilitatorClient({
    apiKeyId: cdpApiKeyId,
    apiKeySecret: cdpApiKeySecret,
    ...(facilitatorUrl ? { baseUrl: facilitatorUrl } : {}),
  })
  const resourceServer = new x402ResourceServer(facilitator)
    .register(network, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension)
  const x402 = paymentMiddleware(
    {
      'POST /v1/checks': {
        accepts: {
          scheme: 'exact',
          network,
          payTo,
          price: `$${priceUsdc}`,
          // Prevent unpaid browser work if post-handler settlement fails.
          extra: { paymentFlow: 'upfront' },
        },
        description: 'ViewportWitness browser QA report across three viewports',
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
  return {
    version: '2',
    paymentRequired: opts.mode !== 'test',
    price: `$${opts.priceUsdc} USDC`,
    asset: 'USDC',
    network: opts.mode === 'production' ? 'base (eip155:8453)' : 'base-sepolia (eip155:84532)',
    payTo: opts.payTo,
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
        }
      : {}),
  }
}
