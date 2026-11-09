import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { runAccessibilityCheck } from '../src/worker/accessibility.js'
import { evaluatePageAssertions } from '../src/worker/page-assertions.js'
import { observeLayout } from '../src/worker/layout.js'

describe('accessibility and assertion checks in Chromium', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    // axe-core/playwright requires a page from an explicit context, as in runViewportCheck.
    page = await (await browser.newContext()).newPage()
    await page.setContent(
      '<html lang="en"><head><title>Release notes</title></head><body><main>' +
        '<h1>Hello there</h1><img src="data:," id="hero"><p hidden id="secret">x</p>' +
        '</main></body></html>',
    )
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('reports an image without alt text with a locator hint', async () => {
    const result = await runAccessibilityCheck(page)
    expect(result.completed).toBe(true)
    const imageAlt = result.violations.find((violation) => violation.id === 'image-alt')
    expect(imageAlt?.count).toBe(1)
    expect(imageAlt?.nodes[0]?.html).toBe('[redacted]')
    expect(imageAlt?.nodes[0]?.locator).toContain('img:nth-of-type(1)')
  })

  it('evaluates each read-only assertion type', async () => {
    const layout = await observeLayout(page)
    const results = await evaluatePageAssertions(
      page,
      [
        { type: 'titleIncludes', value: 'Release' },
        { type: 'textVisible', value: 'Hello there' },
        { type: 'selectorExists', selector: '#secret' },
        { type: 'selectorVisible', selector: '#secret' },
        { type: 'noConsoleErrors' },
        { type: 'noHorizontalOverflow' },
      ],
      layout,
      ['one error'],
    )
    expect(results?.map((result) => result.passed)).toEqual([true, true, true, false, false, true])
    expect(results?.[4]?.detail).toBe('1 console error(s) observed.')
  })

  it('returns undefined when no assertions were requested', async () => {
    expect(await evaluatePageAssertions(page, [], await observeLayout(page), [])).toBeUndefined()
  })
})
