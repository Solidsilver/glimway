import { writeFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { test } from './fixtures'
import type { Page } from './fixtures'
import { hold, warp } from './helpers'
import { freshPlayer, giveInstance } from './home-helpers'

/**
 * Screens for the playtest-1 art pass review (.agent/screens/<ART_TAG>-*.png):
 * the village square, the Commons lane, a road meeting grass, the water's
 * edge and Mara close up, on a 1280×800 desktop and a 390×844 touch phone,
 * plus the texture memory after both areas. With ART_TAG=after (the walking
 * art) also Mara walking each way, Hazel on the bench and the hero holding
 * the bench axe facing left and right. SCREENS=1 only.
 */
test.skip(!process.env.SCREENS, 'screenshots only (SCREENS=1)')

const OUT = '.agent/screens'
const TAG = process.env.ART_TAG ?? 'now'
const { defaultBrowserType: _browser, ...IPHONE } = devices['iPhone 13']
const PHONE = { ...IPHONE, viewport: { width: 390, height: 844 } }

async function snap(page: Page, name: string, device: string): Promise<void> {
  // Past the area's title card.
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/${TAG}-${name}-${device}.png` })
}

/** A crop around a world point (CSS px). */
async function closeUp(page: Page, name: string, device: string, x: number, y: number, half: number, wait = 900): Promise<void> {
  await page.waitForTimeout(wait)
  const p = await page.evaluate(([wx, wy]) => (window as unknown as { __fsDevToScreen: (x: number, y: number) => { x: number; y: number } }).__fsDevToScreen(wx, wy), [x, y] as const)
  const box = (await page.locator('canvas').first().boundingBox())!
  const w = Math.min(half * 2, box.width)
  const h = Math.min(half * 2, box.height)
  const cx = Math.max(box.x, Math.min(box.x + box.width - w, box.x + p.x - w / 2))
  const cy = Math.max(box.y, Math.min(box.y + box.height - h, box.y + p.y - h / 2))
  await page.screenshot({ path: `${OUT}/${TAG}-${name}-${device}.png`, clip: { x: cx, y: cy, width: w, height: h } })
}

async function outdoorScreens(page: Page, device: string): Promise<void> {
  // The village square: Mara by the well, the cottages around it.
  await warp(page, 'village', 17, 15)
  await snap(page, 'village-square', device)
  await closeUp(page, 'mara', device, 16 * 16 + 8, 13 * 16 + 2, 80)
  // The pond's edge, east of the mill.
  await warp(page, 'village', 36, 17)
  await snap(page, 'water-edge', device)
  // The Commons lane and its square.
  await warp(page, 'commons', 23, 19)
  await snap(page, 'commons-lane', device)
  // Where the cross lane's cobbles meet the grass.
  await warp(page, 'commons', 9, 17)
  await snap(page, 'road-grass', device)
  await closeUp(page, 'road-grass-zoom', device, 9 * 16 + 8, 18 * 16, 140, 300)
  // Texture memory after the village and the Commons (the GPU's RGBA bytes).
  const mem = await page.evaluate(() => (window as unknown as { __fsDevTextureMemory: () => unknown }).__fsDevTextureMemory())
  writeFileSync(`${OUT}/${TAG}-memory-${device}.json`, JSON.stringify(mem, null, 1))
}

type NpcPose = { id: string; x: number; y: number; facing: string; mode: string; frame: string }
const npc = (page: Page, id: string) => page.evaluate((who) => ((window as unknown as { __fsNpcs: () => NpcPose[] }).__fsNpcs() ?? []).find((n) => n.id === who) ?? null, id)

/** Mara on her loop by the well (watched from where she won't come home), then Hazel on the bench. */
async function residentScreens(page: Page, device: string): Promise<void> {
  await warp(page, 'village', 16, 19)
  for (const dir of ['right', 'up', 'left', 'down']) {
    await page.waitForFunction((d) => {
      const m = ((window as unknown as { __fsNpcs: () => NpcPose[] }).__fsNpcs() ?? []).find((n) => n.id === 'mara')
      return !!m && m.mode === 'walk' && m.facing === d
    }, dir, { timeout: 30_000 })
    const m = (await npc(page, 'mara'))!
    await closeUp(page, `mara-walk-${dir}`, device, m.x, m.y - 10, 50, 0)
  }
  await warp(page, 'village', 4, 19)
  await page.waitForFunction(() => ((window as unknown as { __fsNpcs: () => NpcPose[] }).__fsNpcs() ?? []).some((n) => n.id === 'hazel' && n.mode === 'sit'), undefined, { timeout: 40_000 })
  await closeUp(page, 'hazel-seated', device, 9 * 16 + 8, 13 * 16 + 4, 70, 300)
}

test.describe('after: residents', () => {
  test.skip(TAG !== 'after', 'the walking art only')
  test('desktop', async ({ page }) => {
    test.setTimeout(150_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await freshPlayer(page)
    await residentScreens(page, 'desktop')
  })
})

test.describe('after: residents, phone', () => {
  test.skip(TAG !== 'after', 'the walking art only')
  test.use(PHONE)
  test('phone', async ({ page }) => {
    test.setTimeout(150_000)
    await freshPlayer(page)
    await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
    await residentScreens(page, 'phone')
  })
})

test.describe('after: the hero holding the axe', () => {
  test.skip(TAG !== 'after', 'the walking art only')
  test.use({ viewport: { width: 1280, height: 800 } })
  test('facing left and right', async ({ page }) => {
    test.setTimeout(150_000)
    const id = await freshPlayer(page, 'Teo')
    giveInstance(id, 'bench-axe', { max: 90 })
    await page.evaluate(() => (window as unknown as { __fsItems: { load: () => Promise<unknown> } }).__fsItems.load())
    await warp(page, 'village', 30, 12)
    await page.waitForTimeout(3000)
    await page.keyboard.press('2')
    for (const [key, dir] of [['ArrowLeft', 'left'], ['ArrowRight', 'right'], ['ArrowUp', 'up'], ['ArrowDown', 'down']] as const) {
      await hold(page, key, 350)
      await page.waitForFunction((d) => (window as unknown as { __fsDebug: () => { holdingFrame: string } }).__fsDebug().holdingFrame.endsWith(`-${d}`), dir, { timeout: 10_000 })
      const p = await page.evaluate(() => (window as unknown as { __fsPlayer: () => { x: number; y: number } }).__fsPlayer())
      await closeUp(page, `hero-axe-${dir}`, 'desktop', p.x, p.y - 10, 50, 400)
    }
  })
})

/** Round 3: the village houses, the hero behind a roof, the footbridge worn and mended, the pond. */
async function round3Screens(page: Page, device: string): Promise<void> {
  await warp(page, 'village', 20, 10)
  await snap(page, 'r3-village-houses', device)
  // Behind the middle house's roof, which rises two tiles over its footprint
  // (at its east eave, so half the hero shows).
  await warp(page, 'village', 22, 2)
  await closeUp(page, 'r3-behind-roof', device, 22 * 16 + 8, 3 * 16, 70, 2500)
  // Ada's house, with her window's lamp lit (the window-fund project) where the window is.
  await page.evaluate(() => (window as unknown as { __fsDevWorldFlag: (f: string) => void }).__fsDevWorldFlag('project:cooley-window-fund:complete'))
  await warp(page, 'village', 34, 10)
  await closeUp(page, 'r3-ada-house', device, 34 * 16, 6 * 16, 90, 2500)
  // The pond.
  await warp(page, 'village', 36, 17)
  await closeUp(page, 'r3-pond', device, 36 * 16, 20 * 16, 110, 2500)
  // The Brackenwood footbridge: worn, then mended once the village repairs it.
  await warp(page, 'woodland', 17, 20)
  await closeUp(page, 'r3-bridge-worn', device, 21 * 16, 20 * 16 + 8, 90, 2500)
  await page.evaluate(() => (window as unknown as { __fsDevWorldFlag: (f: string) => void }).__fsDevWorldFlag('project:north-bridge:complete'))
  await closeUp(page, 'r3-bridge-mended', device, 21 * 16, 20 * 16 + 8, 90, 800)
}

test.describe('after: round 3', () => {
  test.skip(TAG !== 'after', 'the round-3 art only')
  test('desktop', async ({ page }) => {
    test.setTimeout(150_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await freshPlayer(page)
    await round3Screens(page, 'desktop')
  })
})

test.describe('after: round 3, phone', () => {
  test.skip(TAG !== 'after', 'the round-3 art only')
  test.use(PHONE)
  test('phone', async ({ page }) => {
    test.setTimeout(150_000)
    await freshPlayer(page)
    await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
    await round3Screens(page, 'phone')
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('village, Commons, road edge, water, Mara', async ({ page }) => {
    test.setTimeout(120_000)
    await freshPlayer(page)
    await outdoorScreens(page, 'desktop')
  })
})

test.describe('phone', () => {
  test.use(PHONE)
  test('village, Commons, road edge, water, Mara', async ({ page }) => {
    test.setTimeout(120_000)
    await freshPlayer(page)
    await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
    await outdoorScreens(page, 'phone')
  })
})
