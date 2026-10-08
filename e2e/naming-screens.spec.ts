import { expect, test, type Page } from './fixtures'
import { stepToWarden, talkThrough, warden, warp, waitForLive } from './helpers'
import { freshPlayer } from './home-helpers'

/**
 * Screenshots of the naming beats for review (.agent/screens/).
 * Skipped in the normal run: `SCREENS=1 npx playwright test e2e/naming-screens.spec.ts`.
 */
test.skip(!process.env.SCREENS, 'screenshots only (SCREENS=1)')

const OUT = '.agent/screens'

async function toTheStone(page: Page, prefix: string): Promise<void> {
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await expect(page.locator('.prompt')).toContainText('Copy the naming from the stone')
  await waitForLive(page)
  await page.screenshot({ path: `${OUT}/${prefix}-naming-clue-prompt.png` })
}

/** Read the route stone up to the naming line, screenshot it, then finish. */
async function readTheNaming(page: Page, prefix: string, press: () => Promise<void>): Promise<void> {
  await press()
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  for (let i = 0; i < 10 && !(await dialogue.textContent())?.includes('The road is closed here'); i++) {
    await press()
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/${prefix}-naming-clue-dialogue.png` })
  for (let i = 0; i < 20 && (await dialogue.isVisible()); i++) {
    await press()
    await page.waitForTimeout(250)
  }
  await expect.poll(async () => (await warden(page)).state).toBe('active')
  // Let the "Clue found" ribbon and toasts clear so the warden is in view.
  await page.waitForTimeout(7000)
}

test('desktop: copy the naming, then speak it to the warden', async ({ page }) => {
  await freshPlayer(page)
  await toTheStone(page, 'desktop')
  await readTheNaming(page, 'desktop', () => page.keyboard.press('e'))
  await stepToWarden(page, 84, false)
  await stepToWarden(page, 20, true)
  await expect(page.locator('.prompt')).toContainText('Speak the naming')
  await waitForLive(page)
  await page.screenshot({ path: `${OUT}/desktop-naming-speak-prompt.png` })
  await page.keyboard.press('e')
  await page.waitForTimeout(120)
  await page.screenshot({ path: `${OUT}/desktop-naming-spoken.png` })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

  test('phone: the Speak button', async ({ page }) => {
    await freshPlayer(page)
    await toTheStone(page, 'phone')
    const act = page.locator('.controls .act')
    await readTheNaming(page, 'phone', () => page.keyboard.press('e'))
    await stepToWarden(page, 84, false)
    await stepToWarden(page, 20, true)
    await expect(act.locator('.cap')).toHaveText('Speak')
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${OUT}/phone-naming-speak-button.png` })
  })
})
