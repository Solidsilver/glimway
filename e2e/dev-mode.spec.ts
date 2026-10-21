import { mkdirSync, writeFileSync } from 'node:fs'
import { devices, type TestInfo } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { serverState, waitForWorld } from './connected'
import { freshPlayer } from './home-helpers'
import { player, waitForLive, warp } from './helpers'

/**
 * Dev mode (local playtesting only): the e2e page is Vite dev and its server
 * a `-tags dev` build, so the dev panel and its grant route are here. Opened
 * with the backquote key (and from the Menu), it gives this account glims
 * and Glimway's own things, and the game shows them like any other answer.
 * On a desktop it docks at the right beside the game, which keeps playing;
 * on a phone it is the shared sheet.
 *
 * The screenshots go to .e2e-artifacts/dev-panel/ (CI uploads them with the
 * run's evidence) for a person to look at.
 */

const OUT = '.e2e-artifacts/dev-panel'
const devPanel = (page: Page) => page.getByTestId('dev-panel')
const hud = (page: Page) => page.locator('.hud .glims')

async function evidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const png = await page.screenshot()
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/${name}.png`, png)
  await testInfo.attach(name, { body: png, contentType: 'image/png' })
}

/** The hero walks while `key` is held: some way, for a moment. */
async function walks(page: Page, key: string): Promise<boolean> {
  const from = await player(page)
  await page.keyboard.down(key)
  await page.waitForTimeout(450)
  await page.keyboard.up(key)
  const to = await player(page)
  return Math.hypot(to.x - from.x, to.y - from.y) > 4
}

test('dev mode docked: beside the game, which keeps playing; gives arrive; the folds and the panel come back after a reload', async ({ page }, testInfo) => {
  await freshPlayer(page)
  await warp(page, 'outdoors', 16, 66)
  await waitForLive(page)
  const before = (await serverState(page)).body.state.glims as number
  const vw = page.viewportSize()!.width
  const stageWidth = () => page.locator('main > .stage').evaluate((el) => el.getBoundingClientRect().width)
  expect(await stageWidth()).toBeCloseTo(vw, 0)

  await page.keyboard.press('Backquote')
  const panel = page.getByRole('complementary', { name: 'Dev' })
  await expect(panel).toBeVisible()
  await expect(devPanel(page).getByTestId('dev-banner')).toHaveText(/Dev mode \(local only\)/)
  // Docked at the right edge; the game has the rest of the screen, no backdrop over it.
  const box = (await panel.boundingBox())!
  expect(box.x + box.width).toBeCloseTo(vw, 0)
  await expect.poll(stageWidth).toBeCloseTo(vw - box.width, 0)
  await expect(page.locator('.overlay')).toHaveCount(0)
  // The game still plays beside it.
  expect(await walks(page, 'ArrowRight') || (await walks(page, 'ArrowLeft'))).toBe(true)
  await evidence(page, testInfo, 'desktop-docked')

  // +100 glims: the answer's state is the game's at once.
  await devPanel(page).getByTestId('dev-glims').click()
  await expect(page.getByTestId('dev-message')).toContainText('Given: 100 × Glims')
  await expect(hud(page)).toHaveText(String(before + 100))
  expect((await serverState(page)).body.state.glims).toBe(before + 100)

  // Typing in the search never moves the hero (w, a, s, d are walking keys).
  const search = devPanel(page).getByTestId('dev-search')
  await search.click()
  const still = await player(page)
  await page.keyboard.type('wood saw', { delay: 30 })
  await expect(search).toHaveValue('wood saw')
  await page.waitForTimeout(200)
  expect(await player(page)).toEqual(still)

  // One material, found by search and kind, a count of 7.
  await search.fill('')
  await page.keyboard.type('tim')
  await devPanel(page).getByTestId('dev-group').selectOption('Material')
  const row = devPanel(page).locator('[data-grant="timber"]')
  await expect(row).toBeVisible()
  await expect(devPanel(page).locator('[data-grant]')).not.toHaveCount(0)
  await expect(devPanel(page).locator('[data-grant="glims"]')).toHaveCount(0)
  await evidence(page, testInfo, 'desktop-give-searched')
  await row.getByRole('spinbutton').fill('7')
  await row.getByRole('button', { name: 'Give' }).click()
  await expect(page.getByTestId('dev-message')).toContainText('Given: 7 × Timber')
  // Given lately: once more from the Quick section, at the same count.
  const again = devPanel(page).getByTestId('dev-recent').locator('[data-again="timber"]')
  await expect(again).toBeVisible()

  // Escape leaves the field; then the game's keys are the game's: the bag opens beside the docked panel.
  await row.getByRole('spinbutton').press('Escape')
  await page.keyboard.press('i')
  const bag = page.getByRole('dialog', { name: 'Inventory' })
  await expect(bag).toBeVisible()
  await expect(bag.locator('[data-cell="material:timber"]')).toHaveAccessibleName(/^Timber, 7/)
  await expect(panel).toBeVisible()
  await evidence(page, testInfo, 'desktop-docked-with-bag')
  await page.keyboard.press('Escape')
  await expect(bag).toBeHidden()

  // Fold Give an item; after a reload the panel is open again, still folded.
  const give = devPanel(page).getByTestId('dev-give')
  await give.locator('summary').click()
  await expect(search).toBeHidden()
  await page.reload()
  await page.getByTestId('continue-world').click()
  await waitForWorld(page)
  await expect(panel).toBeVisible()
  await expect(devPanel(page).getByTestId('dev-give')).not.toHaveAttribute('open', /.*/)
  await expect(devPanel(page).getByTestId('dev-quick')).toHaveAttribute('open', /.*/)
  await expect(devPanel(page).getByTestId('dev-recent').locator('[data-again="timber"]')).toBeVisible()

  // ` closes it, and the game has the whole screen again.
  await page.keyboard.press('Backquote')
  await expect(panel).toBeHidden()
  await expect.poll(stageWidth).toBeCloseTo(vw, 0)

  // The Menu has a Dev row that opens it too.
  await page.keyboard.press('Escape')
  await page.getByTestId('menu-dev').getByRole('button', { name: 'Open dev mode' }).click()
  await expect(panel).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
})

test.describe('on a phone', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

  test('dev mode on a phone: from the Menu, a sheet that fits and gives', async ({ page }, testInfo) => {
    await freshPlayer(page)
    const before = (await serverState(page)).body.state.glims as number
    await page.getByRole('button', { name: /^Menu/ }).tap()
    await page.getByTestId('menu-dev').getByRole('button', { name: 'Open dev mode' }).tap()
    await expect(page.getByRole('dialog', { name: 'Dev' })).toBeVisible()
    // Nothing spills off the side of the screen, the rows included.
    const vw = page.viewportSize()!.width
    for (const el of [devPanel(page), devPanel(page).locator('[data-grant="timber"]')]) {
      const box = (await el.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(vw)
    }
    await evidence(page, testInfo, 'phone-sheet')
    await devPanel(page).getByTestId('dev-glims').tap()
    await expect(hud(page)).toHaveText(String(before + 100))
    await devPanel(page).getByTestId('dev-search').fill('axe')
    await evidence(page, testInfo, 'phone-searched')
  })
})
