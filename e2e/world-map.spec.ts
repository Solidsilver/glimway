import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { dialogueState, player, waitForLive, waitForWilds, warp } from './helpers'
import { freshPlayer } from './home-helpers'

/**
 * The world map (docs/design/world-map.md): M or the HUD's Map button opens
 * it full screen, M or Escape closes it once, J goes on to the three-page
 * Journal. Out in the Wilds it opens close up on you and remembers its zoom;
 * it drags, wheels, pinches and takes its keys; you move on it without the
 * land being read again; a manual pan survives the Wilds changing; nothing
 * under it acts. On a 360 px phone the HUD's row and the map's tools fit.
 * SCREENS=1 saves images to .agent/screens/.
 */

type MapState = {
  view: { cx: number; cy: number; scale: number } | null
  vp: { w: number; h: number }
  frame: { minTx: number; minTy: number; maxTx: number; maxTy: number } | null
  hero: { x: number; y: number } | null
  outside: boolean
  loads: number
  draws: number
  cached: number
  result: { scope: string; missing: string | null; offline: boolean; partial: boolean; ended: boolean } | null
}
type Hooks = {
  __fsWorldMap?: () => MapState
  __fsHeld: () => { kind: string; belt: string[] }
  __fsDevPlace: (x: number, y: number) => void
  __fsEmit: (event: string, ...args: unknown[]) => void
  __fsDevParkCreatures: () => number
}

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

const mapState = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsWorldMap?.() ?? null)
const view = async (page: Page) => (await mapState(page))!.view!
const theMap = (page: Page) => page.getByTestId('world-map')
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps

/** Wait for the map to have drawn its first view. */
async function mapReady(page: Page): Promise<MapState> {
  await expect(theMap(page)).toBeVisible()
  await expect.poll(async () => (await mapState(page))?.view !== null && ((await mapState(page))?.draws ?? 0) > 0, { timeout: 15_000 }).toBe(true)
  return (await mapState(page))!
}

test('M and the Map button open it full screen; M and Escape close it once; J goes on to the Journal; chords, repeats and typing don’t', async ({ page }) => {
  test.setTimeout(120_000)
  await freshPlayer(page)
  await waitForLive(page)

  // M: the whole screen, over the HUD (inert under it), focus on the map.
  await page.keyboard.press('m')
  const first = await mapReady(page)
  const box = (await theMap(page).boundingBox())!
  const vw = page.viewportSize()!
  expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, vw.width, vw.height])
  await expect(page.locator('[data-inset="hud"]')).toHaveAttribute('inert', '')
  await expect(page.getByTestId('map-viewport')).toBeFocused()
  // In the village: no dot, a word about it, and nobody to centre on; the Commons gate is where it opens.
  expect(first.outside).toBe(true)
  await expect(page.getByTestId('map-you')).toHaveCount(0)
  await expect(page.getByTestId('map-notes')).toContainText('outside the Wilds')
  await expect(page.getByTestId('map-centre')).toBeDisabled()
  expect(first.view!.scale).toBe(4)
  await shot(page, 'world-map-village-desktop')

  // Escape closes it, and only it (no Menu); focus goes back to nothing, so Space is the world's again.
  await page.keyboard.press('Escape')
  await expect(theMap(page)).toHaveCount(0)
  await expect(page.locator('#menu-title')).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement === null)).toBe(true)

  // The HUD's button opens it; M closes it.
  await page.getByTestId('map-button').click()
  await expect(theMap(page)).toBeVisible()
  await page.keyboard.press('m')
  await expect(theMap(page)).toHaveCount(0)

  // J switches to the Journal: three pages, no Map among them.
  await page.keyboard.press('m')
  await expect(theMap(page)).toBeVisible()
  await page.keyboard.press('j')
  await expect(theMap(page)).toHaveCount(0)
  const tabs = page.getByRole('tablist', { name: 'Journal pages' }).getByRole('tab')
  await expect(tabs).toHaveText(['Quests', 'Papers', 'How do I…?'])
  await page.keyboard.press('Escape')

  // A chord, a held key's repeat and typing never open it.
  await page.keyboard.press('Control+m')
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', repeat: true, bubbles: true })))
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'typing-probe'
    document.body.appendChild(input)
    input.focus()
  })
  await page.keyboard.press('m')
  await page.waitForTimeout(200)
  await expect(theMap(page)).toHaveCount(0)
  await page.evaluate(() => document.getElementById('typing-probe')?.remove())
})

