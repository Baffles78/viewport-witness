import { z } from 'zod'

// Shared MCP tool result shape and input schemas.
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export function jsonResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  }
}

const assertionItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noHorizontalOverflow') }).strict(),
  z.object({ type: z.literal('noConsoleErrors') }).strict(),
  z
    .object({
      type: z.literal('textVisible'),
      value: z.string().min(1).max(200).describe('Visible text to find on the rendered page.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('titleIncludes'),
      value: z.string().min(1).max(200).describe('Text that the document title must include.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('selectorExists'),
      selector: z.string().min(1).max(300).describe('CSS selector that must exist in the DOM.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('selectorVisible'),
      selector: z.string().min(1).max(300).describe('CSS selector that must be visibly rendered.'),
    })
    .strict(),
])
export const assertionsSchema = z
  .array(assertionItemSchema)
  .min(1)
  .max(20)
  .describe('One to twenty explicit pass/fail assertions to evaluate across all three viewports.')

export const publicPageUrlSchema = z
  .string()
  .url()
  .max(2048)
  .describe(
    'Public HTTPS page URL. Private, loopback, credentialed, and non-HTTPS URLs are rejected.',
  )
