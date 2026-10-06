import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { sql } from './connected'
import { beginNewJourney, waitForArea, savedToDisk } from './helpers'
import { claimDeed, earnEmbers, freshPlayer, fund, myHome, shot } from './home-helpers'

/**
 * The inventory panel (I, or the HUD's bag): tools, supplies, keepsakes,
 * home goods and papers, with quest things "for the road" and a per-device
 * "new" dot. Reads today's data only (the pack, server counts, your home).
 */

/** Add entries to the guest save's pack, then reload and Continue. */
async function seedPack(page: Page, extra: string[]): Promise<void> {
  await savedToDisk(page)
  await page.evaluate(async (items) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('fingersnap')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const store = () => db.transaction('saves', 'readwrite').objectStore('saves')
    const rec = await new Promise<{ state: { inventory: string[] } }>((resolve) => {
      const req = store().get('current')
      req.onsuccess = () => resolve(req.result)
    })
    rec.state.inventory = [...rec.state.inventory, ...items]
    await new Promise((resolve) => {
      const req = store().put(rec)
      req.onsuccess = resolve
    })
    db.close()
  }, extra)
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await waitForArea(page, 'village')
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Inventory' })
const tab = (page: Page, name: RegExp) => dialog(page).getByRole('tab', { name })

test.describe('guest', () => {
  test('I opens the inventory; every tab shows what you carry, and the new dot clears', async ({ page }) => {
    await beginNewJourney(page)
    await seedPack(page, ['material:timber:4', 'material:amber:1', 'lamp-wick', 'ember-charm', 'whittled-fox'])

    // Unseen things put a dot on the bag.
    const bag = page.getByTestId('inventory-button')
    await expect(bag).toHaveAccessibleName(/Inventory \(I\), \d+ new/)

    await page.keyboard.press('i')
    await expect(dialog(page)).toBeVisible()

    // Opens on everything carried; Tools shows the road's things.
    await expect(tab(page, /All/)).toHaveAttribute('aria-selected', 'true')
    await tab(page, /Tools/).click()
    const tools = dialog(page).getByTestId('inv-page-tools')
    await expect(tools.getByText('No tools yet.')).toBeVisible()
    await expect(tools.getByRole('heading', { name: 'For the road' })).toBeVisible()
    await expect(tools.getByText('Field Journal')).toBeVisible()
    await expect(tools.getByText('Map of Hearthwick')).toBeVisible()
    await shot(page, 'inventory-tools-desktop')

    // Arrow keys walk the tabs.
    await tab(page, /Tools/).focus()
    await page.keyboard.press('ArrowRight')
    await expect(tab(page, /Supplies/)).toHaveAttribute('aria-selected', 'true')
    const supplies = dialog(page).getByTestId('inv-page-supplies')
    await expect(supplies.getByTestId('material-timber')).toHaveText('4')
    await expect(supplies.getByTestId('material-amber')).toHaveText('1')
    await expect(supplies.getByTestId('material-stone')).toHaveCount(0)
    await expect(supplies.getByText('Lamp Wick')).toBeVisible()
    await expect(supplies.locator('.badge').first()).toBeVisible()
    await shot(page, 'inventory-supplies-desktop')

    await page.keyboard.press('ArrowRight')
    const keep = dialog(page).getByTestId('inv-page-keepsakes')
    await expect(keep.locator('[data-cell]').first()).toContainText('Ember Charm')
    await expect(keep.getByText('Whittled Fox')).toBeVisible()
    await shot(page, 'inventory-keepsakes-desktop')

    await page.keyboard.press('ArrowRight')
    await expect(dialog(page).getByTestId('inv-page-home')).toContainText('Sign in to have a place on the Commons')

    await page.keyboard.press('End')
    const papers = dialog(page).getByTestId('inv-page-papers')
    await expect(papers).toContainText('Also in your Journal')
    await expect(papers).toContainText('of 39 found')

    // I closes it; everything has been seen, so the dot is gone.
    await page.keyboard.press('i')
    await expect(dialog(page)).toBeHidden()
    await expect(bag).toHaveAccessibleName('Inventory (I)')

    // The HUD button opens it too; the seen list survives a reload.
    await page.reload()
    await page.getByRole('button', { name: /Continue/ }).click()
    await waitForArea(page, 'village')
    await expect(bag).toHaveAccessibleName('Inventory (I)')
    await bag.click()
    await expect(dialog(page)).toBeVisible()
    await expect(tab(page, /All/)).toHaveAttribute('aria-selected', 'true')
    await expect(dialog(page).locator('.badge')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
  })

  test('the grid walks with the arrow keys; Enter opens a card, Escape closes it, then the bag', async ({ page }) => {
    await beginNewJourney(page)
    await seedPack(page, ['material:timber:4', 'material:amber:1', 'lamp-wick', 'whittled-fox'])
    await page.keyboard.press('i')
    await expect(dialog(page)).toBeVisible()
    const cells = dialog(page).locator('.grid:not(.road) [data-cell]')
    await cells.first().focus()
    await page.keyboard.press('ArrowRight')
    await expect(cells.nth(1)).toBeFocused()
    const key = await cells.nth(1).getAttribute('data-cell')
    await page.keyboard.press('Enter')
    await expect(dialog(page).locator(`[data-item="${key}"]`)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page).locator('[data-item]')).toHaveCount(0)
    // Focus goes back to the icon that opened the card.
    await expect(cells.nth(1)).toBeFocused()
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
  })

  test('Tab stays in the bag, and closing a card with its ✕ puts focus back on the icon', async ({ page }) => {
    await beginNewJourney(page)
    await seedPack(page, ['material:timber:4', 'material:amber:1', 'lamp-wick', 'whittled-fox'])
    await page.keyboard.press('i')
    await expect(dialog(page)).toBeVisible()
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))
    // Round the whole bag twice, both ways: never out to the HUD or the page.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab')
      expect(await inside(), `Tab ${i + 1} stays in the bag`).toBe(true)
    }
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await inside(), `Shift+Tab ${i + 1} stays in the bag`).toBe(true)
    }
    const fox = dialog(page).locator('[data-cell="item:whittled-fox"]')
    await fox.click()
    await expect(dialog(page).locator('[data-item="item:whittled-fox"]')).toBeVisible()
    await dialog(page).getByRole('button', { name: 'Close the card' }).click()
    await expect(dialog(page).locator('[data-item]')).toHaveCount(0)
    await expect(fox).toBeFocused()
    // A cell's name says what it is and how it stands.
    await expect(dialog(page).locator('[data-cell="material:timber"]')).toHaveAccessibleName(/^Timber, 4/)
  })

  test('the Character panel points to the inventory', async ({ page }) => {
    await beginNewJourney(page)
    await page.keyboard.press('c')
    const sheet = page.locator('[aria-labelledby="char-title"]')
    await expect(sheet).toContainText('Your pack, materials and keepsakes are in the Inventory.')
    await expect(sheet.getByRole('heading', { name: 'Pack' })).toHaveCount(0)
    await sheet.getByTestId('open-inventory').click()
    await expect(dialog(page)).toBeVisible()
    await expect(sheet).toBeHidden()
  })
})

