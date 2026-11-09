import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from 'playwright'
import type { AccessibilityViolation, ViewportResult } from '../types.js'
import { withTimeout } from './timeout.js'

// Runs axe on the loaded page. Returns completed: false if axe fails or times out.
export async function runAccessibilityCheck(page: Page): Promise<ViewportResult['accessibility']> {
  let accessibilityResult: ViewportResult['accessibility'] = {
    completed: false,
    violations: [],
    passes: 0,
    incomplete: 0,
    impact: {},
  }

  try {
    const axeResults = await withTimeout(
      new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'])
        .analyze(),
      10_000,
      'accessibility_timeout',
    )

    let remainingLocatorHints = 20
    const violations: AccessibilityViolation[] = await Promise.all(
      axeResults.violations.slice(0, 50).map(async (v) => ({
        id: v.id,
        impact: (v.impact as AccessibilityViolation['impact']) ?? null,
        description: v.description,
        helpUrl: v.helpUrl,
        nodes: await Promise.all(
          v.nodes.slice(0, 5).map(async (n) => {
            let locator: string | undefined
            const target = n.target[0]
            if (typeof target === 'string' && remainingLocatorHints > 0) {
              remainingLocatorHints--
              try {
                locator = await page
                  .locator(target)
                  .first()
                  .evaluate((element) => {
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
                  })
              } catch {
                // Keep the finding without a locator if the node cannot be resolved.
              }
            }
            return {
              html: '[redacted]',
              failureSummary: n.failureSummary?.slice(0, 500) ?? '',
              ...(locator ? { locator } : {}),
            }
          }),
        ),
        count: v.nodes.length,
      })),
    )

    const impactCounts: Record<string, number> = {}
    for (const v of violations) {
      if (v.impact) {
        impactCounts[v.impact] = (impactCounts[v.impact] ?? 0) + 1
      }
    }

    accessibilityResult = {
      completed: true,
      violations,
      passes: axeResults.passes.length,
      incomplete: axeResults.incomplete.length,
      impact: impactCounts,
    }
  } catch {
    // axe failed - record as inconclusive
  }
  return accessibilityResult
}
