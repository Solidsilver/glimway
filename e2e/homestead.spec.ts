import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from './fixtures'
import { serverState } from './connected'
import { beginNewJourney, waitForArea, player } from './helpers'
import { area, earnEmbers, freshPlayer, fund, go, homeAt, homes, hurt, lane, myHome, place, readOn, shot, silasSays, talk, throughGate, type Home } from './home-helpers'
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts'
import { LAND, buildableKind, clearable, clearedSet, effectiveKind, generateLand, homeLights, isLit } from '../src/lib/homestead-land.ts'

/**
 * Homesteads, second version, against the real Go server
 * (playwright.config.ts starts it with a fresh database): the Commons lane
 * of gates, claiming a deed and being led to your gate, your own land and
 * lantern-light expansion, a joint deed signed at Silas's table by two
 * players at once, leaving, and visiting. Each test signs in as new
 * Habitica ids; the lane is the world's, so tests read which gates are free.
 *
 * SCREENS=1 also saves review screenshots to .agent/screens/.
 */
test.use({ server: true })

const L = HOMESTEAD_DATA.land
const S = L.startLight

/** A tile on a home's land for a 1×1 piece, by what lights it and what stands there. */
function spotOn(home: Home, want: (x: number, y: number, k: number, litNow: boolean) => boolean): { x: number; y: number } {
  const land = generateLand(home.landSeed)
  const cleared = clearedSet(home.cleared)
  const posts = home.items.filter((i) => i.itemDef === 'lantern-post' && i.scene === 'outdoor') as { x: number; y: number }[]
  const lights = homeLights(posts)
  const reserved = (x: number, y: number) => HOMESTEAD_DATA.outdoorReserved.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
  const taken = (x: number, y: number) => home.items.some((i) => i.scene === 'outdoor' && i.x === x && i.y === y)
  // Nearest the home site first: the tray starts a piece near the hero.
  const order: [number, number][] = []
  for (let y = 1; y < land.height - 1; y++) for (let x = 1; x < land.width - 1; x++) order.push([x, y])
  order.sort((a, b) => Math.hypot(a[0] - S.x, a[1] - S.y) - Math.hypot(b[0] - S.x, b[1] - S.y))
  for (const [x, y] of order) {
    if (reserved(x, y) || taken(x, y)) continue
    if (want(x, y, effectiveKind(land, cleared, x, y), isLit(lights, x, y))) return { x, y }
  }
  throw new Error('no such spot on this land')
}

/** In the tray: pick a piece, then walk it to (x, y) with the arrow keys. */
async function carryTo(page: Page, piece: string, x: number, y: number): Promise<void> {
  const tray = page.getByTestId('placement-tray')
  await tray.locator(`[data-piece="${piece}"]`).first().click()
  await expect.poll(async () => (await homes(page)).placement?.spot ?? null).not.toBeNull()
  const at = (await homes(page)).placement!.spot!
  for (let i = 0; i < Math.abs(x - at.x); i++) await page.keyboard.press(x > at.x ? 'ArrowRight' : 'ArrowLeft')
  for (let i = 0; i < Math.abs(y - at.y); i++) await page.keyboard.press(y > at.y ? 'ArrowDown' : 'ArrowUp')
  await expect.poll(async () => (await homes(page)).placement?.spot).toEqual({ x, y, rotation: 0 })
}

/** Talk at the prompt and pick a choice in each conversation that follows, in order. */
async function converse(page: Page, prompt: RegExp, picks: RegExp[]): Promise<void> {
  await expect(page.locator('.prompt')).toContainText(prompt)
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  for (const pick of picks) {
    const choice = page.locator('.choice', { hasText: pick })
    for (let i = 0; i < 20 && !(await choice.isVisible().catch(() => false)); i++) {
      if (!(await page.locator('.choice').first().isVisible().catch(() => false))) await page.keyboard.press('e')
      await page.waitForTimeout(220)
    }
    await choice.click()
    await page.waitForTimeout(250)
  }
}

