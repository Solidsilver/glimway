import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { serverState } from './connected'
import { freshPlayer } from './home-helpers'

/**
 * Dev mode (local playtesting only): the e2e page is Vite dev and its server
 * a `-tags dev` build, so the dev panel and its grant route are here. Opened
 * with the backquote key (and from the Menu), it gives this account embers
 * and Glimway's own things, and the game shows them like any other answer.
 */

const devPanel = (page: Page) => page.getByRole('dialog', { name: 'Dev' })
const hud = (page: Page) => page.locator('.hud .embers')

test('dev mode: ` opens the panel; embers and a material arrive in the HUD and the bag', async ({ page }) => {
  await freshPlayer(page)
  const before = (await serverState(page)).body.state.embers as number

  await page.keyboard.press('Backquote')
  await expect(devPanel(page)).toBeVisible()
  await expect(devPanel(page).getByTestId('dev-banner')).toHaveText(/Dev mode \(local only\)/)

  // +100 embers: the answer's state is the game's at once.
  await devPanel(page).getByTestId('dev-embers').click()
  await expect(page.getByTestId('dev-message')).toContainText('Given: 100 × Embers')
  await expect(hud(page)).toHaveText(String(before + 100))
  expect((await serverState(page)).body.state.embers).toBe(before + 100)

  // One material, found by search, a count of 7.
  await devPanel(page).getByTestId('dev-search').fill('timber')
  const row = devPanel(page).locator('[data-grant="timber"]')
  await expect(row).toBeVisible()
  await row.getByRole('spinbutton').fill('7')
  await row.getByRole('button', { name: 'Give' }).click()
  await expect(page.getByTestId('dev-message')).toContainText('Given: 7 × Timber')

  // ` again closes it; the bag shows the timber.
  await page.keyboard.press('Backquote')
  await expect(devPanel(page)).toBeHidden()
  await page.keyboard.press('i')
  const bag = page.getByRole('dialog', { name: 'Inventory' })
  await expect(bag).toBeVisible()
  await expect(bag.locator('[data-cell="material:timber"]')).toHaveAccessibleName(/^Timber, 7/)
  await page.keyboard.press('Escape')

  // The Menu has a Dev row that opens it too.
  await page.keyboard.press('Escape')
  await page.getByTestId('menu-dev').getByRole('button', { name: 'Open dev mode' }).click()
  await expect(devPanel(page)).toBeVisible()
})

test.describe('on a phone', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

  test('dev mode on a phone: from the Menu, it fits and gives', async ({ page }) => {
    await freshPlayer(page)
    const before = (await serverState(page)).body.state.embers as number
    await page.getByRole('button', { name: /^Menu/ }).tap()
    await page.getByTestId('menu-dev').getByRole('button', { name: 'Open dev mode' }).tap()
    await expect(devPanel(page)).toBeVisible()
    // Nothing spills off the side of the screen, the rows included.
    const vw = page.viewportSize()!.width
    for (const el of [devPanel(page).locator('.panel'), devPanel(page).locator('[data-grant="timber"]')]) {
      const box = (await el.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(vw)
    }
    await devPanel(page).getByTestId('dev-embers').tap()
    await expect(hud(page)).toHaveText(String(before + 100))
  })
})
