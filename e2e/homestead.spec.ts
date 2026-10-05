import { expect, test } from './fixtures'
import { serverState } from './connected'
import { beginNewJourney, waitForArea, player } from './helpers'
import { area, earnEmbers, freshPlayer, go, homes, hurt, myHome, place, readOn, shot, silasSays, talk, type Area } from './home-helpers'

/**
 * The Hearthwick Commons and homesteads, against the real Go server
 * (playwright.config.ts starts it with a fresh database). Each test signs in
 * as new Habitica ids, so tests share no server state.
 *
 * SCREENS=1 also saves review screenshots to .agent/screens/.
 */
test.use({ server: true })

test('the Commons gate: walk in from Hearthwick and back; Silas tells a guest to sign in', async ({ page }) => {
  await beginNewJourney(page)
  // The village's new east gate, below the Lantern Road.
  await go(page, 'village', 39, 15)
  await page.keyboard.down('ArrowRight')
  await waitForArea(page, 'commons' as Area)
  await page.keyboard.up('ArrowRight')
  expect((await player(page)).x).toBeLessThan(6 * 16)
  await expect(page.locator('.area .title')).toHaveText('Hearthwick Commons')
  await shot(page, 'commons-gate-desktop')

  // Guests can walk the Commons, but building needs a world.
  await silasSays(page)
  const v = await homes(page)
  expect(v.status).toBe('guest')
  expect(v.plots).toEqual([])

  // And back out through the gate.
  await go(page, 'commons', 2, 21)
  await page.keyboard.down('ArrowLeft')
  await waitForArea(page, 'village')
  await page.keyboard.up('ArrowLeft')
  expect((await player(page)).x).toBeGreaterThan(36 * 16)
})

test('a guest hears that plots are for people with a world', async ({ page }) => {
  await beginNewJourney(page)
  await go(page, 'commons', 51, 22)
  await expect(page.locator('.prompt')).toContainText('Talk to Silas')
  await page.keyboard.press('e')
  const dialogue = page.getByRole('dialog', { name: /Conversation with Silas/ })
  await expect(dialogue).toBeVisible()
  let text = ''
  for (let i = 0; i < 8 && (await dialogue.isVisible()); i++) {
    text += await dialogue.innerText()
    await page.keyboard.press('e')
    await page.waitForTimeout(300)
  }
  expect(text).toContain('Sign in to your world')
})

