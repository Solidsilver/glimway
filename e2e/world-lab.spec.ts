import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { freshPlayer } from './home-helpers'

/**
 * The world lab (src/ui/dev/world-lab; server/internal/worldlab): opened
 * from the dev panel, it renders the generator on the e2e server (a
 * `-tags dev` build, its renders in worker processes of that binary),
 * inspects a tile, diffs two seeds, checks edited rules, and "go here"
 * moves the hero.
 */

const lab = (page: Page) => page.getByRole('dialog', { name: 'World lab' })

async function openLab(page: Page, tap = false): Promise<void> {
  if (tap) {
    await page.getByRole('button', { name: /^Menu/ }).tap()
    await page.getByTestId('menu-dev').getByRole('button', { name: 'Open dev mode' }).tap()
  } else {
    await page.keyboard.press('Backquote')
  }
  const open = page.getByTestId('dev-world-lab').getByRole('button', { name: 'Open the world lab' })
  await (tap ? open.tap() : open.click())
  await expect(lab(page)).toBeVisible()
}

/** The stats of the last render, once one has come (the Stats tab). */
async function rendered(page: Page, view: string): Promise<void> {
  await lab(page).getByRole('tab', { name: 'Stats' }).click()
  await expect(lab(page).locator('dd').first()).toContainText(view, { timeout: 30_000 })
  await expect(lab(page).getByRole('status').filter({ hasText: /Rendering/ })).toHaveCount(0, { timeout: 30_000 })
}

test('the world lab: render, inspect, diff, rules, and go here', async ({ page }, testInfo) => {
  await freshPlayer(page)
  await openLab(page)
  await rendered(page, 'atlas')
  await testInfo.attach('world-lab-atlas', { body: await page.screenshot(), contentType: 'image/png' })

  // The region view, by its button.
  await lab(page).getByRole('button', { name: 'Region' }).click()
  await rendered(page, 'region')
  await testInfo.attach('world-lab-region', { body: await page.screenshot(), contentType: 'image/png' })

  // A tile under the middle of the map.
  const map = lab(page).locator('canvas').first()
  const box = (await map.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const heading = lab(page).getByRole('heading', { name: /^Tile -?\d+, -?\d+$/ })
  await expect(heading).toBeVisible({ timeout: 20_000 })
  await expect(lab(page).locator('dl')).toContainText('Chunk')

  // Edited rules: a broken copy says where it breaks, and Reset brings the server's back.
  await lab(page).getByRole('tab', { name: /^Rules/ }).click()
  const rules = lab(page).getByRole('textbox', { name: /wilds rules/ })
  const original = await rules.inputValue()
  await rules.fill(original.replace(/"chunkSize":\s*(\d+),/, '"chunkSize": $1,,'))
  await expect(lab(page).getByRole('alert').filter({ hasText: /^Line \d+, column \d+/ })).toBeVisible()
  await lab(page).getByRole('button', { name: 'Reset to the server’s' }).click()
  await expect(lab(page).getByText('Same as the server’s')).toBeVisible()

  // Two seeds side by side.
  await lab(page).getByRole('tab', { name: 'View' }).click()
  await lab(page).getByLabel(/Side by side/).check()
  await lab(page).getByLabel(/B’s seed/).fill('another-world')
  await lab(page).getByRole('tab', { name: 'Stats' }).click()
  await expect(lab(page).getByRole('heading', { name: 'Changed' })).toBeVisible({ timeout: 40_000 })
  await testInfo.attach('world-lab-diff', { body: await page.screenshot(), contentType: 'image/png' })
  await lab(page).getByRole('tab', { name: 'View' }).click()
  await lab(page).getByLabel(/Side by side/).uncheck()

  // Go here: the hero arrives on the tile (or the nearest open one), and the lab closes.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(heading).toBeVisible({ timeout: 20_000 })
  const go = lab(page).getByRole('button', { name: 'Go here' })
  const hint = lab(page).getByText(/^Lands on/)
  const at = (await hint.count()) ? (await hint.textContent())! : (await heading.textContent())!
  const [tx, ty] = at.match(/-?\d+/g)!.map(Number)
  await go.click()
  await expect(lab(page)).toBeHidden()
  // The sprite stands at the tile's middle (or its feet): within a tile either way.
  await expect
    .poll(
      async () =>
        page.evaluate(([x, y]) => {
          const p = window.__fsPlayer?.()
          return !!p && Math.abs(p.x / 16 - (x + 0.5)) <= 1 && Math.abs(p.y / 16 - (y + 0.5)) <= 1
        }, [tx, ty]),
      { timeout: 20_000 }
    )
    .toBe(true)
})

test.describe('on a phone', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

  test('the world lab on a phone: it fits, renders and inspects', async ({ page }, testInfo) => {
    await freshPlayer(page)
    await openLab(page, true)
    await rendered(page, 'atlas')
    const vw = page.viewportSize()!.width
    for (const el of [lab(page), lab(page).locator('canvas').first(), lab(page).getByRole('tablist')]) {
      const b = (await el.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5)
      expect(b.height).toBeGreaterThan(40)
    }
    const map = (await lab(page).locator('canvas').first().boundingBox())!
    await page.touchscreen.tap(map.x + map.width / 2, map.y + map.height / 2)
    await expect(lab(page).getByRole('heading', { name: /^Tile -?\d+, -?\d+$/ })).toBeVisible({ timeout: 20_000 })
    await testInfo.attach('world-lab-phone', { body: await page.screenshot(), contentType: 'image/png' })
    await lab(page).getByRole('button', { name: 'Close the world lab' }).tap()
    await expect(lab(page)).toBeHidden()
  })
})
