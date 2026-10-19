import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { linkStatus, waitForWorld } from './connected'
import { freshPlayer } from './home-helpers'

/**
 * Entering the world shows the loading screen (src/ui/LoadingScreen.svelte)
 * on the title's backdrop until the world's first frame, against the real
 * server: the HUD and touch pad wait under it, a slow stage says so, a stuck
 * one offers Retry (which brings the world) and the title (from which
 * Continue plays again, the page never superseding itself).
 */

const loadingScreen = (page: Page) => page.getByTestId('loading-screen')
const worldUi = (page: Page) => page.getByTestId('world-ui')
const leaseGate = (page: Page) => page.getByRole('alertdialog', { name: 'Playing on another device' })

/** A returning player at the title, as after reopening the app. */
async function atTitle(page: Page): Promise<void> {
  await freshPlayer(page)
  await page.reload()
  await expect(page.getByTestId('continue-world')).toBeVisible()
}

/** Hold /api/play for `ms` (a waking radio), then let it through. */
async function slowPlay(page: Page, ms: number): Promise<void> {
  await page.route('**/api/play', async (route) => {
    await new Promise((r) => setTimeout(r, ms))
    await route.continue().catch(() => undefined)
  })
}

/** The world is drawn and playable: the loading screen gone, the HUD seen and usable, the link online. */
async function inWorld(page: Page): Promise<void> {
  await waitForWorld(page)
  await expect(loadingScreen(page)).toBeHidden()
  await expect(worldUi(page)).not.toHaveAttribute('inert', /.*/)
  await expect(page.getByRole('button', { name: 'Menu (Esc)' })).toBeVisible()
  expect(await linkStatus(page)).toBe('online')
  await expect(leaseGate(page)).toBeHidden()
}

test('Continue: the loading screen until the world is drawn; a slow /play says so; the HUD waits', async ({ page }) => {
  test.setTimeout(120_000)
  await atTitle(page)
  await slowPlay(page, 9_500)
  await page.getByTestId('continue-world').click()
  await expect(loadingScreen(page)).toBeVisible()
  await expect(loadingScreen(page)).toHaveAttribute('data-stage', 'connect')
  await expect(loadingScreen(page)).toContainText('Finding your way back')
  // 8 s on one stage: the gentle line (and the way back), no Retry yet.
  await expect(page.getByTestId('loading-slow')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByTestId('loading-retry')).toHaveCount(0)
  // No HUD to tap meanwhile, and App's keys wait.
  await expect(page.getByRole('button', { name: 'Menu (Esc)' })).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /Menu/ })).toHaveCount(0)
  await page.unroute('**/api/play')
  await inWorld(page)
  // The world's own: the Menu opens now.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('world-card')).toBeVisible()
})

test('a stuck art fetch offers Retry under an inert HUD, and Retry brings the world', async ({ page }) => {
  test.setTimeout(180_000)
  await atTitle(page)
  // The first request for one atlas hangs; the next one (after Retry) goes through.
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let first = true
  await page.route('**/assets/fingersnap/packed/indoors.webp', async (route) => {
    if (first) {
      first = false
      await held
    }
    await route.continue().catch(() => undefined)
  })
  await page.getByTestId('continue-world').click()
  await expect(loadingScreen(page)).toHaveAttribute('data-stage', 'fetch', { timeout: 30_000 })
  // The game runs under the screen now: its HUD is mounted, unseen and inert.
  await expect(worldUi(page)).toHaveAttribute('inert', /.*/)
  await expect(page.getByRole('button', { name: 'Menu (Esc)' })).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('world-card')).toHaveCount(0)
  // 30 s without the fetch moving: stuck.
  await expect(page.getByTestId('loading-stuck')).toBeVisible({ timeout: 45_000 })
  await page.getByTestId('loading-retry').click()
  release()
  await inWorld(page)
})

test('Back to the title from a slow load, then Continue plays: the page never supersedes itself', async ({ page }) => {
  test.setTimeout(120_000)
  await atTitle(page)
  await slowPlay(page, 9_000)
  await page.getByTestId('continue-world').click()
  await expect(page.getByTestId('loading-slow')).toBeVisible({ timeout: 12_000 })
  await page.getByTestId('loading-back').click()
  await expect(loadingScreen(page)).toBeHidden()
  await page.unroute('**/api/play')
  // The abandoned attempt's /play may still be in flight: Continue waits for it, then plays.
  await page.getByTestId('continue-world').click()
  await inWorld(page)
})

test.describe('phone', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

  test('the loading screen on a phone: no touch pad under it, then the world', async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    await atTitle(page)
    await slowPlay(page, 9_500)
    await page.getByTestId('continue-world').tap()
    await expect(page.getByTestId('loading-slow')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByRole('button', { name: 'Roll' })).toBeHidden()
    // The screen as a phone shows it, for review (test-results and the report).
    const shot = await page.screenshot({ path: testInfo.outputPath('loading-phone.png') })
    await testInfo.attach('loading-phone', { body: shot, contentType: 'image/png' })
    await page.unroute('**/api/play')
    await inWorld(page)
    await expect(page.getByRole('button', { name: 'Roll' })).toBeVisible()
  })
})
