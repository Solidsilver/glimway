import { readFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { beginNewJourney } from './helpers'

/**
 * The "What's new" card (src/ui/whats-new.svelte.ts): after an update, the
 * changelog's "For players" lines for each release this device hasn't seen.
 * The dev server's build is "dev", so a stored record from another build is
 * an update; the lines are CHANGELOG.md's newest release.
 */

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
/** The newest released version and its first players' line (as plain words). */
const latest = /^## \[(\d+\.\d+\.\d+)\][^\n]*\n[\s\S]*?### For players\s+- ([^\n]+)/m.exec(changelog)!
const VERSION = latest[1]
const FIRST_LINE = latest[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').slice(0, 30)
/** The release before it: a device that saw it has exactly one release to catch up on. */
const PREVIOUS = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)][1]?.[1] ?? '0.0.1'

const KEY = 'glimway:whats-new'
const card = (page: Page) => page.getByTestId('whats-new')

/** This device last caught up on an older build: by default the previous release's. */
async function seenBefore(page: Page, version = PREVIOUS): Promise<void> {
  await page.addInitScript(([key, version]) => {
    if (!sessionStorage.getItem('whats-new-seeded')) {
      sessionStorage.setItem('whats-new-seeded', '1')
      localStorage.setItem(key, JSON.stringify({ version, build: 'older' }))
    }
  }, [KEY, version] as const)
}

const stored = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), KEY)

test('after an update the card says what’s new, once', async ({ page }) => {
  await seenBefore(page)
  await beginNewJourney(page)
  // It waits for the arrival card, then shows.
  await expect(card(page)).toBeVisible({ timeout: 20_000 })
  await expect(card(page)).toContainText(`New in Glimway ${VERSION}`)
  await expect(card(page)).toContainText(FIRST_LINE)
  await expect(card(page).getByRole('link', { name: 'Everything that changed' })).toHaveAttribute('href', /CHANGELOG\.md$/)
  // It never takes focus from the game.
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="whats-new"]'))).toBe(false)
  await card(page).getByTestId('whats-new-ok').click()
  await expect(card(page)).toBeHidden()
  expect(await stored(page)).toEqual({ version: VERSION, build: 'dev' })

  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).first().click()
  await page.waitForTimeout(3000)
  await expect(card(page)).toBeHidden()
})

test('a first visit catches up quietly, and the Menu shows the newest lines any time', async ({ page }) => {
  await beginNewJourney(page)
  await page.waitForTimeout(2500)
  await expect(card(page)).toBeHidden()
  expect(await stored(page)).toEqual({ version: VERSION, build: 'dev' })

  await page.keyboard.press('Escape')
  await page.getByTestId('menu-whats-new').click()
  // The Menu steps aside for it.
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toContainText(FIRST_LINE)
  await card(page).getByTestId('whats-new-ok').click()
  await expect(card(page)).toBeHidden()
})

for (const [name, size] of [
  ['portrait', { width: 390, height: 844 }],
  ['short landscape', { width: 568, height: 320 }]
] as const) {
  test.describe(`phone, ${name}`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices['iPhone 13']
    test.use({ ...phone, viewport: size })

    test(`${size.width}×${size.height}: the card and its button stay on screen and clear of the thumbs`, async ({ page }) => {
      // Every release unseen: the longest card.
      await seenBefore(page, '0.0.1')
      await page.goto('/')
      await page.getByRole('button', { name: /Wander as a guest/ }).tap()
      await expect(card(page)).toBeVisible({ timeout: 20_000 })
      await page.waitForTimeout(400) // the slide-in
      const box = (await card(page).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(size.width)
      expect(box.y + box.height).toBeLessThanOrEqual(size.height)
      const ok = (await card(page).getByTestId('whats-new-ok').boundingBox())!
      expect(ok.y + ok.height).toBeLessThanOrEqual(size.height)
      expect(ok.height).toBeGreaterThanOrEqual(36)
      // Not over the action button.
      const act = (await page.locator('[data-inset="act"]').boundingBox())!
      const overlaps = box.x < act.x + act.width && act.x < box.x + box.width && box.y < act.y + act.height && act.y < box.y + box.height
      expect(overlaps).toBe(false)
      if (process.env.SCREENS) await page.screenshot({ path: `.agent/screens/whats-new-${size.width}x${size.height}.png` })
      await card(page).getByTestId('whats-new-ok').tap()
      await expect(card(page)).toBeHidden()
    })
  })
}
