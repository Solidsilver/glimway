import { devices } from '@playwright/test'
import { expect, test } from './fixtures'
import { frames, player, stepToWarden, talkThrough, waitForLive, warden, warp } from './helpers'

test.use({ ...devices['iPhone 13'], browserName: 'chromium' })

test('phone layout: joystick, roll, ability and action buttons fit and work', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Wander as a guest/ }).tap()
  await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
  await warp(page, 'woodland', 15, 20)

  const roll = page.getByRole('button', { name: 'Roll' })
  const cast = page.locator('.controls .cast')
  const act = page.locator('.controls .act')
  const pad = page.getByRole('application', { name: 'Movement joystick' })
  for (const el of [roll, cast, act, pad]) await expect(el).toBeVisible()

  // Nothing overlaps and nothing spills off the screen.
  const vw = page.viewportSize()!.width
  const boxes = await Promise.all([pad, roll, cast, act].map((l) => l.boundingBox()))
  for (const b of boxes) {
    expect(b!.x).toBeGreaterThanOrEqual(0)
    expect(b!.x + b!.width).toBeLessThanOrEqual(vw)
  }
  const [padBox, rollBox, castBox, actBox] = boxes.map((b) => b!)
  const overlaps = (a: typeof padBox, b: typeof padBox) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  expect(overlaps(padBox, rollBox) || overlaps(padBox, castBox) || overlaps(padBox, actBox)).toBe(false)
  expect(overlaps(rollBox, castBox) || overlaps(castBox, actBox) || overlaps(rollBox, actBox)).toBe(false)

  // Tapping roll starts its cooldown sweep.
  await roll.tap()
  await expect(roll.locator('.sweep')).toBeVisible()
  await page.screenshot({ path: 'test-results/touch-layout.png' })
})

test('phone: the action button speaks the naming to the warden', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Wander as a guest/ }).tap()
  await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
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
  await page.goto('/')
  await page.getByRole('button', { name: /Wander as a guest/ }).tap()
  await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
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
  // Let go: the hero stops.
  await frames(page, 6)
  const stopped = (await player(page)).x
  await frames(page, 10)
  expect((await player(page)).x).toBe(stopped)
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
  await frames(page, 6)
  const stopped = (await player(page)).x
  await frames(page, 10)
  expect((await player(page)).x).toBe(stopped)
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
