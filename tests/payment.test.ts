import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { generateKeyPairSigner } from '@solana/kit'
import { ExactSvmScheme as ExactSvmClient, toClientSvmSigner, USDC_DEVNET_ADDRESS } from '@x402/svm'
import { createPaymentMiddleware, customerFingerprint } from '../src/payment/index.js'
import { makeReq, makeRes, baseOpts } from './helpers/payment-middleware.js'

describe('anonymous customer fingerprint', () => {
  const secret = '0123456789abcdef0123456789abcdef'
  const payer = '0x1234567890abcdef1234567890abcdef12345678'

  function header(payload: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64')
  }

  it('creates a stable HMAC identifier from an EIP-3009 payer after decoding', () => {
    const lower = header({ payload: { authorization: { from: payer } } })
    const upper = header({
      payload: { authorization: { from: `0x${payer.slice(2).toUpperCase()}` } },
    })
    expect(customerFingerprint(lower, secret)).toMatch(/^cust_[a-f0-9]{64}$/)
    expect(customerFingerprint(lower, secret)).toBe(customerFingerprint(upper, secret))
  })

  it('supports Permit2 payer envelopes', () => {
    const payment = header({ payload: { permit2Authorization: { from: payer } } })
    expect(customerFingerprint(payment, secret)).toMatch(/^cust_[a-f0-9]{64}$/)
  })

  it('creates a stable HMAC identifier from a verified Solana exact transaction', async () => {
    const payerSigner = await generateKeyPairSigner()
    const client = new ExactSvmClient(toClientSvmSigner(payerSigner))
    const accepted = {
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const,
      asset: USDC_DEVNET_ADDRESS,
      amount: '80000',
      payTo: 'AwnqYWr32DUJvk4XKxfUSpVVYcoUuMFNp8XoBShm5qSS',
      maxTimeoutSeconds: 60,
      extra: {
        feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
        recentBlockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: '1',
      },
    }
    const payment = await client.createPaymentPayload(2, accepted)
    const paymentHeader = header({ accepted, payload: payment.payload })

    expect(customerFingerprint(paymentHeader, secret)).toMatch(/^cust_[a-f0-9]{64}$/)
    expect(customerFingerprint(paymentHeader, secret)).toBe(
      customerFingerprint(paymentHeader, secret),
    )
  })

  it('rejects mixed payment variants instead of trusting an unverified payer field', () => {
    const payment = header({
      payload: {
        authorization: { from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        permit2Authorization: { from: payer },
      },
    })
    expect(customerFingerprint(payment, secret)).toBeUndefined()

    const mixedSolana = header({
      accepted: { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
      payload: { authorization: { from: payer }, transaction: 'not-a-transaction' },
    })
    expect(customerFingerprint(mixedSolana, secret)).toBeUndefined()
  })

  it('uses the server secret so public wallet enumeration cannot reproduce identifiers', () => {
    const payment = header({ payload: { authorization: { from: payer } } })
    expect(customerFingerprint(payment, secret)).not.toBe(
      customerFingerprint(payment, 'abcdef0123456789abcdef0123456789'),
    )
  })

  it('returns undefined for missing, malformed, oversized, or non-address input', () => {
    expect(customerFingerprint(undefined, secret)).toBeUndefined()
    expect(customerFingerprint('not-base64-json', secret)).toBeUndefined()
    expect(customerFingerprint('x'.repeat(64 * 1024 + 1), secret)).toBeUndefined()
    expect(
      customerFingerprint(
        header({ payload: { authorization: { from: 'not-an-address' } } }),
        secret,
      ),
    ).toBeUndefined()
  })
})

describe('payment middleware - test mode', () => {
  it('passes through without payment in test mode', async () => {
    const middleware = createPaymentMiddleware({ ...baseOpts, mode: 'test' })
    const req = makeReq()
    const { res } = makeRes()
    const next = vi.fn()

    await new Promise<void>((resolve) => {
      const wrappedNext: NextFunction = (...args) => {
        next(...args)
        resolve()
      }
      const result = middleware(req, res, wrappedNext)
      if (result instanceof Promise) {
        result.then(resolve)
      }
    })

    expect(next).toHaveBeenCalled()
  })

  it('attaches paymentResult with settled:false in test mode', async () => {
    const middleware = createPaymentMiddleware({ ...baseOpts, mode: 'test' })
    const req = makeReq()
    const { res } = makeRes()
    let nextCalled = false

    await new Promise<void>((resolve) => {
      const wrappedNext: NextFunction = () => {
        nextCalled = true
        resolve()
      }
      const result = middleware(req, res, wrappedNext)
      if (result instanceof Promise) {
        result.then(resolve)
      }
    })

    expect(nextCalled).toBe(true)
    const paymentResult = (req as Request & { paymentResult?: { settled: boolean; mode: string } })
      .paymentResult
    expect(paymentResult).toBeDefined()
    expect(paymentResult?.settled).toBe(false)
    expect(paymentResult?.mode).toBe('test')
  })

  it('never claims settled:true in test mode', async () => {
    const middleware = createPaymentMiddleware({ ...baseOpts, mode: 'test' })
    const req = makeReq()
    const { res } = makeRes()

    await new Promise<void>((resolve) => {
      const wrappedNext: NextFunction = () => resolve()
      const result = middleware(req, res, wrappedNext)
      if (result instanceof Promise) {
        result.then(resolve)
      }
    })

    const paymentResult = (req as Request & { paymentResult?: { settled: boolean } }).paymentResult
    expect(paymentResult?.settled).not.toBe(true)
  })
})

describe('payment middleware - production mode guards', () => {
  it('returns 503 when production mode but mainnet not enabled', async () => {
    const middleware = createPaymentMiddleware({
      ...baseOpts,
      mode: 'production',
      enableMainnet: false,
    })

    const req = makeReq()
    let responseStatus = 200
    let responseBody: unknown

    const res = {
      status(code: number) {
        responseStatus = code
        return res
      },
      json(body: unknown) {
        responseBody = body
        return res
      },
      headersSent: true,
    } as unknown as Response

    const next = vi.fn()
    const result = middleware(req, res, next)
    if (result instanceof Promise) await result

    expect(responseStatus).toBe(503)
    expect((responseBody as { error?: string })?.error).toBe('mainnet_payments_disabled')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 503 when production mode enabled but no facilitator configured', async () => {
    const middleware = createPaymentMiddleware({
      ...baseOpts,
      mode: 'production',
      enableMainnet: true,
      // no facilitatorUrl or CDP keys
    })

    const req = makeReq()
    let responseStatus = 200
    const res = {
      status(code: number) {
        responseStatus = code
        return res
      },
      json() {
        return res
      },
      headersSent: true,
    } as unknown as Response

    const next = vi.fn()
    const result = middleware(req, res, next)
    if (result instanceof Promise) await result

    expect(responseStatus).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 503 when testnet mode but no facilitator URL', async () => {
    const middleware = createPaymentMiddleware({
      ...baseOpts,
      mode: 'testnet',
      // no facilitatorUrl
    })

    const req = makeReq()
    let responseStatus = 200
    const res = {
      status(code: number) {
        responseStatus = code
        return res
      },
      json() {
        return res
      },
      headersSent: true,
    } as unknown as Response

    const next = vi.fn()
    const result = middleware(req, res, next)
    if (result instanceof Promise) await result

    expect(responseStatus).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('payment middleware - fail closed behavior', () => {
  it('production mode without mainnet gate never passes through', async () => {
    const middleware = createPaymentMiddleware({
      ...baseOpts,
      mode: 'production',
      enableMainnet: false,
    })

    const req = makeReq()
    const next = vi.fn()
    let statusCalled = 0

    const res = {
      status(code: number) {
        statusCalled = code
        return res
      },
      json() {
        return res
      },
      headersSent: true,
    } as unknown as Response

    const result = middleware(req, res, next)
    if (result instanceof Promise) await result

    expect(next).not.toHaveBeenCalled()
    expect(statusCalled).toBeGreaterThanOrEqual(400)
  })

  it('testnet mode without facilitator never passes through', async () => {
    const middleware = createPaymentMiddleware({
      ...baseOpts,
      mode: 'testnet',
      facilitatorUrl: undefined,
    })

    const req = makeReq()
    const next = vi.fn()
    let statusCalled = 0

    const res = {
      status(code: number) {
        statusCalled = code
        return res
      },
      json() {
        return res
      },
      headersSent: true,
    } as unknown as Response

    const result = middleware(req, res, next)
    if (result instanceof Promise) await result

    expect(next).not.toHaveBeenCalled()
    expect(statusCalled).toBeGreaterThanOrEqual(400)
  })
})

describe('payment middleware - CDP configuration fail-closed', () => {
  it('returns 503 with payment_not_configured when testnet has URL but no CDP keys', async () => {
    const middleware = createPaymentMiddleware({
      ...baseOpts,
      mode: 'testnet',
      facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      // cdpApiKeyId and cdpApiKeySecret absent
    })

    const req = makeReq()
    let statusCalled = 0
    let responseBody: unknown
    const res = {
      status(code: number) {
        statusCalled = code
        return res
      },
      json(b: unknown) {
        responseBody = b
        return res
      },
      headersSent: true,
    } as unknown as Response
    const next = vi.fn()

    const result = middleware(req, res, next)
    if (result instanceof Promise) await result

    expect(next).not.toHaveBeenCalled()
    expect(statusCalled).toBe(503)
    expect((responseBody as { error?: string })?.error).toBe('payment_not_configured')
  })

  it('returns 503 with payment_not_configured when testnet has URL but only key ID', async () => {
    const middleware = createPaymentMiddleware({
      ...baseOpts,
      mode: 'testnet',
      facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      cdpApiKeyId: 'organizations/org/apiKeys/key',
      // cdpApiKeySecret absent
    })

    const req = makeReq()
    let statusCalled = 0
    const res = {
      status(code: number) {
        statusCalled = code
        return res
      },
      json() {
        return res
      },
      headersSent: true,
    } as unknown as Response
    const next = vi.fn()

    const result = middleware(req, res, next)
    if (result instanceof Promise) await result

    expect(next).not.toHaveBeenCalled()
    expect(statusCalled).toBe(503)
  })

  it('returns 503 with payment_not_configured when production has URL but no CDP keys', async () => {
    const middleware = createPaymentMiddleware({
      ...baseOpts,
      mode: 'production',
      enableMainnet: true,
      facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      // cdpApiKeyId and cdpApiKeySecret absent
    })

    const req = makeReq()
    let statusCalled = 0
    let responseBody: unknown
    const res = {
      status(code: number) {
        statusCalled = code
        return res
      },
      json(b: unknown) {
        responseBody = b
        return res
      },
      headersSent: true,
    } as unknown as Response
    const next = vi.fn()

    const result = middleware(req, res, next)
    if (result instanceof Promise) await result

    expect(next).not.toHaveBeenCalled()
    expect(statusCalled).toBe(503)
    expect((responseBody as { error?: string })?.error).toBe('payment_not_configured')
  })
})