test('homestead: claim, buy, place, move, remove, raise the cottage, go in, rest at home', async ({ page }) => {
  const id = await freshPlayer(page)
  await earnEmbers(page, id)
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status).toBe('ready')
  let v = await homes(page)
  const mine = v.plots.find((p) => p.mine)!
  expect(mine.allocated).toBe(true)
  expect(v.claimed).toBe(false)
  await shot(page, 'commons-heart-desktop')

  // Claim: Silas walks you to it (the deed is his, shown to you).
  await silasSays(page, /Show me my plot/)
  await expect.poll(async () => (await homes(page)).claimed).toBe(true)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('paper:deed-of-sale-commons-plot')

  // Buy two pieces in his yard.
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await expect(shop).toBeVisible()
  await shot(page, 'silas-shop-desktop')
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Wooden Stool is yours')
  await shop.locator('[data-buy="potted-fern"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Potted Fern is yours')
  await expect(shop.locator('[data-buy="reading-chair"]')).toHaveText('Needs the cottage')
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()
  expect((await myHome(page, id)).items.map((i) => i.itemDef).sort()).toEqual(['potted-fern', 'wooden-stool'])

  // At the campsite: nothing can be set out yet (tier-required, shown plainly).
  v = await homes(page)
  const slot = v.slots[mine.slot]
  await go(page, 'commons', slot.doorstep.tx + 2, slot.doorstep.ty + 2)
  await shot(page, 'plot-campsite-desktop')
  await page.getByTestId('arrange').click()
  const tray = page.getByTestId('placement-tray')
  await expect(tray).toContainText('Silas needs to raise your cottage')
  await tray.locator('[data-piece="wooden-stool"]').click()
  await expect(tray.locator('.status')).toContainText('needs the cottage first')
  await expect(tray.getByRole('button', { name: /Set it here/ })).toBeDisabled()
  await tray.getByRole('button', { name: /Done/ }).click()
  await expect(tray).toBeHidden()

  // Home rest at the bedroll.
  await hurt(page, 6)
  await go(page, 'commons', slot.tx + 6, slot.ty + 4)
  await talk(page, /Rest at your bedroll/, /Rest a while/)
  await expect(page.locator('.toast', { hasText: 'Home, and rested' })).toBeVisible()
  await expect.poll(async () => (await serverState(page)).body.state.hp).toBe((await serverState(page)).body.state.maxHp)

  // Raise the cottage (15 embers); Orrin posts his foundation standard.
  const before = (await serverState(page)).body.state.embers
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page, id)).tier).toBe(1)
  expect((await serverState(page)).body.state.embers).toBe(before - 15)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('paper:orrins-drift-slap-foundation-standard')

  // Place outdoors, move it, put it away.
  await go(page, 'commons', slot.doorstep.tx + 2, slot.doorstep.ty + 2)
  await shot(page, 'plot-cottage-desktop')
  await page.getByTestId('arrange').click()
  await tray.locator('[data-piece="wooden-stool"]').click()
  await expect(tray.getByRole('button', { name: /Set it here/ })).toBeEnabled()
  await shot(page, 'placement-outdoor-desktop')
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')
  let stool = (await myHome(page, id)).items.find((i) => i.itemDef === 'wooden-stool')!
  expect(stool.scene).toBe('outdoor')
  const x0 = stool.x!
  await tray.locator('[data-piece="wooden-stool"]').click()
  await page.keyboard.press(x0 < 15 ? 'ArrowRight' : 'ArrowLeft')
  await tray.getByRole('button', { name: /Move here/ }).click()
  await expect(tray.locator('.status')).toContainText('moved')
  stool = (await myHome(page, id)).items.find((i) => i.itemDef === 'wooden-stool')!
  expect(stool.x).toBe(x0 < 15 ? x0 + 1 : x0 - 1)
  // A spot on the cottage itself is refused before anything is sent.
  await tray.locator('[data-piece="wooden-stool"]').click()
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp')
  const dx = 7 - stool.x!
  for (let i = 0; i < Math.abs(dx); i++) await page.keyboard.press(dx > 0 ? 'ArrowRight' : 'ArrowLeft')
  await expect(tray.locator('.status')).toContainText('already there')
  await expect(tray.getByRole('button', { name: /Move here/ })).toBeDisabled()
  await page.keyboard.press('x')
  await expect(tray.locator('.status')).toContainText('put away')
  stool = (await myHome(page, id)).items.find((i) => i.itemDef === 'wooden-stool')!
  expect(stool.scene).toBeNull()
  // Set it back out for the visitors.
  await tray.locator('[data-piece="wooden-stool"]').click()
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')
  await page.keyboard.press('Escape')
  await expect(tray).toBeHidden()

  // Go inside.
  await go(page, 'commons', slot.doorstep.tx, slot.doorstep.ty)
  await expect(page.locator('.prompt')).toContainText('Go inside')
  await page.keyboard.press('e')
  await waitForArea(page, 'home' as Area)
  await shot(page, 'interior-desktop')
  // The save still says Commons, on the doorstep (inside the plot).
  const st = (await serverState(page)).body.state
  expect(st.area).toBe('commons')

  // Arrange inside: the fern by the window.
  await page.getByTestId('arrange').click()
  await tray.locator('[data-piece="potted-fern"]').click()
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
  await shot(page, 'placement-indoor-desktop')
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')
  await page.keyboard.press('Escape')
  expect((await myHome(page, id)).items.find((i) => i.itemDef === 'potted-fern')!.scene).toBe('indoor')

  // Rest by your own hearth (a home rest: the save is on your plot).
  await hurt(page, 4)
  await place(page, 120, 66)
  await talk(page, /Rest by your hearth/, /Rest a while/)
  await expect(page.locator('.toast', { hasText: 'Home, and rested' }).last()).toBeVisible()

  // Back out through the door, onto the doorstep.
  await place(page, 112, 13 * 16 - 4)
  await page.keyboard.down('ArrowDown')
  await waitForArea(page, 'commons' as Area)
  await page.keyboard.up('ArrowDown')
  const p = await player(page)
  expect(Math.floor(p.x / 16)).toBe(slot.doorstep.tx)
})

test('visiting: a second player sees the first one’s place and walks into their cottage, read-only', async ({ page, browser, baseURL }) => {
  const a = await freshPlayer(page, 'Tansy')
  await earnEmbers(page, a)
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status).toBe('ready')
  await silasSays(page, /Show me my plot/)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page, a)).tier).toBe(1)
  const created = await page.request.post('/api/invites', { data: {} })
  expect(created.ok()).toBe(true)
  const code = (await created.json()).code as string

  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const errors: string[] = []
  other.on('pageerror', (e) => errors.push(e.message))
  await freshPlayer(other, 'Bram', code)
  await go(other, 'commons', 23, 19)
  await expect.poll(async () => (await homes(other)).plots.length).toBe(2)
  const v = await homes(other)
  const tansy = v.plots.find((p) => p.ownerId === a)!
  expect(tansy.name).toBe('Tansy')
  expect(tansy.tier).toBe(1)
  expect(v.plots.find((p) => p.mine)!.allocated).toBe(true)
  const slot = v.slots[tansy.slot]
  await go(other, 'commons', slot.doorstep.tx + 3, slot.doorstep.ty + 1)
  await shot(other, 'visiting-desktop')
  // No arranging someone else's place.
  await expect(other.getByTestId('arrange')).toHaveCount(0)
  await go(other, 'commons', slot.doorstep.tx, slot.doorstep.ty)
  await expect(other.locator('.prompt')).toContainText('Visit Tansy’s cottage')
  await other.keyboard.press('e')
  await waitForArea(other, 'home' as Area)
  await expect(other.locator('.area .title')).toHaveText('Tansy’s Place')
  await expect(other.getByTestId('arrange')).toHaveCount(0)
  await shot(other, 'visiting-interior-desktop')
  // Resting in someone else's home is not offered.
  await place(other, 120, 66)
  await expect(other.locator('.prompt')).toContainText('Sit by the hearth')
  expect(await area(other)).toBe('home')
  expect(errors).toEqual([])
  await ctx.close()
})
