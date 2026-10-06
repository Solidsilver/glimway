import type { Browser, BrowserContext } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, setHabitica, waitForWorld } from './connected'
import { freshPlayer, fund, giveInstance, go, hurt, shot } from './home-helpers'
import { waitForLive, waitFrames, expectToast } from './helpers'

/**
 * The item system core against the real Go server (docs/items/): tools wear
 * to zero both ways (a bench tool breaks, an heirloom blunts) and Silas
 * mends; a consumable mends you; keepsakes go in a pocket and a lantern in
 * the off hand; a gift passes hand to hand between two players standing
 * together; things lying in the world can be picked up; your own chest opens
 * from the inventory even with no home. SCREENS=1 saves screenshots to
 * .agent/screens/.
 */
test.use({ server: true })

type Wear = { broke: boolean; state: string; usesLeft: number; condition: number } | { error: string }
type ItemsView = {
  stacks: { itemDef: string; qty: number; maker: { id: string; name: string } | null }[]
  instances: { id: string; itemDef: string; condition: number; maxCondition: number; state: string; usesLeft: number }[]
  pockets: { slot: string; itemDef: string | null }[]
  offHand: { open: boolean; class: string | null; itemDef: string | null; instance: string | null }
  pickedUp: string[]
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Inventory' })
const tab = (page: Page, name: RegExp) => dialog(page).getByRole('tab', { name })
const items = (page: Page) => page.evaluate(() => (window as unknown as { __fsItems: () => ItemsView | null }).__fsItems())
const useTool = (page: Page, id: string, n = 1) =>
  page.evaluate(([i, k]) => (window as unknown as { __fsDevUseTool: (id: string, n: number) => Promise<Wear> }).__fsDevUseTool(i as string, k as number), [id, n] as const)
const vitals = (page: Page) => page.evaluate(() => (window as unknown as { __fsVitals: () => { hp: number; maxHp: number } }).__fsVitals())

async function openInventory(page: Page, t: RegExp): Promise<void> {
  if (!(await dialog(page).isVisible())) await page.keyboard.press('i')
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByTestId('carry-strip')).toBeVisible()
  await tab(page, t).click()
}
async function closeInventory(page: Page): Promise<void> {
  // Escape closes an open card first, then the panel.
  for (let i = 0; i < 3 && (await dialog(page).isVisible()); i++) await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
}

/** Pick an item in the bag's grid: its card (what each row used to show) opens. */
async function pick(page: Page, key: string) {
  await dialog(page).locator(`[data-cell="${key}"]`).click()
  const card = dialog(page).locator(`[data-item="${key}"]`)
  await expect(card).toBeVisible()
  return card
}


test('a bench axe wears to nothing and breaks; an heirloom blunts, and Silas mends it', async ({ page }) => {
  const id = await freshPlayer(page, 'Wren')
  const axe = giveInstance(id, 'bench-axe', { uses: 3, max: 90, maker: id })
  const brack = giveInstance(id, 'brack-felling-axe', { uses: 1, max: 240 })
  fund(id, { materials: { timber: 4 }, items: { 'wooden-peg': 2 } })

  await openInventory(page, /Tools/)
  const tools = dialog(page).getByTestId('inv-page-tools')
  const axeRow = await pick(page, `inst:${axe}`)
  await expect(axeRow).toContainText('Bench axe')
  await expect(axeRow).toContainText('Made by Wren')
  await expect(axeRow.getByTestId('wear-words')).toHaveText('3 uses left')
  await expect(axeRow).toHaveAttribute('data-state', 'worn')
  await expect(axeRow.getByTestId('condition')).toHaveAttribute('aria-valuenow', '10')
  await expect(await pick(page, `inst:${brack}`)).toContainText('About 80 uses before it')
  await shot(page, 'items-tools-worn-desktop')
  await closeInventory(page)

  // Two swings, then the last one still lands: and the axe is gone.
  expect(await useTool(page, axe, 2)).toMatchObject({ broke: false, usesLeft: 1 })
  expect(await useTool(page, axe)).toMatchObject({ broke: true, state: 'broken' })
  expect(await useTool(page, axe)).toEqual({ error: 'item-not-found' })

  // The heirloom's last use blunts it; it stays, and won't cut until mended.
  expect(await useTool(page, brack)).toMatchObject({ broke: false, state: 'blunt', condition: 0 })
  expect(await useTool(page, brack)).toEqual({ error: 'tool-blunt' })
  await openInventory(page, /Tools/)
  await expect(tools.locator(`[data-cell="inst:${axe}"]`)).toHaveCount(0)
  const brackRow = await pick(page, `inst:${brack}`)
  await expect(brackRow).toHaveAttribute('data-state', 'blunt')
  await expect(brackRow.getByTestId('wear-words')).toHaveText('Blunt. Mend it to use it again.')
  // Away from any mender, only the bench is offered (and there's no workshop).
  await brackRow.getByRole('button', { name: 'Mend…' }).click()
  await expect(brackRow.getByTestId('mend-at').locator('[data-mend="silas"]')).toHaveCount(0)
  await brackRow.locator('[data-mend="bench"]').click()
  await expect(dialog(page).getByTestId('inv-message')).toHaveText('That needs your own workshop bench.')
  await shot(page, 'items-heirloom-blunt-desktop')
  await closeInventory(page)

  // At Silas's table he mends it while you talk.
  await go(page, 'commons', 51, 23)
  await openInventory(page, /Tools/)
  await pick(page, `inst:${brack}`)
  await brackRow.getByRole('button', { name: 'Mend…' }).click()
  const silas = brackRow.locator('[data-mend="silas"]')
  await expect(silas).toContainText('Silas (2 timber, 1 wooden peg)')
  await silas.click()
  await expect(dialog(page).getByTestId('inv-message')).toHaveText('Silas mended the brack felling axe while you talked.')
  await expect(brackRow).toHaveAttribute('data-state', 'whole')
  await expect(brackRow.getByTestId('condition')).toHaveAttribute('aria-valuenow', '100')
  await tab(page, /Supplies/).click()
  await expect(dialog(page).getByTestId('material-timber')).toHaveText('2')
  await shot(page, 'items-mended-desktop')
})

