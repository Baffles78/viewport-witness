/**
 * x402 payment adapter.
 *
 * Test mode deliberately bypasses payment and never claims settlement. Paid
 * modes use the official x402 v2 packages and request the EVM `upfront` flow,
 * so payment is settled before the job handler may enqueue browser work.
 */

import { createHash } from 'node:crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { paymentMiddleware } from '@x402/express'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import type { PaymentMode } from '../types.js'

export interface PaymentResult {
  settled: boolean
  paymentId?: string
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
  facilitatorApiKey?: string | undefined
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

export function createPaymentMiddleware(opts: PaymentMiddlewareOptions): RequestHandler {
  const { mode, enableMainnet, facilitatorUrl, facilitatorApiKey, payTo, priceUsdc } = opts

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

  if (!facilitatorUrl) {
    return unavailable(
      'payment_not_configured',
      'FACILITATOR_URL is required for testnet and production payment modes.',
    )
  }

  if (mode === 'production' && !facilitatorApiKey) {
    return unavailable(
      'payment_not_configured',
      'A production facilitator credential is required for mainnet payment mode.',
    )
  }

  const network = mode === 'production' ? 'eip155:8453' : 'eip155:84532'
  const authHeaders = facilitatorApiKey
    ? { Authorization: `Bearer ${facilitatorApiKey}` }
    : undefined
  const facilitator = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    timeoutMs: 10_000,
    ...(authHeaders
      ? {
          createAuthHeaders: async () => ({
            verify: authHeaders,
            settle: authHeaders,
            supported: authHeaders,
            bazaar: authHeaders,
          }),
        }
      : {}),
  })
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme())
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
        serviceName: 'ViewportWitness',
        tags: ['browser-qa', 'accessibility', 'screenshots'],
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
        req.paymentResult = {
          settled: true,
          mode,
          ...(paymentId ? { paymentId } : {}),
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

export function getPaymentDiscovery(opts: PaymentMiddlewareOptions): PaymentDiscovery {
  return {
    version: '2',
    paymentRequired: opts.mode !== 'test',
    price: `$${opts.priceUsdc} USDC`,
    asset: 'USDC',
    network: opts.mode === 'production' ? 'base (eip155:8453)' : 'base-sepolia (eip155:84532)',
    payTo: opts.payTo,
    ...(opts.facilitatorUrl ? { facilitatorUrl: opts.facilitatorUrl } : {}),
    testMode: opts.mode === 'test',
  }
}
