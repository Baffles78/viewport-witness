import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

export interface VisualExclusion {
  x: number
  y: number
  width: number
  height: number
}

const MAX_PNG_BYTES = 8 * 1024 * 1024
const MAX_PIXELS = 1440 * 900
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Check dimensions before decoding to avoid allocating an unbounded PNG. */
export function decodeBoundedPng(data: Buffer): PNG {
  if (
    data.length < 33 ||
    data.length > MAX_PNG_BYTES ||
    !data.subarray(0, 8).equals(PNG_SIGNATURE) ||
    data.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Expected a PNG no larger than 8 MiB.')
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  if (!width || !height || width > 1440 || height > 900 || width * height > MAX_PIXELS) {
    throw new Error('PNG dimensions exceed the supported viewport bounds.')
  }
  return PNG.sync.read(data)
}

export function validateExclusions(
  value: unknown,
  width: number,
  height: number,
): VisualExclusion[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('Exclusions must be an array of at most 20 rectangles.')
  }
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Each exclusion must be an integer rectangle.')
    }
    const row = item as Record<string, unknown>
    if (
      Object.keys(row).sort().join(',') !== 'height,width,x,y' ||
      !['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(row[key]))
    )
      throw new Error('Each exclusion must contain only integer x, y, width and height.')
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
    return { ...rect }
  })
}

/** Offline only: raw screenshots stay untouched; exclusions affect pixel evidence alone. */
export function compareWithExclusions(baseline: Buffer, current: Buffer, input: unknown = []) {
  const before = decodeBoundedPng(baseline)
  const after = decodeBoundedPng(current)
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('Baseline and current screenshot dimensions must match.')
  }
  const { width, height } = after
  const exclusions = validateExclusions(input, width, height)
  const totalPixels = width * height
  const excluded = new Uint8Array(totalPixels)
  for (const rect of exclusions) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      excluded.fill(1, y * width + rect.x, y * width + rect.x + rect.width)
    }
  }
  const excludedPixels = excluded.reduce((sum, value) => sum + value, 0)
  if (excludedPixels > Math.floor(totalPixels * 0.2)) {
    throw new Error('Exclusions may cover at most 20% of the screenshot, counting overlap once.')
  }
  const diff = new PNG({ width, height })
  const rawChangedPixels = pixelmatch(before.data, after.data, diff.data, width, height, {
    threshold: 0.1,
    diffMask: true,
  })
  let changedPixels = 0
  for (let pixel = 0; pixel < totalPixels; pixel++) {
    const offset = pixel * 4
    if (excluded[pixel]) {
      // Explicit blue marks disclose ignored evidence in the derivative image.
      diff.data.set([0, 120, 255, 255], offset)
    } else if (diff.data[offset + 3]) changedPixels++
  }
  const includedPixels = totalPixels - excludedPixels
  return {
    summary: {
      schema: 'viewport-witness-local-visual-comparison/v1',
      dimensions: { width, height },
      baselineSha256: createHash('sha256').update(baseline).digest('hex'),
      currentSha256: createHash('sha256').update(current).digest('hex'),
      exclusions,
      excludedPixels,
      includedPixels,
      rawChangedPixels,
      rawChangedPercent: Number(((rawChangedPixels / totalPixels) * 100).toFixed(4)),
      changedPixels,
      changedPercent: Number(((changedPixels / includedPixels) * 100).toFixed(4)),
      limitations: [
        'Local visual comparison only; excluded regions are blue in the diff image.',
        'Exclusions do not suppress accessibility, layout, assertion or browser-error findings.',
        'A zero pixel difference does not certify a page is safe to release.',
      ],
    },
    diff: PNG.sync.write(diff),
  }
}
