import { expect, test, type Page } from './fixtures'
import { frames, openTalk, readDialogue, settled, warp } from './helpers'

/**
 * On a phone the camera keeps the hero clear of the HUD and the touch
 * controls, even at a map's corners, where the camera used to stop at the
 * map's edge and walk the hero under a card or a thumb.
 */
type Box = { x: number; y: number; width: number; height: number }

const phones = [
  ['portrait', { width: 390, height: 844 }],
  ['landscape', { width: 844, height: 390 }]
] as const

const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Everything the interface draws over the world while walking: the HUD's parts and the controls' pad and buttons. */
async function obstacles(page: Page): Promise<{ name: string; box: Box }[]> {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll<HTMLElement>('.hud > *, .controls .pad, .controls button')]
    return els
      .filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden')
      .map((e) => {
        const r = e.getBoundingClientRect()
        return { name: `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`, box: { x: r.x, y: r.y, width: r.width, height: r.height } }
      })
      .filter((o) => o.box.width > 0 && o.box.height > 0)
  })
}

/** The hero's box on the page (the canvas fills the stage from the top left). */
async function heroBox(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const h = (window as unknown as { __fsDevHeroScreen: () => { x: number; y: number; w: number; h: number } }).__fsDevHeroScreen()
    const c = document.querySelector('canvas')!.getBoundingClientRect()
    return { x: c.x + h.x, y: c.y + h.y, width: h.w, height: h.h }
  })
}

/**
 * The screen insets the camera keeps clear. Until the App measures them
 * itself (it calls setPlayInsets), set them here from the same boxes:
 * the HUD along the top, and the controls along the bottom (portrait) or
 * the sides (landscape: the stick bottom left, the buttons bottom right).
 */
async function ensureInsets(page: Page): Promise<void> {
  const set = await page.evaluate(() => {
    const vw = innerWidth
    const vh = innerHeight
    const rect = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect())
    const hud = rect('.hud > *')
    const pad = rect('.controls .pad')
    const buttons = rect('.controls button')
    const top = Math.max(0, ...hud.map((r) => r.bottom))
    const ctl = [...pad, ...buttons]
    const portrait = vh > vw
    const insets = portrait
      ? { top, bottom: vh - Math.min(vh, ...ctl.map((r) => r.top)), left: 0, right: 0 }
      : { top, bottom: 0, left: Math.max(0, ...pad.map((r) => r.right)), right: vw - Math.min(vw, ...buttons.map((r) => r.left)) }
    const w = window as unknown as { __fsDevInsets: (v: typeof insets) => void }
    w.__fsDevInsets(insets)
    return insets
  })
  test.info().annotations.push({ type: 'insets', description: JSON.stringify(set) })
}

for (const [name, viewport] of phones) {
  test(`phone ${name}: the hero stays clear of the HUD and the controls at map corners`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    const origin = new URL(baseURL!).host
    await context.route((url) => url.host === origin && url.pathname.startsWith('/api/'), (r) => r.abort('internetdisconnected'))
    const page = await context.newPage()
    await page.goto('/')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.getByRole('button', { name: /Wander as a guest/ }).tap()
    await settled(page, { area: 'village' })
    await warp(page, 'village', 16, 14)
    await expect(page.locator('.controls')).toBeVisible()
    // The App writes the insets itself once it measures the HUD and controls.
    const appMeasures = await page.evaluate(() => {
      const v = (window as unknown as { __fsDevInsets: () => { top: number; bottom: number; left: number; right: number } }).__fsDevInsets()
      return v.top + v.bottom + v.left + v.right > 0
    })
    if (!appMeasures) await ensureInsets(page)

    const map = await page.evaluate(() => (window as unknown as { __fsWorld: () => { widthPx: number; heightPx: number } }).__fsWorld())
    const cols = Math.floor(map.widthPx / 16)
    const rows = Math.floor(map.heightPx / 16)
    const spots: [string, number, number][] = [
      ['village', 1, 1],
      ['village', cols - 2, 1],
      ['village', 1, rows - 2],
      ['village', cols - 2, rows - 2],
      ['ruin', 15, 3]
    ]
    for (const [area, tx, ty] of spots) {
      await warp(page, area, tx, ty)
      await page.waitForFunction(() => (window as unknown as { __fsBanners: () => { current: unknown } }).__fsBanners().current === null, undefined, { timeout: 15_000 })
      await frames(page, 45) // the camera's follow eases in
      if (!appMeasures) await ensureInsets(page)
      await frames(page, 45)
      const hero = await heroBox(page)
      for (const o of await obstacles(page)) {
        expect(overlap(hero, o.box), `${area} (${tx},${ty}): the hero ${JSON.stringify(hero)} is under ${o.name} ${JSON.stringify(o.box)}`).toBe(false)
      }
    }
    expect(errors, 'uncaught page errors').toEqual([])
    await context.close()
  })
}

for (const [name, viewport] of phones) {
  test(`phone ${name}: a conversation doesn't move the camera`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    const origin = new URL(baseURL!).host
    await context.route((url) => url.host === origin && url.pathname.startsWith('/api/'), (r) => r.abort('internetdisconnected'))
    const page = await context.newPage()
    await page.goto('/')
    await page.getByRole('button', { name: /Wander as a guest/ }).tap()
    await settled(page, { area: 'village' })
    // Mara, by the well: the conversation hides the touch controls (and, under
    // the old measuring, dropped their insets and slid the world aside).
    await warp(page, 'village', 16, 14)
    await page.waitForFunction(() => (window as unknown as { __fsBanners: () => { current: unknown } }).__fsBanners().current === null, undefined, { timeout: 15_000 })
    await frames(page, 60)
    const insets = () => page.evaluate(() => (window as unknown as { __fsDevInsets: () => { top: number; bottom: number; left: number; right: number; rev: number } }).__fsDevInsets())
    const before = await insets()
    const heroBefore = await heroBox(page)
    expect(before.top, 'the App measures the HUD').toBeGreaterThan(0)
    await openTalk(page, /Talk to Mara/)
    await frames(page, 60)
    expect(await insets(), 'insets while talking').toEqual(before)
    const heroDuring = await heroBox(page)
    expect(Math.abs(heroDuring.x - heroBefore.x), 'the hero stays put sideways').toBeLessThanOrEqual(1)
    expect(Math.abs(heroDuring.y - heroBefore.y), 'the hero stays put up and down').toBeLessThanOrEqual(1)
    await readDialogue(page)
    await frames(page, 30)
    expect(await insets(), 'insets after talking').toEqual(before)
    await context.close()
  })
}
