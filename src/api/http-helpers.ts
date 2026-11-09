import type { NextFunction, Request, RequestHandler, Response } from 'express'

// Shared by the route files. Passes async errors to Express's error handler.
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next): void => void handler(req, res, next).catch(next)
}

// The raw Idempotency-Key header. Length and replay rules stay with each route.
export function readIdempotencyKey(req: Request): string | undefined {
  const value = req.headers['idempotency-key']
  return Array.isArray(value) ? value[0] : value
}