test('out in the Wilds: close up on you, zoom kept between openings, drag, wheel, keys, pinch, show all; you move on it without the land being read again; nothing under it acts', async ({ page }) => {
  test.setTimeout(180_000)
  await freshPlayer(page)
  await warp(page, 'wilds', 12, -60)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as Hooks).__fsDevParkCreatures())
  await waitForLive(page)

  await page.keyboard.press('m')
  let s = await mapReady(page)
  expect(s.outside).toBe(false)
  await expect(page.getByTestId('map-you')).toBeVisible()
  await expect(page.locator('[data-label="you"]')).toBeVisible()
  expect(s.view!.scale).toBe(4)
  expect(Math.abs(s.view!.cx - s.hero!.x)).toBeLessThan(1)
  expect(Math.abs(s.view!.cy - s.hero!.y)).toBeLessThan(1)

  // Two steps in, then close and open again: the zoom is kept, the view centred on you again.
  await page.getByTestId('map-zoom-in').click()
  await page.getByTestId('map-zoom-in').click()
  const kept = (await view(page)).scale
  expect(near(kept, 4 * 2 ** 0.5)).toBe(true)
  await page.keyboard.press('m')
  await expect(theMap(page)).toHaveCount(0)
  await page.keyboard.press('m')
  s = await mapReady(page)
  expect(s.view!.scale).toBe(kept)
  expect(Math.abs(s.view!.cy - s.hero!.y)).toBeLessThan(1)
  await shot(page, 'world-map-wilds-desktop')

  // Drag: the sheet follows the mouse (north–south here; the walked land is narrower than the screen east–west, so it stays in the middle that way).
  const vbox = (await page.getByTestId('map-viewport').boundingBox())!
  const mid = { x: vbox.x + vbox.width / 2, y: vbox.y + vbox.height / 2 }
  let before = await view(page)
  await page.mouse.move(mid.x, mid.y)
  await page.mouse.down()
  await page.mouse.move(mid.x + 30, mid.y + 40, { steps: 4 })
  await page.mouse.move(mid.x + 60, mid.y + 80, { steps: 4 })
  await page.mouse.up()
  let after = await view(page)
  expect(Math.abs(after.cy - (before.cy - 80 / before.scale))).toBeLessThan(0.6)
  expect(after.cx).toBe(before.cx)

  // The Wilds change (a read's news): the map loads again and the pan stays where it was.
  const loads = (await mapState(page))!.loads
  await page.evaluate(() => (window as unknown as Hooks).__fsEmit('ui:wilds', { materials: null }))
  await expect.poll(async () => (await mapState(page))!.loads, { timeout: 5_000 }).toBeGreaterThan(loads)
  await page.waitForTimeout(300)
  const panned = await view(page)
  expect([panned.cx, panned.cy, panned.scale]).toEqual([after.cx, after.cy, after.scale])

  // You move (a correction): the dot follows, the land isn't read or drawn again.
  const settled = (await mapState(page))!
  const dot = (await page.getByTestId('map-you').boundingBox())!
  const at = await player(page)
  await page.evaluate(([x, y]) => (window as unknown as Hooks).__fsDevPlace(x, y), [at.x, at.y + 64] as const)
  await expect.poll(async () => (await page.getByTestId('map-you').boundingBox())!.y - dot.y, { timeout: 3_000 }).toBeGreaterThan(4 * panned.scale - 1)
  const moved = (await mapState(page))!
  expect(moved.loads).toBe(settled.loads)
  expect(moved.draws).toBe(settled.draws)
  // …and the view didn't follow you (only an opening or "centre" does).
  expect((await view(page)).cy).toBe(panned.cy)

  // The wheel: one notch in about the pointer, the world under it stays under it.
  const pointer = { x: mid.x - 100, y: mid.y - 120 }
  before = await view(page)
  const under = before.cy + (pointer.y - vbox.y - s.vp.h / 2) / before.scale
  await page.mouse.move(pointer.x, pointer.y)
  await page.mouse.wheel(0, -100)
  await expect.poll(async () => (await view(page)).scale).toBeGreaterThan(before.scale)
  after = await view(page)
  expect(near(after.scale / before.scale, 2 ** 0.25, 1e-6)).toBe(true)
  const stillUnder = after.cy + (pointer.y - vbox.y - s.vp.h / 2) / after.scale
  expect(Math.abs(stillUnder - under)).toBeLessThan(0.05)

  // Keys on the focused map: arrows pan 48 px (Shift: 144), + and − zoom, End shows all, Home centres on you.
  await page.getByTestId('map-viewport').focus()
  before = await view(page)
  await page.keyboard.press('ArrowDown')
  expect(near((await view(page)).cy, before.cy + 48 / before.scale)).toBe(true)
  await page.keyboard.press('Shift+ArrowUp')
  expect(near((await view(page)).cy, before.cy + (48 - 144) / before.scale)).toBe(true)
  await page.keyboard.press('Minus')
  expect(near((await view(page)).scale, before.scale / 2 ** 0.25)).toBe(true)
  await page.keyboard.press('Equal')
  expect(near((await view(page)).scale, before.scale)).toBe(true)
  await page.keyboard.press('End')
  const all = await view(page)
  expect(all.scale).toBeLessThan(before.scale)
  await expect(page.getByTestId('map-status')).toHaveText(/all the land/)
  await page.keyboard.press('Home')
  const home = await view(page)
  const hero = (await mapState(page))!.hero!
  expect(home.scale).toBe(all.scale)
  expect(Math.abs(home.cy - hero.y) < 1 || home.cy === all.cy).toBe(true)

  // Two fingers (touch pointers): spreading them twice as far doubles the scale about their middle.
  await page.getByTestId('map-zoom-in').click()
  before = await view(page)
  await page.evaluate(({ x, y }) => {
    const el = document.querySelector('[data-testid="map-viewport"]')!
    const ev = (type: string, id: number, px: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: px, clientY: y, bubbles: true, isPrimary: id === 1 }))
    ev('pointerdown', 1, x - 50)
    ev('pointerdown', 2, x + 50)
    for (let i = 1; i <= 5; i++) {
      ev('pointermove', 1, x - 50 - i * 10)
      ev('pointermove', 2, x + 50 + i * 10)
    }
    // One finger lifts: what's left is a drag from where it is, no jump.
    ev('pointerup', 2, x + 100)
    ev('pointermove', 1, x - 100)
    ev('pointerup', 1, x - 100)
  }, mid)
  after = await view(page)
  expect(near(after.scale, Math.min(16, before.scale * 2), 1e-6)).toBe(true)

  // Nothing under the map acts: no walking, no belt change, no ride, no path dialogue.
  const stand = await player(page)
  const held = await page.evaluate(() => (window as unknown as Hooks).__fsHeld().kind)
  await page.getByTestId('map-viewport').focus()
  await page.keyboard.down('ArrowUp')
  await page.waitForTimeout(300)
  await page.keyboard.up('ArrowUp')
  for (const key of ['2', 'v', 'l', 'Space', 'e', 'f']) await page.keyboard.press(key)
  await page.waitForTimeout(300)
  expect(await player(page)).toMatchObject({ x: stand.x, y: stand.y })
  expect(await page.evaluate(() => (window as unknown as Hooks).__fsHeld().kind)).toBe(held)
  await expect(page.getByText(/somewhere to stand at home first/)).toHaveCount(0)
  expect((await dialogueState(page)).open).toBe(false)

  // Details: the ways, the places and the legend as text.
  await page.getByTestId('map-details-toggle').click()
  await expect(page.getByTestId('map-details')).toBeVisible()
  await expect(page.getByTestId('map-details')).toContainText('Legend')
  await shot(page, 'world-map-details-desktop')

  // Escape: back to the world, Space the world's again.
  await page.keyboard.press('Escape')
  await expect(theMap(page)).toHaveCount(0)
  await expect(page.locator('[data-inset="hud"]')).not.toHaveAttribute('inert', '')
  expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement === null)).toBe(true)
})

