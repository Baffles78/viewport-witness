import type { Page } from 'playwright'

export interface LayoutObservation {
  overflowDetected: boolean
  offscreenElements: number
  layoutObservation: 'measured' | 'unavailable'
}

export async function observeLayout(page: Page, timeoutMs = 5_000): Promise<LayoutObservation> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('layout_timeout')), timeoutMs)
    })
    const result = await Promise.race([
      page.evaluate(() => {
        const overflow = document.body.scrollWidth > window.innerWidth
        const allElements = Array.from(document.querySelectorAll('*'))
        const offscreen = allElements.filter((el) => {
          const rect = el.getBoundingClientRect()
          return rect.right > window.innerWidth * 1.2 && rect.width > 10
        }).length
        return { overflow, offscreen }
      }),
      timeout,
    ])
    return {
      overflowDetected: result.overflow,
      offscreenElements: result.offscreen,
      layoutObservation: 'measured',
    }
  } catch {
    return { overflowDetected: false, offscreenElements: 0, layoutObservation: 'unavailable' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
