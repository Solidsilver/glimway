import { writeFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { expect, test } from './fixtures'
import type { Page } from './fixtures'
import { beginNewJourney, waitForLive, warp } from './helpers'
import { claimDeed, earnPlenty, freshPlayer, intoCottage, myHome, place, readOn, silasSays } from './home-helpers'

/**
 * Screens for the art-density review (.agent/screens/<DENSITY_TAG>-*.png):
 * the village square, the Commons lane, residents close up and a cottage
 * interior, on a 1280-wide desktop and a 390×844 touch phone. SCREENS=1 only.
 */
test.skip(!process.env.SCREENS, 'screenshots only (SCREENS=1)')

const OUT = '.agent/screens'
const TAG = process.env.DENSITY_TAG ?? 'now'
const { defaultBrowserType: _browser, ...IPHONE } = devices['iPhone 13']
const PHONE = { ...IPHONE, viewport: { width: 390, height: 844 } }

async function snap(page: Page, name: string, device: string): Promise<void> {
  // Past the area's title card.
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/${TAG}-${name}-${device}.png` })
}

/** A crop around a world point (CSS px), for the close-ups. */
async function closeUp(page: Page, name: string, device: string, x: number, y: number, half: number): Promise<void> {
  await page.waitForTimeout(900)
  const p = await page.evaluate(([wx, wy]) => (window as unknown as { __fsDevToScreen: (x: number, y: number) => { x: number; y: number } }).__fsDevToScreen(wx, wy), [x, y] as const)
  const box = (await page.locator('canvas').first().boundingBox())!
  await page.screenshot({ path: `${OUT}/${TAG}-${name}-${device}.png`, clip: { x: box.x + p.x - half, y: box.y + p.y - half, width: half * 2, height: half * 2 } })
}

async function outdoorScreens(page: Page, device: string): Promise<void> {
  // The village square: Mara by the well, the cottages around it.
  await warp(page, 'village', 19, 14)
  await snap(page, 'village-square', device)
  await closeUp(page, 'resident-mara', device, 16 * 16 + 8, 13 * 16 + 4, 90)
  // The Commons lane and its square, Elara at her post up the lane.
  await warp(page, 'commons', 23, 19)
  await snap(page, 'commons-lane', device)
  await warp(page, 'commons', 25, 7)
  await closeUp(page, 'resident-elara', device, 26 * 16 + 8, 5 * 16 + 4, 90)
  // Texture memory after the village and the Commons (the GPU's RGBA bytes).
  const mem = await page.evaluate(() => (window as unknown as { __fsDevTextureMemory: () => unknown }).__fsDevTextureMemory())
  writeFileSync(`${OUT}/${TAG}-memory-${device}.json`, JSON.stringify(mem, null, 1))
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('village square, Commons lane, residents', async ({ page }) => {
    test.setTimeout(120_000)
    await beginNewJourney(page)
    await outdoorScreens(page, 'desktop')
  })
})

test.describe('phone', () => {
  test.use(PHONE)
  test('village square, Commons lane, residents', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    await page.getByRole('button', { name: /Wander as a guest/ }).tap()
    await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
    await outdoorScreens(page, 'phone')
  })
})

test.describe('connected', () => {
  test.use({ server: true, viewport: { width: 1280, height: 800 } })
  test('a cottage interior', async ({ page, browser }) => {
    test.setTimeout(400_000)
    const id = await freshPlayer(page)
    await earnPlenty(page, id)
    await claimDeed(page)
    await silasSays(page, /Raise a cottage/)
    await readOn(page, /Steady as a route stone/)
    await expect.poll(async () => (await myHome(page, id)).tier).toBe(1)
    await intoCottage(page)
    await place(page, 104, 104)
    await snap(page, 'cottage-interior', 'desktop')

    // The same player on a touch phone.
    const state = await page.context().storageState()
    const phone = await browser.newContext({ ...PHONE, storageState: state, baseURL: test.info().project.use.baseURL })
    const p = await phone.newPage()
    await p.goto('/')
    await p.getByRole('button', { name: /Continue/ }).tap()
    // Only one device plays at a time: this one takes over.
    await p.getByRole('button', { name: /Take over here/ }).tap()
    await p.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean; areaId: string } }).__fsSafety?.().transitioning === false)
    await intoCottage(p).catch(async () => {
      // Touch: tap the action button at the door.
      await p.locator('.controls .act').tap()
    })
    await p.waitForFunction(() => (window as unknown as { __fsSafety?: () => { areaId: string } }).__fsSafety?.().areaId === 'cottage')
    await waitForLive(p)
    await place(p, 104, 104)
    await snap(p, 'cottage-interior', 'phone')
    await phone.close()
  })
})
