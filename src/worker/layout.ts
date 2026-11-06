import type { Page } from 'playwright'
import type { AssertionResult } from '../types.js'

export interface LayoutObservation {
  overflowDetected: boolean
  offscreenElements: number
  layoutLocatorHints: string[]
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
          })
          const locatorFor = (element: Element): string => {
            const parts: string[] = []
            let current: Element | null = element
            while (current && parts.length < 5 && current !== document.documentElement) {
              const tag = current.tagName.toLowerCase()
              const siblings = current.parentElement
                ? Array.from(current.parentElement.children).filter(
                    (sibling) => sibling.tagName === current?.tagName,
                  )
                : []
              const position = Math.max(1, siblings.indexOf(current) + 1)
              parts.unshift(`${tag}:nth-of-type(${position})`)
              current = current.parentElement
            }
            return parts.join(' > ').slice(0, 200)
          }
          return {
            overflow,
            offscreen: offscreen.length,
            locators: offscreen.slice(0, 5).map(locatorFor),
          }
        }),
      timeout,
    ])
    return {
      overflowDetected: result.overflow,
      offscreenElements: result.offscreen,
      layoutLocatorHints: result.locators,
      layoutObservation: 'measured',
    }
  } catch {
    return {
      overflowDetected: false,
      offscreenElements: 0,
      layoutLocatorHints: [],
      layoutObservation: 'unavailable',
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function evaluateNoHorizontalOverflow(layout: LayoutObservation): AssertionResult {
  if (layout.layoutObservation !== 'measured') {
    return {
      assertion: { type: 'noHorizontalOverflow' },
      passed: false,
      measured: false,
      detail: 'Horizontal overflow could not be measured.',
    }
  }
  return {
    assertion: { type: 'noHorizontalOverflow' },
    passed: !layout.overflowDetected,
    measured: true,
    detail: layout.overflowDetected
      ? 'Horizontal overflow detected.'
      : 'No horizontal overflow detected.',
  }
}
