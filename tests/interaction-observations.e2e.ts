import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { observeInteraction } from '../src/worker/interaction.js'
import { observeLayout, evaluateNoHorizontalOverflow } from '../src/worker/layout.js'

describe('interaction observations in Chromium', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser?.close()
  })

  const cases = [
    ['disabled button', '<button disabled>Disabled</button>', 1, 0],
    ['disabled fieldset control', '<fieldset disabled><input></fieldset>', 1, 0],
    ['inert ancestor', '<div inert><button>Inert</button></div>', 1, 0],
    ['hidden control', '<button hidden>Hidden</button>', 0, 0],
    ['negative tab index', '<button tabindex="-1">Skipped</button>', 1, 0],
    ['aria disabled button', '<button aria-disabled="true">Unavailable</button>', 1, 0],
    ['enabled button', '<button>Enabled</button>', 1, 1],
    ['native link', '<a href="/next">Next</a>', 1, 1],
    ['custom tab stop', '<div tabindex="0">Focusable</div>', 0, 1],
    ['button with tab index counted once', '<button tabindex="0">Once</button>', 1, 1],
    ['role button without tab stop', '<div role="button">No tab stop</div>', 1, 0],
  ] as const

  for (const [name, html, visible, focusable] of cases) {
    it(name, async () => {
      await page.setContent('<!doctype html><html><body>' + html + '</body></html>')
      const result = await observeInteraction(page)
      expect(result.visible).toBe(visible)
      expect(result.focusable).toBe(focusable)
      expect(result.anyFocusable).toBe(focusable > 0)
    })
  }

  it('does not claim an enabled button can be activated', async () => {
    await page.setContent('<button id="target">Enabled</button>')
    const result = await observeInteraction(page)
    expect(result.anyFocusable).toBe(true)
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('target')
  })
  it('records measured overflow and offscreen elements', async () => {
    await page.setContent('<!doctype html><html><body><div style="position:absolute;left:2000px;width:100px;height:20px">Offscreen</div></body></html>')
    const result = await observeLayout(page)
    expect(result.layoutObservation).toBe('measured')
    expect(result.offscreenElements).toBeGreaterThan(0)
  })

  it('records in-flow horizontal overflow', async () => {
    await page.setContent('<!doctype html><html><body style="margin:0"><div style="width:2000px;height:20px">Wide</div></body></html>')
    const result = await observeLayout(page)
    expect(result.layoutObservation).toBe('measured')
    expect(result.overflowDetected).toBe(true)
  })

  it.each([
    [375, 812],
    [812, 375],
    [1440, 900],
  ])('records root-only overflow at %i x %i', async (width, height) => {
    const originalViewport = page.viewportSize()!
    try {
      await page.setViewportSize({ width, height })
      await page.setContent('<!doctype html><html><head><style>html{min-width:calc(100vw + 60px)}body{width:100vw;margin:0}</style></head><body><main>Root overflow</main></body></html>')
      const dimensions = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        root: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }))
      expect(dimensions.body).toBe(dimensions.viewport)
      expect(dimensions.root).toBe(dimensions.viewport + 60)
      const result = await observeLayout(page)
      expect(result.layoutObservation).toBe('measured')
      expect(result.offscreenElements).toBe(0)
      expect(result.overflowDetected).toBe(true)
      expect(evaluateNoHorizontalOverflow(result).passed).toBe(false)
    } finally {
      await page.setViewportSize(originalViewport)
    }
  })

  it('records a measured clean layout', async () => {
    await page.setContent('<!doctype html><html><body><main>In view</main></body></html>')
    const result = await observeLayout(page)
    expect(result).toEqual({
      overflowDetected: false,
      offscreenElements: 0,
      layoutLocatorHints: [],
      layoutObservation: 'measured',
    })
  })

})
