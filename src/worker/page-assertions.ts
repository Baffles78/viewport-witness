import type { Page } from 'playwright'
import type { AssertionResult, PageAssertion } from '../types.js'
import { evaluateNoHorizontalOverflow, type LayoutObservation } from './layout.js'
import { withTimeout } from './timeout.js'

// Declarative, read-only assertions. These only inspect the loaded DOM and
// observations already collected; they never click, type, or submit.
export async function evaluatePageAssertions(
  page: Page,
  assertions: PageAssertion[],
  layoutData: LayoutObservation,
  consoleErrors: string[],
): Promise<AssertionResult[] | undefined> {
  if (assertions.length === 0) return undefined
  const assertionResults: AssertionResult[] = []
  for (const assertion of assertions) {
    try {
      let passed = false
      let detail = ''
      if (assertion.type === 'noHorizontalOverflow') {
        assertionResults.push(evaluateNoHorizontalOverflow(layoutData))
        continue
      } else if (assertion.type === 'noConsoleErrors') {
        passed = consoleErrors.length === 0
        detail = passed
          ? 'No console errors observed.'
          : `${consoleErrors.length} console error(s) observed.`
      } else if (assertion.type === 'titleIncludes') {
        passed = await withTimeout(
          page.evaluate((value) => document.title.includes(value), assertion.value),
          2_000,
          'assertion_timeout',
        )
        detail = passed
          ? 'Page title contains the expected text.'
          : 'Expected title text not found.'
      } else if (assertion.type === 'textVisible') {
        passed = await withTimeout(
          page.evaluate(
            (value) => (document.body?.innerText ?? '').includes(value),
            assertion.value,
          ),
          2_000,
          'assertion_timeout',
        )
        detail = passed ? 'Expected visible text found.' : 'Expected visible text not found.'
      } else {
        const found = await withTimeout(
          page.evaluate((selector) => {
            const element = document.querySelector(selector)
            if (!element) return { exists: false, visible: false }
            const rect = element.getBoundingClientRect()
            const style = window.getComputedStyle(element)
            return {
              exists: true,
              visible:
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0',
            }
          }, assertion.selector),
          2_000,
          'assertion_timeout',
        )
        passed = assertion.type === 'selectorExists' ? found.exists : found.visible
        detail = passed
          ? assertion.type === 'selectorExists'
            ? 'Selector exists.'
            : 'Selector is visible.'
          : assertion.type === 'selectorExists'
            ? 'Selector not found.'
            : 'Selector not found or not visible.'
      }
      assertionResults.push({ assertion, passed, detail })
    } catch {
      assertionResults.push({
        assertion,
        passed: false,
        detail: 'Assertion could not be evaluated.',
      })
    }
  }
  return assertionResults
}
