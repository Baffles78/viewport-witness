import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { observeLayout } from '../src/worker/layout.js'

describe('layout observation failures', () => {
  it('labels evaluation exceptions unavailable', async () => {
    const page = { evaluate: async () => { throw new Error('page closed') } } as unknown as Page
    expect(await observeLayout(page, 20)).toEqual({
      overflowDetected: false,
      offscreenElements: 0,
      layoutObservation: 'unavailable',
    })
  })

  it('labels evaluation timeouts unavailable', async () => {
    const page = { evaluate: () => new Promise<never>(() => {}) } as unknown as Page
    expect(await observeLayout(page, 10)).toEqual({
      overflowDetected: false,
      offscreenElements: 0,
      layoutObservation: 'unavailable',
    })
  })
})
