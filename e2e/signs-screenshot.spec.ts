import { expect, test } from './fixtures'
import { freshPlayer } from './home-helpers'
import { expectAreaCard } from './helpers'
import { goIn } from './room-helpers'

test('capture the library section plaques in game', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  await goIn(page, 'in:village:library')
  await expectAreaCard(page, 'The library reading room')
  // Let the arrival title clear so the shelves and all four plaques are visible.
  await page.waitForTimeout(7_000)
  await expect(page.locator('.area .title')).toBeHidden()
  await page.screenshot({ path: '.agent/screens/signs-after.png' })
})