test('a twist mends you; the fox goes in a pocket, and the lantern rides in the off hand', async ({ page }) => {
  const id = await freshPlayer(page, 'Ivy')
  fund(id, { items: { 'keepers-twists': 2, 'whittled-fox': 1, 'work-glove': 1 } })
  const lantern = giveInstance(id, 'carters-lantern', { max: 0 })

  await hurt(page, 15)
  const before = (await vitals(page)).hp
  await openInventory(page, /Supplies/)
  const twists = await pick(page, 'item:keepers-twists')
  await expect(twists).toContainText('Mends you a little')
  await twists.getByRole('button', { name: 'Use' }).click()
  await expect(dialog(page).getByTestId('inv-message')).toHaveText("You used Keeper's Twists.")
  await expect(dialog(page).getByTestId('qty-item:keepers-twists')).toHaveText('1')
  await expect.poll(async () => (await vitals(page)).hp).toBe(Math.min(before + 10, (await vitals(page)).maxHp))

  // One pocket to start; the fox's help reads in words.
  await tab(page, /Keepsakes/).click()
  const fox = await pick(page, 'item:whittled-fox')
  await expect(fox).toContainText('Papers glint brighter')
  await fox.getByRole('button', { name: 'Pocket' }).click()
  await expect(fox.getByTestId('in-pocket')).toHaveText('In pocket 1')
  await expect(dialog(page).getByTestId('pocket-1')).toContainText('Whittled Fox')
  await expect(dialog(page).getByTestId('carry-strip')).toContainText('A satchel, apron or coat adds a second pocket.')
  // Story keepsakes are kept: no Give.
  await expect(fox.getByRole('button', { name: /Give/ })).toHaveCount(0)
  expect((await items(page))!.pockets.map((p) => p.itemDef)).toEqual(['whittled-fox'])

  // The off hand is open (the hero has a class): carry the lantern.
  await tab(page, /Tools/).click()
  const lanternRow = await pick(page, `inst:${lantern}`)
  await expect(lanternRow).toContainText('Lights the way')
  await expect(lanternRow).toContainText('A little better in a warrior’s hands')
  await lanternRow.getByRole('button', { name: 'Carry' }).click()
  await expect(lanternRow.getByTestId('in-hand')).toBeVisible()
  await expect(dialog(page).getByTestId('off-hand')).toContainText("Carter's lantern")
  await shot(page, 'items-pockets-offhand-desktop')
  await closeInventory(page)
  // Drawn at the hero's side, and put away while fighting.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsOffHand: () => string | null }).__fsOffHand())).toBe('carters-lantern')
  await page.evaluate(() => (window as unknown as { __fsDevAttack: () => void }).__fsDevAttack())
  // Within the swing (game time; checked every frame, so the short gap can't slip by).
  const offHand = (want: string | null) => (window as unknown as { __fsOffHand: () => string | null }).__fsOffHand() === want
  await waitFrames(page, offHand, null, { seconds: 2, message: 'the lantern put away' })
  await waitFrames(page, offHand, 'carters-lantern', { seconds: 5, message: 'the lantern back out' })
})

test('things lying in the world can be picked up, once', { tag: '@smoke' }, async ({ page }) => {
  await freshPlayer(page, 'Moss')
  await go(page, 'village', 10, 10)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsPickups: () => string[] }).__fsPickups())).toContain('well-rope-coil')
  await expect(page.locator('.prompt')).toContainText('Pick up the coil of rope')
  if (process.env.SCREENS) await page.waitForTimeout(2500) // the area title fades
  await shot(page, 'items-pickup-rope-desktop')
  await waitForLive(page)
  await page.keyboard.press('e')
  await expectToast(page, 'A coil of rope, left by the well')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsPickups: () => string[] }).__fsPickups())).not.toContain('well-rope-coil')
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'fibre-rope')?.qty).toBe(1)
  // The bucket in the bracken is a worn tool.
  await go(page, 'woodland', 12, 19)
  await expect(page.locator('.prompt')).toContainText('Pick up the dropped bucket')
  await page.keyboard.press('e')
  await expect.poll(async () => (await items(page))!.instances.find((i) => i.itemDef === 'stave-bucket')?.state).toBe('worn')
  // It stays picked up after a reload.
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await waitForWorld(page, 'woodland')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsItems: () => ItemsView | null }).__fsItems()?.pickedUp.length ?? 0)).toBe(2)
  expect(await page.evaluate(() => (window as unknown as { __fsPickups: () => string[] }).__fsPickups())).not.toContain('dropped-bucket')
})

