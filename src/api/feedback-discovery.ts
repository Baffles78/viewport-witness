import type { RequestHandler } from 'express'
import { withErrorFeedback } from '../feedback/invitation.js'

// Attach before parsing/payment handlers so application-level blockers advertise feedback.
// The signed/encoded payment headers and all original response fields remain untouched.
export const feedbackDiscovery: RequestHandler = (req, res, next) => {
  if (req.path.startsWith('/v1/') && req.path !== '/v1/feedback') {
    const json = res.json
    res.json = function (body: unknown) {
      return json.call(this, withErrorFeedback(body, this.statusCode >= 400))
    }
  }
  next()
}
