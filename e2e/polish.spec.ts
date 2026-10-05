import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, serverState, syncFromMenu, waitForWorld } from './connected'
import { beginNewJourney, talkThrough, waitForArea } from './helpers'

/**
 * Polish from the docs pass: syncing in the Commons (a safe area), the
 * Journal's quest checklist, and the Menu's controls list (keys and touch).
 */

async function go(page: Page, to: string, tx: number, ty: number): Promise<void> {
  await page.evaluate(([a, x, y]) => (window as unknown as { __fsDevWarp: (a: string, x: number, y: number) => void }).__fsDevWarp(a as string, x as number, y as number), [to, tx, ty] as const)
  await page.waitForFunction(() => (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety().transitioning === true).catch(() => {})
  await waitForArea(page, to as 'village')
}

test.describe('guest', () => {
  test('a sample-hero sync works in the Commons, and is refused out on the road', async ({ page }) => {
    await beginNewJourney(page)
    await go(page, 'woodland', 15, 20)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Try a sample hero' }).click()
    await expect(page.getByRole('alert')).toContainText('Head back to Hearthwick or the Commons first')
    await page.getByRole('button', { name: 'Back to the road' }).click()

    await go(page, 'commons', 2, 21)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Try a sample hero' }).click()
    await expect(page.locator('.toast', { hasText: 'embers into your hand' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to the road' }).click()
    await expect(page.locator('.hud .embers')).toHaveText('3')
  })

  test('the journal checklist copies the naming and settles the warden', async ({ page }) => {
    await beginNewJourney(page)
    // Steps show as they are reached: accept the quest, copy the naming.
    await go(page, 'village', 16, 14)
    await talkThrough(page, /Talk to Mara/)
    await go(page, 'ruin', 15, 3)
    await talkThrough(page, /Copy the naming from the stone/)
    await page.keyboard.press('j')
    const journal = page.getByRole('dialog', { name: /Journal/ })
    await expect(journal).toContainText('Copy the naming from the route stone')
    await expect(journal).toContainText('Settle the stone warden')
    await expect(journal).not.toContainText('Face the stone warden')
    await expect(journal).not.toContainText('Find the old route marker')
  })

  test('the menu lists B (arrange) and G (emotes) with the other keys', async ({ page }) => {
    await beginNewJourney(page)
    await page.keyboard.press('Escape')
    const keys = page.getByTestId('controls-keys')
    await expect(keys).toContainText('Arrange your home')
    await expect(keys).toContainText('Emotes, then 1–5')
    await expect(keys.locator('.kbd', { hasText: /^B$/ })).toHaveCount(1)
    await expect(keys.locator('.kbd', { hasText: /^G$/ })).toHaveCount(1)
    await expect(page.getByTestId('controls-touch')).toHaveCount(0)
  })
})

test.describe('touch', () => {
  // The phone's screen and touch, without its browser type (set per file only).
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

  test('on a phone the menu lists the touch controls instead of keys', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Wander as a guest/ }).tap()
    await waitForArea(page, 'village')
    await page.getByRole('button', { name: /^Menu/ }).tap()
    const list = page.getByTestId('controls-touch')
    await expect(list).toContainText('Joystick')
    await expect(list).toContainText('The Arrange button')
    await expect(list).toContainText('The speech button')
    await expect(list).not.toContainText('arrows work')
    await expect(page.getByTestId('controls-keys')).toHaveCount(0)
  })
})

test.describe('connected', () => {
  test.use({ server: true })

  test('a sync from the Commons reaches the world', async ({ page, context }) => {
    const id = newUser()
    allow(id)
    await routeHabitica(context)
    await openTitleGuide(page)
    await pasteAndConnect(page, id)
    await waitForWorld(page)
    await go(page, 'commons', 2, 21)
    await syncFromMenu(page)
    await expect(page.locator('.toast', { hasText: 'embers into your hand' })).toBeVisible()
    await expect.poll(async () => (await serverState(page)).body.state.embers).toBe(3)
    expect((await serverState(page)).body.state.area).toBe('commons')
  })
})
