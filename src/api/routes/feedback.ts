import express, { Router, type Request, type Response, type NextFunction } from 'express'
import type { JobStore } from '../../db.js'
import { feedbackGuidance, feedbackSchema } from '../../feedback/schema.js'
import { feedbackLimits, type Config } from '../../config.js'

export function createFeedbackRouter(store: JobStore, cfg: Config): Router {
  const router = Router()
  router.get('/v1/feedback', (_req, res) => {
    res.json({ ...feedbackGuidance, schema: '/openapi.json#/components/schemas/FeedbackRequest' })
  })
  router.post('/v1/feedback', express.json({ limit: '2kb' }), (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const parsed = feedbackSchema.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: 'invalid_feedback',
          detail:
            'Use the documented fields and a short feature label (3–80 characters, at most 8 words). No URLs, personal data or credentials.',
        })
      return
    }
    try {
      const receipt = store.feedback.submit(parsed.data, cfg.PAYMENT_MODE, feedbackLimits(cfg))
      if (receipt.status === 'limited') {
        res.setHeader('Retry-After', '86400')
        res
          .status(429)
          .json({
            error: 'feedback_limit',
            detail: 'Feedback storage or daily allowance is full. Try later.',
          })
        return
      }
      res.status(receipt.status === 'accepted' ? 201 : 200).json({
        ...receipt,
        paymentRequired: false,
        detail:
          'Thank you. Feedback is reviewed as a suggestion; no feature or purchase is promised.',
      })
    } catch {
      // Never log payloads or raw database errors.
      res
        .status(503)
        .json({ error: 'feedback_unavailable', detail: 'Feedback could not be saved. Try later.' })
    }
  })
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const tooLarge =
      typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.too.large'
    res
      .status(tooLarge ? 413 : 400)
      .json({ error: 'invalid_feedback', detail: 'Send a valid JSON object no larger than 2KB.' })
  })
  return router
}
