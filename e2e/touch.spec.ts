import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { player, steady, stepToWarden, talkThrough, waitForLive, warden, warp } from './helpers'
import { freshPlayer } from './home-helpers'

test.use({ ...devices['iPhone 13'], browserName: 'chromium' })

/**
 * The touch cluster with everything out: the joystick, roll, both ✦ (a
 * level-20 warrior: Cleave and Stand, crafts.md 8) and the action button.
 * Nothing overlaps, nothing spills off the screen, every button is at least
 * 44 px; then the buttons work.
 */
async function layoutFitsAndWorks(page: Page, shot: string): Promise<void> {
  await freshPlayer(page, 'Tansy', undefined, { lvl: 20 })
  await warp(page, 'woodland', 15, 20)

  const roll = page.getByRole('button', { name: 'Roll' })
  const cast = page.locator('.controls .cast.sig')
  const second = page.locator('.controls .cast.move')
  const act = page.locator('.controls .act')
  const pad = page.getByRole('application', { name: 'Movement joystick' })
  for (const el of [roll, cast, second, act, pad]) await expect(el).toBeVisible()
  await expect(cast).toHaveAttribute('aria-label', 'Cleave (12 mana)')
  await expect(second).toHaveAttribute('aria-label', 'Stand (14 mana)')

  const vw = page.viewportSize()!.width
  const boxes = await Promise.all([pad, roll, cast, second, act].map((l) => l.boundingBox()))
  for (const b of boxes) {
    expect(b!.x).toBeGreaterThanOrEqual(0)
    expect(b!.x + b!.width).toBeLessThanOrEqual(vw)
    expect(b!.width).toBeGreaterThanOrEqual(44)
  }
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  const all = boxes.map((b) => b!)
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j]), `buttons ${i} and ${j}`).toBe(false)

  // Tapping roll starts its cooldown sweep.
  await roll.tap()
  await expect(roll.locator('.sweep')).toBeVisible()

  // The second ✦ casts Stand (planted, so it goes after the roll): its sweep starts, the first's doesn't.
  await second.tap()
  await expect(second.locator('.sweep')).toBeVisible()
  await expect(cast.locator('.sweep')).toHaveCount(0)
  await page.screenshot({ path: `test-results/${shot}.png` })
}

test('phone layout: joystick, roll, both ✦ and action buttons fit and work', async ({ page }) => {
  await layoutFitsAndWorks(page, 'touch-layout')
})

test.describe('a narrow phone (320 px)', () => {
  // The iPhone 13's touch and pixel ratio (set above), on an iPhone SE's 320 px screen.
  test.use({ viewport: devices['iPhone SE'].viewport })
  test('phone layout fits at 320 px too', async ({ page }) => {
    expect(page.viewportSize()!.width).toBe(320)
    await layoutFitsAndWorks(page, 'touch-layout-320')
  })
})

test('phone: the action button speaks the naming to the warden', async ({ page }) => {
  await freshPlayer(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await expect.poll(async () => (await warden(page)).state).toBe('active')

  const act = page.locator('.controls .act')
  await stepToWarden(page, 84, false)
  await stepToWarden(page, 20, true)
  await expect(act).toHaveAttribute('aria-label', 'Speak the naming')
  await expect(act.locator('.cap')).toHaveText('Speak')
  await act.tap()
  await expect.poll(async () => (await warden(page)).speakings).toBe(1)
})

/** Touch input as a phone sends it (Chromium turns it into pointer events). */
async function fingers(page: import('@playwright/test').Page) {
  const cdp = await page.context().newCDPSession(page)
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
  return {
    down: (x: number, y: number) => send('touchStart', x, y),
    move: (x: number, y: number) => send('touchMove', x, y),
    up: () => send('touchEnd')
  }
}

async function startWithStick(page: import('@playwright/test').Page, stick: string): Promise<void> {
  await page.addInitScript((s) => localStorage.setItem('fingersnap:settings', JSON.stringify({ stick: s })), stick)
  await freshPlayer(page)
  await warp(page, 'woodland', 15, 20)
  await waitForLive(page)
}

test('phone: the floating stick appears under the thumb and walks the hero', async ({ page }) => {
  await startWithStick(page, 'floating')
  await expect(page.getByRole('application', { name: 'Movement joystick' })).toHaveCount(0)
  const vh = page.viewportSize()!.height
  const start = await player(page)
  const f = await fingers(page)
  await f.down(70, vh - 200)
  await expect(page.getByTestId('float-stick')).toBeVisible()
  const box = (await page.getByTestId('float-stick').boundingBox())!
  expect(Math.abs(box.x + box.width / 2 - 70)).toBeLessThan(4)
  await f.move(130, vh - 200)
  await expect.poll(async () => (await player(page)).x - start.x).toBeGreaterThan(12)
  await f.up()
  // Let go: the hero stops (the same spot for ten frames running).
  await steady(page, async () => (await player(page)).x, { frames: 10, seconds: 3, message: 'the hero stops' })
})

test('phone: hold to walk heads for the finger and stops on release', async ({ page }) => {
  await startWithStick(page, 'hold')
  const start = await player(page)
  // A finger a little right of the middle of the screen, where the camera keeps the hero.
  const at = await page.evaluate(() => {
    const r = document.querySelector('.stage canvas')!.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const f = await fingers(page)
  await f.down(at.x + 110, at.y)
  await expect.poll(async () => (await player(page)).x - start.x).toBeGreaterThan(12)
  await f.up()
  await steady(page, async () => (await player(page)).x, { frames: 10, seconds: 3, message: 'the hero stops' })
  // The walk layer sits under the HUD: its buttons still answer.
  await page.getByRole('button', { name: /^Inventory/ }).tap()
  await expect(page.getByRole('dialog', { name: /Inventory/ })).toBeVisible()
})

test('phone: the Menu picks how you walk', async ({ page }) => {
  await startWithStick(page, 'fixed')
  await page.getByRole('button', { name: 'Menu (Esc)' }).tap()
  const modes = page.getByTestId('stick-modes')
  await expect(modes.getByRole('radio', { name: /Joystick/ })).toHaveAttribute('aria-checked', 'true')
  await modes.getByRole('radio', { name: /Floating stick/ }).tap()
  await expect(modes.getByRole('radio', { name: /Floating stick/ })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: 'Back to the road' }).tap()
  await expect(page.getByTestId('walk-zone')).toBeAttached()
  await expect(page.getByRole('application', { name: 'Movement joystick' })).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fingersnap:settings') ?? '{}').stick)).toBe('floating')
})
