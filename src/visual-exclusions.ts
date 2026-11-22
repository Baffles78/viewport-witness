import { z } from 'zod'
import { VIEWPORT_NAMES, VIEWPORTS, type Viewport } from './types.js'

export interface VisualExclusion {
  x: number
  y: number
  width: number
  height: number
}
export type VisualExclusions = Partial<Record<Viewport, VisualExclusion[]>>

export const MAX_EXCLUSION_RECTANGLES = 20
export const MAX_EXCLUSION_FRACTION = 0.2

/** Protocol safety ceilings, shared by hosted preflight and offline pixel comparison. */
export function validateExclusions(
  value: unknown,
  width: number,
  height: number,
): VisualExclusion[] {
  if (!Array.isArray(value) || value.length > MAX_EXCLUSION_RECTANGLES) {
    throw new Error('Exclusions must be an array of at most 20 rectangles.')
  }
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Each exclusion must be an integer rectangle.')
    const row = item as Record<string, unknown>
    if (
      Object.keys(row).sort().join(',') !== 'height,width,x,y' ||
      !['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(row[key]))
    ) {
      throw new Error('Each exclusion must contain only integer x, y, width and height.')
    }
    const rect = row as unknown as VisualExclusion
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x + rect.width > width ||
      rect.y + rect.height > height
    ) {
      throw new Error('Exclusion rectangles must fit entirely inside the screenshot.')
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

/** Build a bounded union mask; overlap counts once, before any payment can settle. */
export function exclusionMask(rectangles: VisualExclusion[], width: number, height: number) {
  const mask = new Uint8Array(width * height)
  for (const rect of rectangles) {
    for (let y = rect.y; y < rect.y + rect.height; y++)
      mask.fill(1, y * width + rect.x, y * width + rect.x + rect.width)
  }
  const excludedPixels = mask.reduce((sum, value) => sum + value, 0)
  if (excludedPixels > Math.floor(width * height * MAX_EXCLUSION_FRACTION)) {
    throw new Error('Exclusions may cover at most 20% of the screenshot, counting overlap once.')
  }
  return { mask, excludedPixels }
}

/** Canonical identity: viewport/key/rectangle order and duplicate/empty regions do not matter. */
export function normalizeVisualExclusions(value: unknown): VisualExclusions {
  if (value === undefined) return {}
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !VIEWPORT_NAMES.includes(key as Viewport))
  ) {
    throw new Error('visualExclusions must contain only the three supported viewport names.')
  }
  const result: VisualExclusions = {}
  for (const viewport of VIEWPORT_NAMES) {
    const input = (value as Record<string, unknown>)[viewport]
    if (input === undefined) continue
    const { width, height } = VIEWPORTS[viewport]
    const rectangles = validateExclusions(input, width, height)
    exclusionMask(rectangles, width, height)
    const canonical = [
      ...new Map(rectangles.map((rect) => [JSON.stringify(rect), rect])).values(),
    ].sort((a, b) => a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height)
    if (canonical.length) result[viewport] = canonical
  }
  return result
}

const rectangleSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
const rectanglesSchema = z.array(rectangleSchema).max(MAX_EXCLUSION_RECTANGLES)
export const visualExclusionsSchema = z
  .object({
    phonePortrait: rectanglesSchema.optional(),
    phoneLandscape: rectanglesSchema.optional(),
    desktop: rectanglesSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      normalizeVisualExclusions(value)
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message })
    }
  })
  .transform(normalizeVisualExclusions)
  .describe(
    'Optional visual-only integer rectangles by viewport: at most 20 rectangles and 20% union coverage per screenshot. Raw evidence and nonvisual findings remain available.',
  )
