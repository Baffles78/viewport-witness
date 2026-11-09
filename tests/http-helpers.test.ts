import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { asyncHandler, readIdempotencyKey } from '../src/api/http-helpers.js'

const req = (headers: Record<string, string | string[]>) => ({ headers }) as unknown as Request

describe('readIdempotencyKey', () => {
  it('returns undefined when the header is missing', () => {
    expect(readIdempotencyKey(req({}))).toBeUndefined()
  })
  it('returns a single header value', () => {
    expect(readIdempotencyKey(req({ 'idempotency-key': 'abc' }))).toBe('abc')
  })
  it('returns the first value when the header repeats', () => {
    expect(readIdempotencyKey(req({ 'idempotency-key': ['first', 'second'] }))).toBe('first')
  })
})

describe('asyncHandler', () => {
  it('passes a rejected handler error to next', async () => {
    const error = new Error('boom')
    const next = vi.fn()
    asyncHandler(async () => {
      throw error
    })(req({}), {} as Response, next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(error))
  })
  it('does not call next when the handler succeeds', async () => {
    const next = vi.fn()
    let done = false
    asyncHandler(async () => {
      done = true
    })(req({}), {} as Response, next)
    await vi.waitFor(() => expect(done).toBe(true))
    expect(next).not.toHaveBeenCalled()
  })
})
