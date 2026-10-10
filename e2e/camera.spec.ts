import { expect, test, type Page } from './fixtures'
import { frames, openTalk, player, readDialogue, waitForLive, warp } from './helpers'
import { freshPlayer } from './home-helpers'

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
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await freshPlayer(page)
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
    const page = await context.newPage()
    await freshPlayer(page)
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

/**
 * The canvas renders at the device pixel ratio (src/game/main.ts): every
 * screen pixel, the same stretch of world, and input still lands where it
 * should.
 */
test('phone at 3×: the canvas has every device pixel and frames the world as at 1×', async ({ browser, baseURL }) => {
  const look = async (deviceScaleFactor: number) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor })
    const page = await context.newPage()
    await freshPlayer(page)
    await warp(page, 'village', 16, 14)
    await page.waitForFunction(() => (window as unknown as { __fsBanners: () => { current: unknown } }).__fsBanners().current === null, undefined, { timeout: 15_000 })
    await frames(page, 60)
    const canvas = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.stage canvas')!
      const r = c.getBoundingClientRect()
      return { px: [c.width, c.height], css: [r.width, r.height] }
    })
    const zoom = await page.evaluate(() => (window as unknown as { __fsDevHeroScreen: () => { zoom: number } }).__fsDevHeroScreen().zoom)
    const hero = await heroBox(page)
    await context.close()
    return { canvas, zoom, hero }
  }
  const one = await look(1)
  const three = await look(3)
  expect(one.canvas.px, 'at 1×: CSS px').toEqual(one.canvas.css)
  expect(three.canvas.css, 'the same box on the page').toEqual(one.canvas.css)
  expect(three.canvas.px, 'at 3×: every device pixel').toEqual(one.canvas.css.map((n) => Math.round(n * 3)))
  expect(three.zoom, '2 CSS px a world px either way').toBe(one.zoom)
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(three.hero[k] - one.hero[k]), `the hero's ${k} on the page`).toBeLessThanOrEqual(2)
})

test('desktop at 2×: the pointer lands on the world point under it', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await freshPlayer(page)
  const px = await page.evaluate(() => document.querySelector<HTMLCanvasElement>('.stage canvas')!.width)
  expect(px, 'the canvas at 2×').toBe(2560)
  const box = (await page.locator('.stage canvas').boundingBox())!
  for (const [wx, wy] of [[16 * 16 + 8, 14 * 16 + 8], [20 * 16, 12 * 16]] as const) {
    const at = await page.evaluate(([x, y]) => (window as unknown as { __fsDevToScreen: (x: number, y: number) => { x: number; y: number } }).__fsDevToScreen(x, y), [wx, wy] as const)
    await page.mouse.move(box.x + at.x, box.y + at.y)
    await frames(page, 2)
    const under = await page.evaluate(() => (window as unknown as { __fsDevPointerWorld: () => { x: number; y: number } }).__fsDevPointerWorld())
    expect(Math.abs(under.x - wx), `x under the pointer at ${wx},${wy}`).toBeLessThanOrEqual(0.5)
    expect(Math.abs(under.y - wy), `y under the pointer at ${wx},${wy}`).toBeLessThanOrEqual(0.5)
  }
  await context.close()
})

/** A player on a 390×844 touch phone at `deviceScaleFactor`, standing in the village square, past the title card. */
async function phonePlayer(browser: import('@playwright/test').Browser, baseURL: string, deviceScaleFactor: number, stick?: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (stick) await page.addInitScript((s) => localStorage.setItem('fingersnap:settings', JSON.stringify({ stick: s })), stick)
  await freshPlayer(page)
  await warp(page, 'village', 16, 14)
  await page.waitForFunction(() => (window as unknown as { __fsBanners: () => { current: unknown } }).__fsBanners().current === null, undefined, { timeout: 15_000 })
  await waitForLive(page)
  await frames(page, 60)
  return { context, page, errors }
}

/** The canvas: its size in px and its box on the page (CSS px), and the camera's zoom in CSS px. */
async function canvasNow(page: Page): Promise<{ px: number[]; css: number[]; zoom: number }> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.stage canvas')!
    const r = c.getBoundingClientRect()
    const zoom = (window as unknown as { __fsDevHeroScreen: () => { zoom: number } }).__fsDevHeroScreen().zoom
    return { px: [c.width, c.height], css: [r.width, r.height], zoom }
  })
}

const textureBytes = (page: Page) => page.evaluate(() => (window as unknown as { __fsDevTextureMemory: () => { total: number } }).__fsDevTextureMemory().total)
const insetsNow = (page: Page) => page.evaluate(() => {
  const { rev: _rev, ...v } = (window as unknown as { __fsDevInsets: () => { top: number; right: number; bottom: number; left: number; rev: number } }).__fsDevInsets()
  return v
})

