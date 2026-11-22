import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import {
  clipAnnotationBox,
  createScreenshotAnnotations,
  renderAnnotations,
} from '../src/worker/annotations.js'

function original(): Buffer {
  const image = new PNG({ width: 100, height: 80 })
  image.data.fill(255)
  return PNG.sync.write(image)
}

describe('screenshot annotation evidence', () => {
  it('clips rectangles to the original viewport and rejects invisible or invalid geometry', () => {
    expect(
      clipAnnotationBox({ x: -4.5, y: 2, width: 10, height: 90 }, { width: 100, height: 80 }),
    ).toEqual({ x: 0, y: 2, width: 6, height: 78 })
    for (const rect of [
      { x: 101, y: 0, width: 10, height: 10 },
      { x: NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 10 },
    ]) {
      expect(clipAnnotationBox(rect, { width: 100, height: 80 })).toBeNull()
    }
  })

  it('creates a numbered derivative without modifying original bytes', () => {
    const source = original(),
      before = Buffer.from(source)
    const rendered = renderAnnotations(source, [
      {
        number: 1,
        code: 'test',
        selector: 'button',
        explanation: 'Missing label',
        x: 5,
        y: 5,
        width: 50,
        height: 40,
      },
    ])
    expect(source.equals(before)).toBe(true)
    const result = PNG.sync.read(rendered)
    expect([result.width, result.height]).toEqual([100, 80])
    expect(result.data[(5 * 100 + 5) * 4 + 1]).toBe(40)
    expect(PNG.sync.read(source).data.equals(result.data)).toBe(false)
  })

  it('maps boxes to bounded legends and exposes unavailable hints', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-annotations-'))
    try {
      const page = {
        evaluate: async () => [{ x: -5, y: 2, width: 30, height: 20 }, null],
      } as unknown as Page
      const result = await createScreenshotAnnotations(
        page,
        original(),
        path.join(dir, 'annotations.png'),
        '/annotations/desktop',
        [
          {
            code: 'accessibility:button-name',
            selector: 'button',
            explanation: '<b>Missing name</b>',
          },
          { code: 'responsive-layout', selector: '.outside', explanation: 'Overflow' },
        ],
      )
      expect(result.boxes).toEqual([
        {
          number: 1,
          code: 'accessibility:button-name',
          selector: 'button',
          explanation: 'Missing name',
          x: 0,
          y: 2,
          width: 25,
          height: 20,
        },
      ])
      expect(result.limitations.join(' ')).toMatch(/1 hint\(s\) could not/)
      const data = await fs.readFile(path.join(dir, 'annotations.png'))
      expect(result.sha256).toBe(createHash('sha256').update(data).digest('hex'))
      expect(result.bytes).toBe(data.length)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves evidence on geometry failure and marks the absence of boxes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-annotations-'))
    try {
      const page = {
        evaluate: async () => {
          throw new Error('closed')
        },
      } as unknown as Page
      const result = await createScreenshotAnnotations(
        page,
        original(),
        path.join(dir, 'annotations.png'),
        '/annotations/desktop',
        [{ code: 'test', selector: 'button', explanation: 'Missing name' }],
      )
      expect(result.boxes).toEqual([])
      expect(result.limitations.join(' ')).toMatch(/geometry observation unavailable/)
      expect(
        PNG.sync
          .read(await fs.readFile(path.join(dir, 'annotations.png')))
          .data.equals(PNG.sync.read(original()).data),
      ).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
