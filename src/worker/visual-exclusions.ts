import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

import { validateExclusions, exclusionMask } from '../visual-exclusions.js'
export { validateExclusions, type VisualExclusion } from '../visual-exclusions.js'

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

/** Raw screenshots stay untouched; exclusions affect pixel evidence alone. */
export function compareWithExclusions(baseline: Buffer, current: Buffer, input: unknown = []) {
  const before = decodeBoundedPng(baseline)
  const after = decodeBoundedPng(current)
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('Baseline and current screenshot dimensions must match.')
  }
  const { width, height } = after
  const exclusions = validateExclusions(input, width, height)
  const totalPixels = width * height
  const { mask: excluded, excludedPixels } = exclusionMask(exclusions, width, height)
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
