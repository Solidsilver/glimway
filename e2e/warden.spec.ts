import { expect, test, type Page } from './fixtures'
import { freshPlayer, fund, giveInstance, shot } from './home-helpers'
import { sql } from './connected'

test.use({ server: true })

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Inventory' })
const tab = (page: Page, name: RegExp) => dialog(page).getByRole('tab', { name })

async function openInventory(page: Page, t: RegExp): Promise<void> {
  if (!(await dialog(page).isVisible())) await page.keyboard.press('i')
  await expect(dialog(page)).toBeVisible()
  await tab(page, t).click()
}
async function closeInventory(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
}

test('warden-set tool displays grey chip on icon and dullness in description', async ({ page }) => {
  const id = await freshPlayer(page, 'Rowan')
  const axe = giveInstance(id, 'bench-axe', { uses: 40, max: 120 })
  const sliver = `${axe}-sliver`
  sql(`INSERT INTO item_instances(id,item_def,location,owner,condition,max_condition,created_at) VALUES('${sliver}','warden-sliver','fitted','${axe}',0,0,0);`)

  await openInventory(page, /Tools/)
  const tools = dialog(page).getByTestId('inv-page-tools')
  const axeRow = tools.locator(`[data-item="inst:${axe}"]`)
  await expect(axeRow).toBeVisible()

  // Tool icon displays a grey chip (.grey-chip on .ii)
  const chip = axeRow.locator('.ii .grey-chip')
  await expect(chip).toBeVisible()

  // Tool description notes dullness
  await expect(axeRow.locator('.rule')).toContainText('Warden-set: sharp')
  await expect(axeRow.getByTestId('wear-words')).toHaveText('Sharp')
  await shot(page, 'items-warden-chip-desktop')
  await closeInventory(page)
})

test('unmoored status shows HUD hint, and using comfrey salve clears it', async ({ page }) => {
  const id = await freshPlayer(page, 'Willow')
  fund(id, { items: { 'comfrey-salve': 1 } })

  // HUD hint is initially hidden
  const hint = page.locator('.unmoored-hint')
  await expect(hint).toBeHidden()

  // This DEV-only hook places the HUD in the unmoored state for its UI check.
  await page.evaluate(() => {
    ;(window as unknown as { __fsUnmoored?: (val?: boolean) => boolean }).__fsUnmoored?.(true)
  })

  // HUD hint should now be visible
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('Unmoored')
  await expect(hint).toHaveAttribute('title', /the drift’s sway holds you/)
  await shot(page, 'unmoored-edge-bands')

  // Open inventory and use comfrey-salve
  await openInventory(page, /Supplies/)
  const salveRow = dialog(page).locator('[data-item="item:comfrey-salve"]')
  await expect(salveRow).toBeVisible()
  await salveRow.getByRole('button', { name: 'Use' }).click()

  // Unmoored hint should now be cleared
  await expect(hint).toBeHidden()
  await closeInventory(page)
})