test('your own chest opens from the inventory, even with no home', async ({ page }) => {
  const id = await freshPlayer(page, 'Bram')
  fund(id, { personal: { stone: 5 } })
  await openInventory(page, /Supplies/)
  await dialog(page).getByTestId('own-chest').click()
  const workshop = page.getByRole('dialog', { name: 'The Workshop' })
  await expect(workshop).toBeVisible()
  await expect(workshop.getByTestId('homeless-chest')).toBeVisible()
  await expect(workshop.locator('[data-chest="shared"]')).toBeDisabled()
  await workshop.getByRole('button', { name: 'Take out 5 Stone' }).click()
  await expect(workshop.locator('[data-goods="material:stone"] td.n').first()).toHaveText('5')
  await shot(page, 'items-own-chest-homeless-desktop')
})

// ------------------------------------------------------------ two players

async function twoPlayers(page: Page, browser: Browser, baseURL: string): Promise<{ other: Page; ctx: BrowserContext; ash: string; rowan: string }> {
  const ash = newUser()
  const rowan = newUser()
  allow(ash)
  await setHabitica(ash, { name: 'Ash' })
  await setHabitica(rowan, { name: 'Rowan' })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, ash)
  await waitForWorld(page)
  const invite = await (await page.request.post('/api/invites', { data: {} })).json()
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  await pasteAndConnect(other, rowan, { invite: invite.code })
  await waitForWorld(other)
  return { other, ctx, ash, rowan }
}

test('standing together, one player hands another something they made', async ({ page, browser, baseURL }) => {
  const { other, ctx, ash, rowan } = await twoPlayers(page, browser, baseURL!)
  fund(ash, { items: { 'lamp-wick': 2 }, maker: ash })
  const glove = 'work-glove'
  fund(ash, { items: { [glove]: 1 } })
  await go(page, 'commons', 30, 24)
  await go(other, 'commons', 31, 24)
  const remotes = (p: Page) => p.evaluate(() => ((window as unknown as { __fsRemote?: () => { name: string }[] }).__fsRemote?.() ?? []).map((r) => r.name))
  await expect.poll(() => remotes(page), { timeout: 15_000 }).toEqual(['Rowan'])
  await expect.poll(() => remotes(other), { timeout: 15_000 }).toEqual(['Ash'])

  await openInventory(page, /Supplies/)
  const wick = await pick(page, `item:lamp-wick@${ash}`)
  await expect(wick).toContainText('Made by Ash')
  await wick.getByRole('button', { name: 'Give…' }).click()
  await expect(wick.getByTestId('give-to')).toContainText('Rowan')
  await shot(page, 'items-give-chooser-desktop')
  await wick.locator(`[data-give-to="${rowan}"]`).click()
  await expect(dialog(page).getByTestId('inv-message')).toHaveText('You gave Rowan a lamp wick.')
  await expect(dialog(page).getByTestId(`qty-item:lamp-wick@${ash}`)).toHaveText('1')

  // Rowan hears it at once, and the wick carries Ash's mark.
  await expectToast(other, 'Ash gave you a lamp wick.')
  await expect.poll(async () => (await items(other))?.stacks.find((s) => s.itemDef === 'lamp-wick')?.maker?.name).toBe('Ash')
  await other.bringToFront()
  await openInventory(other, /Supplies/)
  await expect(await pick(other, `item:lamp-wick@${ash}`)).toContainText('Made by Ash')
  await shot(other, 'items-gift-received-desktop')
  await closeInventory(other)

  // Apart, nobody is offered.
  await go(other, 'village', 20, 20)
  // Rowan's page, still in front, joins the village room (a join waits out its cooldown).
  const presenceArea = (p: Page) => p.evaluate(() => (window as unknown as { __fsPresence?: () => { area: string | null } }).__fsPresence?.()?.area ?? null)
  await expect.poll(() => presenceArea(other), { timeout: 15_000 }).toBe('village')
  await page.bringToFront()
  await closeInventory(page)
  await expect.poll(() => remotes(page), { timeout: 15_000 }).toEqual([])
  await openInventory(page, /Keepsakes/)
  const gloveRow = await pick(page, `item:${glove}`)
  await gloveRow.getByRole('button', { name: 'Give…' }).click()
  await expect(gloveRow.getByTestId('give-to')).toHaveText('Stand next to someone to hand it over.')
  await ctx.close()
})
