import { expect, test, type Page } from './fixtures'
import { sql } from './connected'
import { waitForLive } from './helpers'
import { claimDeed, earnEmbers, earnPlenty, fund, freshPlayer, homes, intoCottage, myHome, place, readOn, shot, silasSays } from './home-helpers'

/**
 * Crafting at the hearth and the writing desk, against the real Go server
 * (docs/items/crafting-and-repair.md): the cottage hearth's recipes (food,
 * remedies, oils) with the maker's mark on everything made, and the desk
 * copying a recipe page you hold, one fiber a copy. Each test makes its own
 * player and world and raises a cottage.
 *
 * SCREENS=1 also saves review screenshots to .agent/screens/.
 */
test.use({ server: true })

/** In the tray: pick a piece, then walk it to (x, y) with the arrow keys. */
async function carryTo(page: Page, piece: string, x: number, y: number): Promise<void> {
  const tray = page.getByTestId('placement-tray')
  await tray.locator(`[data-piece="${piece}"]`).first().click()
  await expect.poll(async () => (await homes(page)).placement?.spot ?? null).not.toBeNull()
  // One key press per step, each waited for: presses landing inside one
  // frame would be read as one.
  const spot = async () => (await homes(page)).placement!.spot!
  for (let at = await spot(); at.x !== x || at.y !== y; ) {
    const key = at.x !== x ? (x > at.x ? 'ArrowRight' : 'ArrowLeft') : y > at.y ? 'ArrowDown' : 'ArrowUp'
    await page.keyboard.press(key)
    const before = at
    await expect.poll(async () => JSON.stringify(await spot())).not.toBe(JSON.stringify(before))
    at = await spot()
  }
  await expect.poll(async () => (await homes(page)).placement?.spot).toEqual({ x, y, rotation: 0 })
}

