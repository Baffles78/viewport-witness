import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { observeLayout, evaluateNoHorizontalOverflow } from '../src/worker/layout.js'

describe('layout observation failures', () => {
  it('labels evaluation exceptions unavailable', async () => {
    const page = { evaluate: async () => { throw new Error('page closed') } } as unknown as Page
    expect(await observeLayout(page, 20)).toEqual({
      overflowDetected: false,
      offscreenElements: 0,
      layoutLocatorHints: [],
      layoutObservation: 'unavailable',
    })
  })

  it('labels evaluation timeouts unavailable', async () => {
    const page = { evaluate: () => new Promise<never>(() => {}) } as unknown as Page
    expect(await observeLayout(page, 10)).toEqual({
      overflowDetected: false,
      offscreenElements: 0,
      layoutLocatorHints: [],
      layoutObservation: 'unavailable',
    })
  })
})

describe('noHorizontalOverflow assertion', () => {
  it('does not pass or fail when layout evidence is unavailable', () => {
    expect(evaluateNoHorizontalOverflow({
      overflowDetected: false,
      offscreenElements: 0,
      layoutLocatorHints: [],
      layoutObservation: 'unavailable',
    })).toEqual({
      assertion: { type: 'noHorizontalOverflow' },
      passed: false,
      measured: false,
      detail: 'Horizontal overflow could not be measured.',
    })
  })

  it('passes only after a clean measurement', () => {
    const result = evaluateNoHorizontalOverflow({
      overflowDetected: false,
      offscreenElements: 0,
      layoutLocatorHints: [],
      layoutObservation: 'measured',
    })
    expect(result.passed).toBe(true)
    expect(result.measured).toBe(true)
  })

  it('fails when overflow is observed', () => {
    const result = evaluateNoHorizontalOverflow({
      overflowDetected: true,
      offscreenElements: 1,
      layoutLocatorHints: ['div:nth-of-type(1)'],
      layoutObservation: 'measured',
    })
    expect(result.passed).toBe(false)
    expect(result.measured).toBe(true)
  })
})
