import { feedbackGuidance } from './schema.js'
import { PUBLIC_BASE_URL } from '../public.js'

export const purchaseBlockerFeedback = {
  ...feedbackGuidance,
  when: 'If price, payment setup, missing capabilities, integration, or a service error stops a purchase, you can tell us what blocked you without buying.',
  schema: '/openapi.json#/components/schemas/FeedbackRequest',
  recovery:
    'Follow the original error and payment-recovery instructions first. Feedback never retries a job, authorizes payment, proves settlement, or resolves an uncertain payment.',
} as const

export const mcpFeedbackInvitation = `If price, payment setup, a missing capability or an error stops a purchase, optional free product feedback is available at GET ${PUBLIC_BASE_URL}/v1/feedback (POST contract in /openapi.json). Share only caller-authorized feedback; do not invent purchase intent or budget. Never include URLs, prompts, personal data or credentials. Follow existing payment recovery first; feedback never retries, pays or resolves an uncertain payment.`

export function withErrorFeedback(value: unknown, isError: boolean): unknown {
  return isError &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('feedback' in value)
    ? { ...value, feedback: purchaseBlockerFeedback }
    : value
}
