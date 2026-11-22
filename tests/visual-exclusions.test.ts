import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { compareWithExclusions, decodeBoundedPng } from '../src/worker/visual-exclusions.js'

function image(changes: number[] = []): Buffer {
  const png = new PNG({ width: 10, height: 10 })
  for (let pixel = 0; pixel < 100; pixel++) {
    png.data.set(changes.includes(pixel) ? [255, 255, 255, 255] : [0, 0, 0, 255], pixel * 4)
  }
  return PNG.sync.write(png)
}

describe('transparent offline visual exclusions', () => {
  it('counts overlapping masks once, retains raw change and uses included denominator', () => {
    const baseline = image(),
      current = image([0, 9])
    const originals = [Buffer.from(baseline), Buffer.from(current)]
    const result = compareWithExclusions(baseline, current, [
      { x: 0, y: 0, width: 2, height: 1 },
      { x: 1, y: 0, width: 2, height: 1 },
    ])
    expect(result.summary).toMatchObject({
      excludedPixels: 3,
      includedPixels: 97,
      rawChangedPixels: 2,
      changedPixels: 1,
      changedPercent: 1.0309,
    })
    expect(baseline).toEqual(originals[0])
    expect(current).toEqual(originals[1])
    const diff = PNG.sync.read(result.diff)
    expect([...diff.data.subarray(0, 4)]).toEqual([0, 120, 255, 255])
    expect([...diff.data.subarray(9 * 4, 10 * 4)]).toEqual([255, 0, 0, 255])
  })

  it('retains all differences without masks and never equates filtered zero to raw zero', () => {
    expect(compareWithExclusions(image(), image([0])).summary.changedPixels).toBe(1)
    const result = compareWithExclusions(image(), image([0]), [{ x: 0, y: 0, width: 1, height: 1 }])
    expect(result.summary.rawChangedPixels).toBe(1)
    expect(result.summary.changedPixels).toBe(0)
  })

  it.each([
    [{ x: -1, y: 0, width: 1, height: 1 }],
    [{ x: 9, y: 0, width: 2, height: 1 }],
    [{ x: 0, y: 0, width: 0, height: 1 }],
    [{ x: 0.5, y: 0, width: 1, height: 1 }],
    [{ x: 0, y: 0, width: 5, height: 5 }],
    [{ x: 0, y: 0, width: 1, height: 1, selector: 'body' }],
    Array.from({ length: 21 }, () => ({ x: 0, y: 0, width: 1, height: 1 })),
  ])('rejects invalid, excessive or overly broad rectangles: %j', (...regions) => {
    // it.each spreads row arrays; reconstruct the requested rectangle array.
    expect(() => compareWithExclusions(image(), image(), regions)).toThrow()
  })

  it('accepts exactly twenty percent and rejects malformed/oversized PNGs before allocation', () => {
    expect(
      compareWithExclusions(image(), image(), [{ x: 0, y: 0, width: 2, height: 10 }]).summary
        .excludedPixels,
    ).toBe(20)
    expect(() => decodeBoundedPng(Buffer.from('not a png'))).toThrow()
    const forged = image()
    forged.writeUInt32BE(2 ** 30, 16)
    expect(() => decodeBoundedPng(forged)).toThrow('dimensions')
  })
})