/** Raise a cottage on a fresh deed (embers funded, tier 1); returns the player's id. */
async function cottagePlayer(page: Page): Promise<string> {
  const id = await freshPlayer(page)
  await earnEmbers(page, id)
  await claimDeed(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  return id
}

/** A cottage with the Workshop built on (tier 2); one round of embers, and
 * the workshop build's materials in the pack before Silas first reads them. */
async function workshopPlayer(page: Page): Promise<string> {
  const id = await freshPlayer(page)
  await fund(id, { materials: { timber: 20, stone: 10, fiber: 13, 'seasoned-timber': 6 } })
  await earnPlenty(page, id)
  await claimDeed(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await silasSays(page, /Build on a workshop/)
  await readOn(page, /Steady|eaves/)
  await expect.poll(async () => (await myHome(page)).tier).toBe(2)
  return id
}

/** Stand at a spot in the cottage and open the crafting panel at it. */
async function openPanel(page: Page, spot: { x: number; y: number }, prompt: RegExp | string, name: string): Promise<ReturnType<Page['getByRole']>> {
  await place(page, spot.x, spot.y)
  await expect(page.locator('.prompt')).toContainText(prompt)
  await waitForLive(page)
  await page.keyboard.press('e')
  const panel = page.getByRole('dialog', { name })
  await expect(panel).toBeVisible()
  return panel
}

test('the hearth: cook a remedy at the cottage hearth, your maker\'s mark on it', async ({ page }) => {
  test.setTimeout(300_000)
  const id = await cottagePlayer(page)

  // No wild thyme, no tea: the recipe row says so, and the hearth refuses.
  fund(id, { materials: { water: 2 } })
  await intoCottage(page)
  const panel = await openPanel(page, { x: 159, y: 70 }, 'Cook at the hearth', 'The Hearth')
  await expect(panel.locator('[data-recipe="hearth-saltings-tea"]')).toContainText('Not enough materials')

  // With thyme and water: two teas, marked by their maker. A found recipe
  // (the wax seal) stays locked until its page is held.
  await panel.getByRole('button', { name: 'Close the hearth' }).click()
  await expect(panel).toBeHidden()
  fund(id, { materials: { 'wild-thyme': 4, water: 2 } })
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-recipe="hearth-wax-seal"]')).toContainText('You never learned this recipe')
  await expect(panel.locator('[data-recipe="hearth-wax-seal"] [data-testid="locked"]')).toBeVisible()
  fund(id, { items: { 'recipe-page-wax-seal': 1 }, materials: { beeswax: 2 } })
  await panel.getByRole('button', { name: 'Close the hearth' }).click()
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(panel).toBeVisible()
  await panel.locator('[data-craft="hearth-saltings-tea"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Made 2 Saltings tea')
  // The page in hand: the wax seals unlock and carry the maker's mark.
  await panel.locator('[data-craft="hearth-wax-seal"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Made 2 Wax seals')
  await panel.getByRole('button', { name: 'Close the hearth' }).click()
  await expect(panel).toBeHidden()
  const st = await (await page.request.get('/api/storage')).json()
  expect(st.inventory.items['saltings-tea']).toBe(2)
  expect(st.inventory.items['wild-thyme']).toBe(2)
  expect(st.inventory.items['wax-seal']).toBe(2)
  // The maker's mark went on: the stack in the pack reads its maker.
  const mark = sql(`SELECT maker_id FROM item_stacks WHERE owner='${id}' AND item_def='saltings-tea' AND location='pack';`)
  expect(mark).toBe(id)
  await shot(page, 'hearth-craft-desktop')
})

test('the writing desk: craft it at the bench, set it out, sit down, copy a recipe page you hold, one fiber a copy', async ({ page }) => {
  test.setTimeout(300_000)
  const id = await workshopPlayer(page)

  // Silas doesn't sell the desk (it's made at the bench): no row of his.
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await expect(shop.locator('[data-buy="writing-desk"]')).toHaveCount(0)
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // The bench: seasoned timber in, one writing desk out.
  await intoCottage(page)
  await place(page, 115, 66)
  await expect(page.locator('.prompt')).toContainText('Work at the bench')
  await waitForLive(page)
  await page.keyboard.press('e')
  const workshop = page.getByRole('dialog', { name: 'The Workshop' })
  await expect(workshop).toBeVisible()
  await workshop.getByRole('tab', { name: 'Crafting bench' }).click()
  await workshop.locator('[data-craft="craft-writing-desk"]').click()
  await expect(workshop.locator('.msg.ok')).toContainText('Made a Writing desk')
  await workshop.getByRole('button', { name: 'Close the workshop' }).click()

  // Inside the cottage: the arrange tray sets it out on the room grid.
  await waitForLive(page)
  await page.getByTestId('arrange').click()
  await carryTo(page, 'writing-desk', 2, 2)
  const tray = page.getByTestId('placement-tray')
  await expect(tray.getByRole('button', { name: /Set it here/ })).toBeEnabled()
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')
  await tray.getByRole('button', { name: /Done/ }).click()

  // Copying needs you to hold the page.
  await fund(id, { materials: { fiber: 5 } })
  const panel = await openPanel(page, { x: 64, y: 100 }, 'Sit at the desk', 'The Writing Desk')
  await expect(panel.locator('[data-testid="no-pages"]')).toContainText('don’t carry any recipe pages')

  // A page in the pack: two copies, one fiber each, the original kept.
  await panel.getByRole('button', { name: 'Close the desk' }).click()
  await expect(panel).toBeHidden()
  fund(id, { items: { 'recipe-page-tea': 1 } })
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(panel).toBeVisible()
  await panel.locator('[data-page="recipe-page-tea"] [aria-label="More"]').click()
  await panel.locator('[data-copy="recipe-page-tea"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('2 fresh copies')
  await panel.getByRole('button', { name: 'Close the desk' }).click()
  await expect(panel).toBeHidden()
  const st = await (await page.request.get('/api/storage')).json()
  expect(st.inventory.items['recipe-page-tea']).toBe(3)
  const marks = sql(`SELECT maker_id || '|' || qty FROM item_stacks WHERE owner='${id}' AND item_def='recipe-page-tea' AND location='pack' ORDER BY maker_id;`).split('\n').map((s) => s.trim()).filter(Boolean)
  expect(marks.sort()).toEqual(['|1', `${id}|2`].sort())
  await shot(page, 'desk-copy-desktop')
})