// A phone's touch and pixel ratio (the project's own browser), on a 360 px screen.
const { defaultBrowserType: _browser, ...phone } = devices['iPhone 13']

test.describe('a 360 px phone', () => {
  test.use({ ...phone, viewport: { width: 360, height: 740 } })

  test('the HUD’s Map button fits beside the others; the map’s tools are 44 px and clear of each other, upright and on its side', async ({ page }) => {
    test.setTimeout(150_000)
    await freshPlayer(page)
    await warp(page, 'wilds', 12, -60)
    await waitForWilds(page)

    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5
    const fits = async (selector: string, min = 44) => {
      const vw = page.viewportSize()!
      const boxes = (await Promise.all((await page.locator(selector).all()).map((l) => l.boundingBox()))).filter((b) => b !== null)
      expect(boxes.length).toBeGreaterThan(0)
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width).toBeLessThanOrEqual(vw.width + 0.5)
        expect(b.y + b.height).toBeLessThanOrEqual(vw.height + 0.5)
        expect(b.width).toBeGreaterThanOrEqual(min)
        expect(b.height).toBeGreaterThanOrEqual(min)
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!), `${selector} ${i} and ${j}`).toBe(false)
    }

    // The HUD's row: Journal, Map, bag, (emote,) menu, all on screen and apart.
    await expect(page.getByTestId('map-button')).toBeVisible()
    await fits('.hud .buttons .hb')
    await shot(page, 'world-map-hud-phone')

    await page.getByTestId('map-button').tap()
    await mapReady(page)
    const box = (await theMap(page).boundingBox())!
    expect([box.width, box.height]).toEqual([360, 740])
    await fits('.world-map .tools button:visible, .world-map .close')
    // The map has the rest of the height.
    const vp = (await page.getByTestId('map-viewport').boundingBox())!
    expect(vp.height).toBeGreaterThan(740 * 0.6)
    await shot(page, 'world-map-phone')

    // Details under the map; the gate's button is in there on a phone; the list scrolls, not the map.
    await page.getByTestId('map-details-toggle').tap()
    await expect(page.getByTestId('map-details')).toBeVisible()
    await expect(page.getByTestId('map-details').getByRole('button', { name: 'Commons gate' })).toBeVisible()
    const details = (await page.getByTestId('map-details').boundingBox())!
    const vpNow = (await page.getByTestId('map-viewport').boundingBox())!
    expect(details.y).toBeGreaterThanOrEqual(vpNow.y + vpNow.height - 0.5)
    expect(await page.getByTestId('map-details').evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')
    await shot(page, 'world-map-details-phone')

    // On its side (a short landscape screen): the tools still clear, the details beside the map.
    await page.setViewportSize({ width: 740, height: 360 })
    await expect.poll(async () => (await page.getByTestId('map-viewport').boundingBox())!.height).toBeGreaterThan(200)
    await fits('.world-map .tools button:visible, .world-map .close')
    // …and clear of the title.
    await fits('.world-map .tools button:visible, .world-map .close, .world-map h2', 0)
    // The map keeps a real share of the width beside the details.
    expect((await page.getByTestId('map-viewport').boundingBox())!.width).toBeGreaterThan(300)
    await shot(page, 'world-map-landscape-phone')
    await page.setViewportSize({ width: 360, height: 740 })
    await page.getByTestId('world-map-close').tap()
    await expect(theMap(page)).toHaveCount(0)
  })
})