test.describe('touch', () => {
  // The phone's screen and touch, without its browser type (set per file only).
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

  test('on a phone the bag button opens the inventory and the tabs fit', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Wander as a guest/ }).tap()
    await waitForArea(page, 'village')
    await seedPack(page, ['material:fiber:3', 'tin-whistle'])
    await page.getByTestId('inventory-button').tap()
    await expect(dialog(page)).toBeVisible()
    await tab(page, /Supplies/).tap()
    await expect(dialog(page).getByTestId('material-fiber')).toHaveText('3')
    await tab(page, /Keepsakes/).tap()
    await expect(dialog(page).getByText('Tin Whistle')).toBeVisible()
    // Nothing spills off the side of the screen.
    const vw = page.viewportSize()!.width
    const box = (await dialog(page).locator('.panel').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(vw)
    await dialog(page).getByRole('button', { name: 'Close the inventory' }).tap()
    await expect(dialog(page)).toBeHidden()
    await page.getByRole('button', { name: /^Menu/ }).tap()
    await expect(page.getByTestId('controls-touch')).toContainText('The bag button')
  })
})

test.describe('connected', () => {
  test.use({ server: true })

  test('in a world the inventory shows server counts and your home goods, placed and stored', { tag: '@smoke' }, async ({ page }) => {
    const id = await freshPlayer(page)
    // Homesteads v2: a home is a deed you claim from Silas.
    await earnEmbers(page, id)
    await claimDeed(page)
    const plot = await myHome(page, id)
    expect(plot).toBeTruthy()
    fund(id, { materials: { timber: 12, stone: 3 }, items: { 'river-glass-bead': 2, 'wooden-peg': 5 } })
    // Two stools (one set out, one put away in your pack) and a fern put away.
    const home = `(SELECT homestead_id FROM homestead_members WHERE habitica_id='${id}')`
    sql(
      `INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES('inv-a','wooden-stool','placed',${home},'outdoor',1,1,0);` +
        `INSERT INTO homestead_items(id,item_def,location,habitica_id) VALUES('inv-b','wooden-stool','inventory','${id}'),('inv-c','potted-fern','inventory','${id}');`
    )

    await page.keyboard.press('i')
    await expect(dialog(page)).toBeVisible()
    await tab(page, /Supplies/).click()
    const supplies = dialog(page).getByTestId('inv-page-supplies')
    await expect(supplies.getByTestId('material-timber')).toHaveText('12')
    await expect(supplies.getByTestId('material-stone')).toHaveText('3')
    await expect(supplies.getByTestId('qty-item:wooden-peg')).toHaveText('5')

    await tab(page, /Keepsakes/).click()
    await expect(dialog(page).getByTestId('qty-item:river-glass-bead')).toHaveText('2')
    // Hovering shows what a thing is; what you can do with it comes with a click.
    const bead = dialog(page).locator('[data-cell="item:river-glass-bead"]')
    await bead.hover()
    const beadCard = dialog(page).locator('[data-item="item:river-glass-bead"]')
    await expect(beadCard).toBeVisible()
    await expect(beadCard.locator('[data-act]')).toHaveCount(0)
    await bead.click()
    await expect(beadCard.locator('[data-act="pocket"]')).toBeVisible()
    await page.keyboard.press('Escape')

    await tab(page, /Home/).click()
    const goods = dialog(page).getByTestId('inv-page-home')
    // Pick an icon: its card says where the pieces are.
    await goods.locator('[data-cell="decoration:wooden-stool"]').click()
    const stool = goods.locator('[data-item="decoration:wooden-stool"]')
    await expect(stool).toContainText('Wooden Stool')
    await expect(stool).toContainText('1 set out · 1 put away')
    await goods.locator('[data-cell="decoration:potted-fern"]').click()
    await expect(goods.locator('[data-item="decoration:potted-fern"]')).toContainText('1 put away')
    await shot(page, 'inventory-home-desktop')

    await tab(page, /Tools/).click()
    await expect(dialog(page).getByTestId('inv-page-tools')).toContainText('No tools yet.')
    await expect(dialog(page).getByTestId('inv-page-tools')).toContainText('Field Journal')
    await tab(page, /Papers/).click()
    await expect(dialog(page).getByTestId('inv-page-papers')).toContainText('of 39 found')
  })
})
