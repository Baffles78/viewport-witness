// Request/response stubs and base options for payment middleware tests.
import type { Request, Response } from 'express'
import type { PaymentMiddlewareOptions } from '../../src/payment/index.js'

export function makeReq(): Request {
  return {
    headers: {},
    body: {},
  } as Request
}

export function makeRes(): { res: Response; statusCode: number; body: unknown } {
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

export const baseOpts: PaymentMiddlewareOptions = {
  payTo: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
  priceUsdc: '0.08',
  mode: 'test',
  enableMainnet: false,
}