/** Claim the first unclaimed gate on the lane from Silas; returns the gate. */
async function claimFirstFree(page: Page): Promise<number> {
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status).toBe('ready')
  const free = (await homes(page)).gates.find((g) => g.homeId === null)!
  await silasSays(page, new RegExp(`The deed to Lot ${free.gate + 1}`))
  await expect.poll(async () => (await homes(page)).myGate).toBe(free.gate)
  return free.gate
}

test('the Commons gate: walk in from Hearthwick and back; guests walk the lane and the wild land behind a gate', async ({ page }) => {
  await beginNewJourney(page)
  // The village's east gate, below the Lantern Road.
  await go(page, 'village', 39, 15)
  await page.keyboard.down('ArrowRight')
  await waitForArea(page, 'commons')
  await page.keyboard.up('ArrowRight')
  expect((await player(page)).x).toBeLessThan(6 * 16)
  await expect(page.locator('.area .title')).toHaveText('Hearthwick Commons')

  // Guests see spare gates of wild land, and Silas tells them about worlds.
  const v = await homes(page)
  expect(v.status).toBe('guest')
  expect(v.slots.length).toBe(HOMESTEAD_DATA.commons.spareGates)
  await go(page, 'commons', v.slots[0].entry.tx, v.slots[0].entry.ty)
  await shot(page, 'commons-lane-guest-desktop')
  await silasSays(page)

  // Through a gate: wild land, nobody's, and back out onto the lane.
  await throughGate(page, 0)
  await expect(page.locator('.area .title')).toHaveText('Unclaimed land')
  await expect(page.getByTestId('arrange')).toHaveCount(0)
  await shot(page, 'land-wild-guest-desktop')
  await page.keyboard.down('ArrowDown')
  await waitForArea(page, 'commons')
  await page.keyboard.up('ArrowDown')
  const p = await player(page)
  expect(Math.floor(p.x / 16)).toBe(v.slots[0].entry.tx)

  // And back out through the village gate.
  await go(page, 'commons', 2, 21)
  await page.keyboard.down('ArrowLeft')
  await waitForArea(page, 'village')
  await page.keyboard.up('ArrowLeft')
  expect((await player(page)).x).toBeGreaterThan(36 * 16)
})

