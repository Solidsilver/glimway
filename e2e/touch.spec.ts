import { devices } from '@playwright/test'
import { expect, test } from './fixtures'
import { warp } from './helpers'

test.use({ ...devices['iPhone 13'], browserName: 'chromium' })

test('phone layout: joystick, roll, ability and action buttons fit and work', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Begin your journey/ }).tap()
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
