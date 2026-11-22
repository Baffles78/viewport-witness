import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Page } from 'playwright'
import { PNG } from 'pngjs'
import { withTimeout } from './timeout.js'
import { decodeBoundedPng } from './visual-exclusions.js'

export interface AnnotationHint {
  code: string
  selector: string
  explanation: string
}
export interface AnnotationBox extends AnnotationHint {
  number: number
  x: number
  y: number
  width: number
  height: number
}
export interface ScreenshotAnnotations {
  url: string
  sha256: string
  bytes: number
  boxes: AnnotationBox[]
  limitations: string[]
}

const MAX_BOXES = 20
const DIGITS = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
]
const cleanText = (value: string, max: number): string =>
  value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/<[^>]*>/g, '')
    .slice(0, max)

/** Bounds annotation geometry to the existing viewport image; no page mutation. */
export function clipAnnotationBox(
  rect: { x: number; y: number; width: number; height: number },
  dimensions: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null
  const x = Math.max(0, Math.floor(rect.x)),
    y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(dimensions.width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(dimensions.height, Math.ceil(rect.y + rect.height))
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

/** Draw on a decoded copy, preserving both the original file and its hash. */
export function renderAnnotations(original: Buffer, boxes: AnnotationBox[]): Buffer {
  const image = decodeBoundedPng(original)
  const put = (x: number, y: number, white = false): void => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
    const offset = (y * image.width + x) * 4
    image.data[offset] = 255
    image.data[offset + 1] = white ? 255 : 40
    image.data[offset + 2] = white ? 255 : 70
    image.data[offset + 3] = 255
  }
  for (const box of boxes.slice(0, MAX_BOXES)) {
    const rect = clipAnnotationBox(box, image)
    if (!rect) continue
    const right = rect.x + rect.width - 1,
      bottom = rect.y + rect.height - 1
    for (let thickness = 0; thickness < 2; thickness++) {
      for (let x = rect.x; x <= right; x++) {
        put(x, rect.y + thickness)
        put(x, bottom - thickness)
      }
      for (let y = rect.y; y <= bottom; y++) {
        put(rect.x + thickness, y)
        put(right - thickness, y)
      }
    }
    const label = String(box.number)
    const labelX = Math.min(rect.x, Math.max(0, image.width - (label.length * 8 + 4)))
    const labelY = Math.min(rect.y, Math.max(0, image.height - 14))
    for (let y = 0; y < 14; y++)
      for (let x = 0; x < label.length * 8 + 4; x++) put(labelX + x, labelY + y)
    for (let digit = 0; digit < label.length; digit++) {
      const pixels = DIGITS[Number(label[digit])]
      if (!pixels) continue
      for (let y = 0; y < 5; y++)
        for (let x = 0; x < 3; x++) {
          if (pixels[y * 3 + x] !== '1') continue
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++)
              put(labelX + 2 + digit * 8 + x * 2 + dx, labelY + 2 + y * 2 + dy, true)
        }
    }
  }
  return PNG.sync.write(image)
}

export async function createScreenshotAnnotations(
  page: Page,
  original: Buffer,
  outputPath: string,
  url: string,
  hints: AnnotationHint[],
): Promise<ScreenshotAnnotations> {
  const selected = hints.slice(0, MAX_BOXES).map((hint) => ({
    code: cleanText(hint.code, 100),
    selector: cleanText(hint.selector, 300),
    explanation: cleanText(hint.explanation, 240),
  }))
  const limitations = [
    'Annotations are a separate derivative. Numbered boxes map to the JSON legend; original screenshots and hashes are preserved.',
    'Only up to 20 hinted elements in the main document are observed, without scrolling or interaction. Layout can move between screenshot and geometry observation.',
  ]
  let boxes: AnnotationBox[] = []
  try {
    const geometries = await withTimeout(
      page.evaluate(
        (selectors) =>
          selectors.map((selector) => {
            try {
              const element = document.querySelector(selector)
              if (!element) return null
              const rect = element.getBoundingClientRect()
              const style = getComputedStyle(element)
              if (
                style.visibility === 'hidden' ||
                style.display === 'none' ||
                Number(style.opacity) === 0
              )
                return null
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            } catch {
              return null
            }
          }),
        selected.map((hint) => hint.selector),
      ),
      2_000,
      'annotation_timeout',
    )
    const dimensions = { width: original.readUInt32BE(16), height: original.readUInt32BE(20) }
    boxes = selected.flatMap((hint, index) => {
      const geometry = geometries[index]
      const rect = geometry ? clipAnnotationBox(geometry, dimensions) : null
      return rect ? [{ ...hint, number: index + 1, ...rect }] : []
    })
    const unavailable = selected.length - boxes.length
    if (unavailable > 0)
      limitations.push(
        `${unavailable} hint(s) could not be located or were outside the screenshot; no box is claimed for them.`,
      )
  } catch {
    limitations.push('Element geometry observation unavailable; no boxes are claimed.')
  }
  if (hints.length > MAX_BOXES)
    limitations.push('Additional hinted elements were omitted at the annotation limit.')
  const rendered = renderAnnotations(original, boxes)
  await fs.writeFile(outputPath, rendered)
  return {
    url,
    sha256: createHash('sha256').update(rendered).digest('hex'),
    bytes: rendered.length,
    boxes,
    limitations,
  }
}