test('a guest hears that deeds are for people with a world', async ({ page }) => {
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

test('claim and guidance, then expansion: lantern posts, naming, clearing, cottage, rest at home', async ({ page }) => {
  test.setTimeout(240_000)
  const id = await freshPlayer(page)
  await earnEmbers(page, id)
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status).toBe('ready')
  let v = await homes(page)
  expect(v.claimed).toBe(false)
  expect(v.gates.filter((g) => g.homeId === null).length).toBeGreaterThanOrEqual(HOMESTEAD_DATA.commons.spareGates)
  const free = v.gates.find((g) => g.homeId === null)!
  expect(free.price).toBe(0) // the first deed is on the Compact

  // Read the sign at the gate you like, then buy its deed from Silas.
  const slot = v.slots.find((s) => s.gate === free.gate)!
  await go(page, 'commons', slot.entry.tx, slot.entry.ty + 1)
  await talk(page, new RegExp(`Read the sign · Lot ${free.gate + 1}`))
  const embers = (await serverState(page)).body.state.embers
  await silasSays(page, new RegExp(`The deed to Lot ${free.gate + 1}`))
  await expect.poll(async () => (await homes(page)).myGate).toBe(free.gate)
  expect((await serverState(page)).body.state.embers).toBe(embers)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('paper:deed-of-sale-commons-plot')

  // Guidance: the journal and the HUD say where, and a marker leads there.
  await expect(page.getByTestId('home-goal')).toContainText(`Lot ${free.gate + 1}`)
  v = await homes(page)
  expect(v.guide).not.toBeNull()
  expect(v.guide!.arrow).toBe(true) // the gate is off screen from Silas's yard
  await shot(page, 'claim-guidance-desktop')
  await page.keyboard.press('j')
  await expect(page.getByTestId('journal-home-goal')).toContainText(`Lot ${free.gate + 1}`)
  await page.keyboard.press('j')
  await go(page, 'commons', slot.entry.tx + (slot.side === 'west' ? 2 : -2), slot.entry.ty)
  expect((await homes(page)).guide!.arrow).toBe(false)
  await shot(page, 'claim-marker-desktop')

  // Through the gate: your land. The guidance is done.
  await throughGate(page, free.gate)
  await expect(page.locator('.area .title')).toHaveText('Your land')
  await expect(page.getByTestId('home-goal')).toHaveCount(0)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('home:arrived')
  await shot(page, 'land-camp-desktop')

  // Buy a stool and two lantern posts; the second post costs more.
  fund(id, { materials: { timber: 40, stone: 30, amber: 6, fiber: 10 } })
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  const first = HOMESTEAD_DATA.lanternPosts.costs[0]
  await expect(shop.locator('.row', { hasText: 'Lantern Post' })).toContainText(`${first.timber} timber`)
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Wooden Stool is yours')
  await shop.locator('[data-buy="lantern-post"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Lantern Post is yours')
  const second = HOMESTEAD_DATA.lanternPosts.costs[1]
  await expect(shop.locator('.row', { hasText: 'Lantern Post' })).toContainText(`${second.timber} timber`)
  await shot(page, 'silas-shop-desktop')
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()
  let home = await myHome(page)
  expect(home.postsBought).toBe(1)
  expect(home.items.map((i) => i.itemDef).sort()).toEqual(['lantern-post', 'wooden-stool'])

  // Back on the land: a campsite can set out a stool on lit, open ground.
  await throughGate(page, free.gate)
  const tray = page.getByTestId('placement-tray')
  const near = spotOn(home, (x, y, k, lit) => lit && buildableKind(k) && Math.abs(x - S.x) <= 4 && y > S.y)
  await go(page, `home:${free.gate}`, near.x, near.y + 1)
  await page.getByTestId('arrange').click()
  await carryTo(page, 'wooden-stool', near.x, near.y)
  await expect(tray.getByRole('button', { name: /Set it here/ })).toBeEnabled()
  await shot(page, 'placement-land-desktop')
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')

  // Past the lamplight, the stool is refused before anything is sent.
  home = await myHome(page)
  const edge = spotOn(home, (x, y, k, lit) => lit && buildableKind(k) && (x - S.x) ** 2 + (y - S.y) ** 2 >= (S.radius - 1) ** 2 && y >= S.y - 2)
  const beyond = spotOn(home, (x, y, k, lit) => !lit && buildableKind(k) && (x - edge.x) ** 2 + (y - edge.y) ** 2 <= (HOMESTEAD_DATA.lanternPosts.radius - 1) ** 2)
  await carryTo(page, 'wooden-stool', beyond.x, beyond.y)
  await expect(tray.locator('.status')).toContainText('past your lamplight')
  await expect(tray.getByRole('button', { name: /Move here/ })).toBeDisabled()
  await tray.getByRole('button', { name: 'Cancel' }).click()

  // A lantern post at the edge, named: the ground in its light is yours.
  await carryTo(page, 'lantern-post', edge.x, edge.y)
  await page.keyboard.press('e')
  const prompt = page.getByTestId('name-prompt')
  await expect(prompt).toBeVisible()
  // The E that set it down never lands in the name field.
  await expect(page.getByTestId('name-input')).toHaveValue('')
  await shot(page, 'name-lamp-desktop')
  await page.getByTestId('name-input').fill('  The   Wren ')
  await page.getByTestId('name-submit').click()
  await expect(tray.locator('.status')).toContainText('“The Wren” is lit')
  home = await myHome(page)
  const post = home.items.find((i) => i.itemDef === 'lantern-post')!
  expect([post.scene, post.x, post.y, post.name]).toEqual(['outdoor', edge.x, edge.y, 'The Wren'])
  await carryTo(page, 'wooden-stool', beyond.x, beyond.y)
  await expect(tray.getByRole('button', { name: /Move here/ })).toBeEnabled()
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('moved')
  expect((await myHome(page)).items.find((i) => i.itemDef === 'wooden-stool')).toMatchObject({ x: beyond.x, y: beyond.y })
  await shot(page, 'land-lantern-desktop')
  // The post now holds that ground: it can't be put away from under the stool.
  await tray.locator('[data-piece="lantern-post"]').click()
  await page.keyboard.press('x')
  await expect(tray.locator('.status')).toContainText('holding up ground')
  await tray.getByRole('button', { name: 'Cancel' }).click()

  // A tree in your light: Silas clears it for an ember, and the map opens up.
  home = await myHome(page)
  const tree = (() => {
    try {
      return spotOn(home, (_x, _y, k, lit) => lit && clearable(k))
    } catch {
      return null
    }
  })()
  if (tree) {
    const before = (await serverState(page)).body.state.embers
    await page.evaluate(([tx, ty]) => {
      const w = window as unknown as { __fsDevTapTile?: (x: number, y: number) => void }
      w.__fsDevTapTile?.(tx, ty)
    }, [tree.x, tree.y] as const)
    await expect(page.getByTestId('clear-tile')).toBeVisible()
    await page.getByTestId('clear-tile').click()
    await expect.poll(async () => (await myHome(page)).cleared).toContainEqual([tree.x, tree.y])
    expect((await serverState(page)).body.state.embers).toBe(before - HOMESTEAD_DATA.clearTileEmbers)
    await waitForArea(page, `home:${free.gate}`)
    expect(generateLand(home.landSeed).tiles[tree.y * L.width + tree.x]).not.toBe(LAND.GRASS)
  } else if (await tray.isVisible()) {
    await tray.getByRole('button', { name: /Done/ }).click()
  }
  if (await tray.isVisible()) await tray.getByRole('button', { name: /Done/ }).click()

  // Home rest at the bedroll (your own land).
  const land = (await homes(page)).land!
  await hurt(page, 6)
  await go(page, `home:${free.gate}`, Math.floor((land.site.x * 16 - 64 + 96) / 16), Math.floor((land.site.y * 16 + 52) / 16))
  await talk(page, /Rest at your bedroll/, /Rest a while/)
  await expect(page.locator('.toast', { hasText: 'Home, and rested' })).toBeVisible()

  // Raise the cottage, go inside; the save stays on your land, by the door.
  const embers2 = (await serverState(page)).body.state.embers
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  expect((await serverState(page)).body.state.embers).toBe(embers2 - 15)
  await throughGate(page, free.gate)
  await go(page, `home:${free.gate}`, land.doorstep.tx + 1, land.doorstep.ty + 3)
  await shot(page, 'land-cottage-desktop')
  await go(page, `home:${free.gate}`, land.doorstep.tx, land.doorstep.ty)
  await expect(page.locator('.prompt')).toContainText('Go inside')
  await page.keyboard.press('e')
  await waitForArea(page, 'cottage')
  expect((await serverState(page)).body.state.area).toBe(`home:${free.gate}`)
  await hurt(page, 4)
  await place(page, 181, 66)
  await talk(page, /Rest by your hearth/, /Rest a while/)
  await expect(page.locator('.toast', { hasText: 'Home, and rested' }).last()).toBeVisible()
  await place(page, 112, 13 * 16 - 4)
  await page.keyboard.down('ArrowDown')
  await waitForArea(page, `home:${free.gate}`)
  await page.keyboard.up('ArrowDown')
  expect(Math.floor((await player(page)).x / 16)).toBe(land.doorstep.tx)
})

test('a joint deed: two players sign at Silas’s table together; then one leaves and keeps their pack', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const a = await freshPlayer(page, 'Tansy')
  await earnEmbers(page, a)
  const gate = await claimFirstFree(page)
  const created = await page.request.post('/api/invites', { data: {} })
  expect(created.ok()).toBe(true)
  const code = (await created.json()).code as string

  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const errors: string[] = []
  other.on('pageerror', (e) => errors.push(e.message))
  const b = await freshPlayer(other, 'Bram', code)
  fund(b, { materials: { timber: 10, stone: 6, amber: 2 } })

  // Both at the table (presence: same room, near Silas).
  const silas = (await homes(page)).features!.silas
  await go(other, 'commons', silas.tx, silas.ty + 1)
  await go(page, 'commons', silas.tx, silas.ty + 1)
  const peers = (p: Page) => p.evaluate(() => (window as unknown as { __fsPresence: () => { peers: string[] } }).__fsPresence().peers)
  await expect.poll(() => peers(page), { timeout: 20_000 }).toContain(b)
  await expect.poll(() => peers(other), { timeout: 20_000 }).toContain(a)

  // Tansy offers the deed to Bram and signs her side.
  await converse(page, /Talk to Silas/, [/Share the deed/, /Bram/])
  await readOn(page, /Your name’s down/)
  await expect.poll(async () => (await lane(other)).invites.length).toBe(1)
  await shot(other, 'joint-deed-offer-desktop')

  // Bram signs at the table within the window: both names on one deed.
  await talk(other, /Talk to Silas/, /Sign Tansy’s deed/)
  await readOn(other, /Both names/)
  await expect.poll(async () => (await homes(other)).myGate).toBe(gate)
  await expect.poll(async () => (await myHome(page)).members.map((m) => m.displayName).sort()).toEqual(['Bram', 'Tansy'])
  // Tansy's game, waiting on the signature, hears of it without asking again.
  await expect.poll(async () => (await homes(page)).mine?.members.length ?? 0, { timeout: 15_000 }).toBe(2)
  // Equal members: Bram can build on the land too.
  await silasSays(other, /See what you’ve finished/)
  const shop = other.getByRole('dialog', { name: 'Silas’s Yard' })
  await shop.locator('[data-buy="lantern-post"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Lantern Post is yours')
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()
  expect((await myHome(page)).postsBought).toBe(1)
  await throughGate(other, gate)
  await expect(other.locator('.area .title')).toHaveText('Your land')
  await expect(other.getByTestId('arrange')).toBeVisible()
  await shot(other, 'joint-deed-land-desktop')

  // Bram leaves the deed: he keeps his pack (the post he bought), the land stays Tansy's.
  await silasSays(other, /Give up my place on the deed/)
  const confirm = other.getByRole('alertdialog', { name: /Give up your place/ })
  await expect(confirm).toBeVisible()
  await shot(other, 'leave-confirm-desktop')
  await confirm.getByRole('button', { name: 'Strike my name' }).click()
  await readOn(other, /I’ll strike your name/)
  await expect.poll(async () => (await lane(other)).mine).toBeNull()
  expect((await myHome(page)).members.map((m) => m.displayName)).toEqual(['Tansy'])
  // Not on a deed any more: no home chest for him; his post is still in his pack (mail can send it).
  expect((await other.request.get('/api/storage')).status()).toBe(409)
  const carried = await (await other.request.get('/api/mail')).json()
  expect(carried.inventory.decorations['lantern-post']).toBe(1)
  expect(errors).toEqual([])
  await ctx.close()
})

