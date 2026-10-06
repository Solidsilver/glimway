import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { beginNewJourney, holdUntil, readDialogue, toastAfter, toastCount, warp, waitForArea, waitForLive, waitFrames, expectLine } from './helpers'
import { FLOWER_LINES, SIT_LINES } from '../src/content/touches.ts'

/**
 * Small world touches (docs/hands-on-design.md, section 3): sitting on the
 * village bench (pose, slow mana, standing on movement — keyboard and the
 * touch action button) and smelling the flowers (a short, varied line each
 * time). Guest play is fine: none of it needs a server. SCREENS=1 saves
 * desktop + phone screenshots of sitting and a flower line to
 * .agent/screens/.
 */

type SeatView = { seated: boolean; bonus: number; mana: number; maxMana: number; x: number; y: number }
const seat = (page: Page) => page.evaluate(() => (window as unknown as { __fsSeat?: () => SeatView }).__fsSeat?.() ?? null)
const manaMeter = (page: Page) => page.getByRole('meter', { name: 'Mana' })
/** The Mana meter shows `value` within `seconds` of game time (regen runs on the game clock). */
const manaShows = (page: Page, value: string, seconds: number) =>
  waitFrames(page, (v: string) => document.querySelector('.bar.mana[role="meter"]')?.getAttribute('aria-valuenow') === v, value, { seconds, message: `mana ${value}` })

test('the bench seats the hero, mana comes back, movement stands up', async ({ page }) => {
  await beginNewJourney(page)

  // Spend some mana first, so the seated regen has something to fill.
  await warp(page, 'village', 9, 14)
  await waitForLive(page)
  await page.keyboard.press('f')
  await manaShows(page, '5', 10)
  await expect(manaMeter(page)).toHaveAttribute('aria-valuenow', '5')

  await expect(page.locator('.prompt')).toContainText('Sit on the bench')
  await page.keyboard.press('e')
  await expect.poll(async () => (await seat(page))?.seated).toBe(true)
  await expect(page.locator('.prompt')).toContainText('Stand up')
  await expect.poll(async () => (await seat(page))?.bonus).toBe(5)

  // Seated, mana returns quickly to full (5/s standing would take twice as long).
  await manaShows(page, '20', 10)
  await expect(manaMeter(page)).toHaveAttribute('aria-valuenow', '20')

  // Any movement key stands the hero up, back where they sat from.
  await holdUntil(page, 'ArrowLeft', async () => (await seat(page))?.seated === false)
  await expect.poll(async () => (await seat(page))?.seated).toBe(false)
  const spot = await seat(page)
  expect(spot!.bonus).toBe(0)
})

test('smelling the flowers says something different each time', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'village', 22, 8) // the planter by the lane
  await expect(page.locator('.prompt')).toContainText('Smell the flowers')

  const before = await toastCount(page)
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(page.locator('.toast').first()).toBeVisible()
  const first = await toastAfter(page, before)
  expect(FLOWER_LINES).toContain(first!.trim())

  await page.keyboard.press('e')
  const second = await toastAfter(page, before + 1)
  expect(FLOWER_LINES).toContain(second!.trim())
  expect(second!.trim(), 'the flowers vary their line').not.toBe(first!.trim())
})

test('reading the signpost opens a conversation and closes it', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'village', 15, 12) // the signpost by the square
  await expect(page.locator('.prompt')).toContainText('Read the signpost')
  await page.keyboard.press('e')
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  await expectLine(page, 'signpost')
  await readDialogue(page)
  await expect(dialogue).toBeHidden()
})

test.describe('phone', () => {
  // devices['iPhone 13'] minus the browser choice: it can't be set in a group.
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

  test('the touch action button sits you down and stands you up', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Wander as a guest/ }).tap()
    await waitForArea(page, 'village')
    await warp(page, 'village', 9, 14)

    const act = page.locator('.controls .act')
    await expect(act).toHaveAttribute('aria-label', 'Sit on the bench')
    await expect(act.locator('.cap')).toHaveText('Sit')
    await act.tap()
    await expect.poll(async () => (await seat(page))?.seated).toBe(true)
    await expect(act).toHaveAttribute('aria-label', 'Stand up')
    await expect(act.locator('.cap')).toHaveText('Stand')
    await act.tap()
    await expect.poll(async () => (await seat(page))?.seated).toBe(false)
  })

  test('smelling the planter works from the action button', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Wander as a guest/ }).tap()
    await waitForArea(page, 'village')
    await warp(page, 'village', 22, 8)
    const act = page.locator('.controls .act')
    await expect(act).toHaveAttribute('aria-label', 'Smell the flowers')
    await act.tap()
    const toast = page.locator('.toast').last()
    await expect(toast).toBeVisible()
    await expect.poll(async () => FLOWER_LINES.includes((await toast.textContent())!.trim())).toBe(true)
  })
})

test.describe('screens (SCREENS=1)', () => {
  test.skip(!process.env.SCREENS, 'screenshots only (SCREENS=1)')

  /** Desktop and phone screenshots of the same moment (.agent/screens/). */
  async function shot(page: Page, name: string): Promise<void> {
    if (!process.env.SCREENS) return
    const base = name.replace(/-desktop$/, '')
    const size = page.viewportSize()!
    await page.waitForTimeout(600)
    await page.screenshot({ path: `.agent/screens/${base}-desktop.png` })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(700)
    await page.screenshot({ path: `.agent/screens/${base}-phone.png` })
    await page.setViewportSize(size)
    await page.waitForTimeout(400)
  }

  test('sitting on the bench, and a flower line', async ({ page }) => {
    await beginNewJourney(page)
    await warp(page, 'village', 9, 14)
    await expect(page.locator('.prompt')).toContainText('Sit on the bench')
    await page.keyboard.press('e')
    await expect.poll(async () => (await seat(page))?.seated).toBe(true)
    await expect(page.locator('.prompt')).toContainText('Stand up')
    await expect.poll(async () => SIT_LINES.includes((await page.locator('.toast').last().textContent())!.trim())).toBe(true)
    await shot(page, 'touch-sit')

    await warp(page, 'village', 22, 8)
    await expect(page.locator('.prompt')).toContainText('Smell the flowers')
    await page.keyboard.press('e')
    await expect.poll(async () => FLOWER_LINES.includes((await page.locator('.toast').last().textContent())!.trim())).toBe(true)
    await shot(page, 'touch-flowers')
  })
})
