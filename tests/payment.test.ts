import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { createPaymentMiddleware } from '../src/payment/index.js'
import type { PaymentMiddlewareOptions } from '../src/payment/index.js'

function makeReq(): Request {
  return {
    headers: {},
    body: {},
  } as Request
}

function makeRes(): { res: Response; statusCode: number; body: unknown } {
  const mock = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
  }
  const res = {
    status(code: number) {
      mock.statusCode = code
      return res
    },
    json(body: unknown) {
      mock.body = body
      mock.headersSent = true
      return res
    },
    headersSent: false,
  } as unknown as Response
  return { res, statusCode: mock.statusCode, body: mock.body }
}

const baseOpts: PaymentMiddlewareOptions = {
  payTo: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
  priceUsdc: '0.08',
  mode: 'test',
  enableMainnet: false,
}

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
      // no facilitatorUrl or facilitatorApiKey
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