test('visiting: a second player walks through a neighbour’s gate, sees their place and cottage, read-only', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const a = await freshPlayer(page, 'Tansy')
  await earnEmbers(page, a)
  const gate = await claimFirstFree(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  const created = await page.request.post('/api/invites', { data: {} })
  const code = (await created.json()).code as string

  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const errors: string[] = []
  other.on('pageerror', (e) => errors.push(e.message))
  await freshPlayer(other, 'Bram', code)
  await go(other, 'commons', 23, 19)
  await expect.poll(async () => (await homes(other)).gates.find((g) => g.gate === gate)?.names ?? []).toEqual(['Tansy'])
  const info = (await homes(other)).gates.find((g) => g.gate === gate)!
  expect(info.mine).toBe(false)
  expect(info.tier).toBe(1)
  const slot = (await homes(other)).slots.find((s) => s.gate === gate)!
  await go(other, 'commons', slot.entry.tx, slot.entry.ty + 1)
  await talk(other, new RegExp(`Read the sign · Lot ${gate + 1}`))
  await shot(other, 'visiting-lane-desktop')

  // Through Tansy's gate: her land, read-only (no arranging, no resting).
  await throughGate(other, gate)
  await expect(other.locator('.area .title')).toHaveText('Tansy’s Place')
  await expect(other.getByTestId('arrange')).toHaveCount(0)
  expect((await homeAt(other, gate))!.member).toBe(false)
  // Each land is its own presence room: Tansy walks home and they see each other there.
  await throughGate(page, gate)
  const peers = (p: Page) => p.evaluate(() => (window as unknown as { __fsPresence: () => { area: string | null; peers: string[] } }).__fsPresence())
  await expect.poll(async () => (await peers(other)).peers, { timeout: 20_000 }).toContain(a)
  expect((await peers(other)).area).toBe(`home:${gate}`)
  await shot(other, 'visiting-land-desktop')
  const land = (await homes(other)).land!
  await go(other, `home:${gate}`, land.doorstep.tx, land.doorstep.ty)
  await expect(other.locator('.prompt')).toContainText('Visit the cottage')
  await other.keyboard.press('e')
  await waitForArea(other, 'cottage')
  await expect(other.locator('.area .title')).toHaveText('Tansy’s Place')
  await expect(other.getByTestId('arrange')).toHaveCount(0)
  await shot(other, 'visiting-interior-desktop')
  await place(other, 181, 66)
  await expect(other.locator('.prompt')).toContainText('Sit by the hearth')
  expect(await area(other)).toBe('cottage')
  // The visitor's save is on Tansy's land: they show up in its presence room.
  expect((await serverState(other)).body.state.area).toBe(`home:${gate}`)
  expect(errors).toEqual([])
  await ctx.close()
})