test('phone: a device pixel ratio change mid-game refits the canvas and keeps the framing and the textures', async ({ browser, baseURL }) => {
  const { context, page, errors } = await phonePlayer(browser, baseURL!, 2)
  const before = await canvasNow(page)
  expect(before.px, 'at 2×').toEqual([780, 1688])
  const hero = await heroBox(page)
  const insets = await insetsNow(page)
  const bytes = await textureBytes(page)
  // The window moves to a 3× screen (the same CSS size), then to a 1× one.
  const cdp = await context.newCDPSession(page)
  for (const dpr of [3, 1]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: dpr, mobile: true })
    await expect.poll(async () => (await canvasNow(page)).px, { message: `the canvas at ${dpr}×` }).toEqual([390 * dpr, 844 * dpr])
    await frames(page, 30)
    const now = await canvasNow(page)
    expect(now.css, 'the same box on the page').toEqual(before.css)
    expect(now.zoom, '2 CSS px a world px').toBe(before.zoom)
    expect(await insetsNow(page), 'the insets, in CSS px').toEqual(insets)
    // The hero where they were on the page. Not to the pixel: Phaser floors
    // the camera's scroll every frame (roundPixels), so a follow easing in
    // from above or the left stops up to ~8 world px short (0.12 of the gap
    // under 1 px), and a refit can land it anywhere in that band.
    const off = async () => {
      const at = await heroBox(page)
      return { size: Math.max(Math.abs(at.width - hero.width), Math.abs(at.height - hero.height)), at: Math.max(Math.abs(at.x - hero.x), Math.abs(at.y - hero.y)) }
    }
    await expect.poll(async () => (await off()).at, { message: `${dpr}×: the hero near where they were on the page (CSS px off)` }).toBeLessThanOrEqual(8.5 * before.zoom)
    expect((await off()).size, `${dpr}×: the hero's size on the page`).toBeLessThanOrEqual(1)
    expect(await textureBytes(page), `${dpr}×: the textures built at boot, no more and no fewer`).toBe(bytes)
  }
  expect(errors, 'uncaught page errors').toEqual([])
  await context.close()
})

/** Touch input as a phone sends it (Chromium turns it into pointer events). */
async function fingers(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
  return { down: (x: number, y: number) => send('touchStart', x, y), up: () => send('touchEnd') }
}

test('phone at 3×, turned to landscape: the same framing, the hero clear of the interface, and touch still walks', async ({ browser, baseURL }) => {
  const { context, page, errors } = await phonePlayer(browser, baseURL!, 3, 'hold')
  const portrait = await canvasNow(page)
  expect(portrait.px).toEqual([1170, 2532])
  await page.setViewportSize({ width: 844, height: 390 })
  await expect.poll(async () => (await canvasNow(page)).px, { message: 'the canvas turned' }).toEqual([2532, 1170])
  await expect.poll(async () => (await insetsNow(page)).left + (await insetsNow(page)).right, { message: 'the controls measured at the sides' }).toBeGreaterThan(0)
  await frames(page, 60) // the camera's follow eases in
  const landscape = await canvasNow(page)
  expect(landscape.css).toEqual([844, 390])
  expect(landscape.zoom, '2 CSS px a world px either way up').toBe(portrait.zoom)
  // On screen, and under no part of the interface.
  const hero = await heroBox(page)
  expect(hero.x).toBeGreaterThanOrEqual(0)
  expect(hero.y).toBeGreaterThanOrEqual(0)
  expect(hero.x + hero.width).toBeLessThanOrEqual(844)
  expect(hero.y + hero.height).toBeLessThanOrEqual(390)
  for (const o of await obstacles(page)) expect(overlap(hero, o.box), `the hero ${JSON.stringify(hero)} is under ${o.name} ${JSON.stringify(o.box)}`).toBe(false)
  // Hold to walk: a finger right of the hero, and the hero heads for it.
  const start = await player(page)
  const f = await fingers(page)
  await f.down(hero.x + hero.width / 2 + 120, hero.y + hero.height / 2)
  await expect.poll(async () => (await player(page)).x - start.x, { message: 'the hero walks toward the finger' }).toBeGreaterThan(12)
  await f.up()
  expect(Math.abs((await player(page)).y - start.y), 'straight toward it').toBeLessThan(8)
  expect(errors, 'uncaught page errors').toEqual([])
  await context.close()
})

test('a 1× screen: the camera pans on whole canvas pixels, so the pixel art holds still while it moves', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await freshPlayer(page)
  await warp(page, 'village', 16, 18)
  await waitForLive(page)
  const camera = () => page.evaluate(() => (window as unknown as { __fsDevCamera: () => { scrollX: number; scrollY: number; zoom: number; originX: number; originY: number } }).__fsDevCamera())
  const samples: Awaited<ReturnType<typeof camera>>[] = []
  // Walk right and down a little: the follow eases the camera after the hero.
  await page.keyboard.down('d')
  await page.keyboard.down('s')
  for (let i = 0; i < 24; i++) {
    await frames(page, 2)
    samples.push(await camera())
  }
  await page.keyboard.up('s')
  await page.keyboard.up('d')
  expect(new Set(samples.map((c) => c.scrollX)).size, 'the camera panned').toBeGreaterThan(3)
  for (const c of samples) {
    const x = (c.scrollX + c.originX) * c.zoom
    const y = (c.scrollY + c.originY) * c.zoom
    expect(Math.abs(x - Math.round(x)), `x at zoom ${c.zoom}`).toBeLessThan(1e-6)
    expect(Math.abs(y - Math.round(y)), `y at zoom ${c.zoom}`).toBeLessThan(1e-6)
  }
  await context.close()
})
