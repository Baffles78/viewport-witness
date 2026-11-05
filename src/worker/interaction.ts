import type { Page } from 'playwright'

export interface InteractionObservation {
  visible: number
  focusable: number
  anyFocusable: boolean
}

/**
 * Read-only DOM heuristic. It does not perform Tab traversal or keyboard activation.
 */
export async function observeInteraction(page: Page): Promise<InteractionObservation> {
  return page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]'),
    )
    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      )
    }
    const visible = controls.filter(isVisible).length
    const candidates = new Set([
      ...controls,
      ...Array.from(document.querySelectorAll('[tabindex]')),
    ])
    const focusable = Array.from(candidates).filter((el) => {
      return (
        isVisible(el) &&
        (el as HTMLElement).tabIndex >= 0 &&
        !el.matches(':disabled') &&
        !el.closest('[inert]') &&
        el.getAttribute('aria-disabled') !== 'true'
      )
    }).length

    return { visible, focusable, anyFocusable: focusable > 0 }
  })
}