test('desolation: an empty homestead overgrows, its sign weathers, and in time the deed is lost', async ({ page }) => {
  test.setTimeout(180_000)
  const a = await freshPlayer(page, 'Tansy')
  await earnEmbers(page, a)
  const gate = await claimFirstFree(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  // The last name off the deed: the land is empty from now. The confirmation
  // says how long it waits.
  const leaveNow = async () => {
    await silasSays(page, /Give up my place on the deed/)
    const confirm = page.getByRole('alertdialog', { name: /Give up your place/ })
    await expect(confirm).toContainText(`${HOMESTEAD_DATA.desolation.deedLostAfterDays} days`)
    await confirm.getByRole('button', { name: 'Strike my name' }).click()
    await readOn(page, /I’ll strike your name/)
    await expect.poll(async () => (await lane(page)).mine).toBeNull()
  }
  await leaveNow()
  expect((await homeAt(page, gate))!.desolate).toBe(false)
  // Changed her mind: Silas gives the deed back, as it stands, for nothing.
  const embers = (await serverState(page)).body.state.embers
  await silasSays(page, new RegExp(`Take back Lot ${gate + 1}`))
  await expect.poll(async () => (await lane(page)).mine?.gate).toBe(gate)
  expect((await myHome(page)).tier).toBe(1)
  expect((await serverState(page)).body.state.embers).toBe(embers)
  await leaveNow()

  // Days pass (the e2e database's clock is moved back instead).
  const ago = (days: number) =>
    execFileSync('sqlite3', ['-cmd', '.timeout 5000', '.e2e-server/fingersnap.sqlite', `UPDATE homesteads SET vacant_since=strftime('%s','now')-${days}*86400 WHERE gate=${gate} AND world_id=(SELECT world_id FROM players WHERE habitica_id='${a}');`])
  ago(HOMESTEAD_DATA.desolation.desolateAfterDays)
  const home = (await homeAt(page, gate))!
  expect(home.desolate).toBe(true)
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).gates.find((g) => g.gate === gate)?.desolate).toBe(true)
  const slot = (await homes(page)).slots.find((s) => s.gate === gate)!
  await go(page, 'commons', slot.entry.tx, slot.entry.ty + 1)
  await shot(page, 'desolate-sign-desktop')
  await throughGate(page, gate)
  await expect.poll(async () => (await homes(page)).land?.desolate).toBe(true)
  await expect(page.getByTestId('arrange')).toHaveCount(0)
  await shot(page, 'desolate-land-desktop')

  // Longer still: the deed is lost and the land is unclaimed again, for a price.
  ago(HOMESTEAD_DATA.desolation.deedLostAfterDays)
  expect(await homeAt(page, gate)).toBeNull()
  const row = (await lane(page)).gates.find((g) => g.gate === gate)!
  expect(row.homeId).toBeNull()
  expect(row.price).toBe(HOMESTEAD_DATA.deeds.embers)
})
