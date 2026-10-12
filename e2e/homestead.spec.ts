import { expect, test, type Page } from './fixtures'
import { serverState, sql, accountOf, CONTRACT, served } from './connected'
import { waitForArea, waitForLive, player, expectAreaCard, expectToast, SERVER_ANSWER_MS } from './helpers'
import { area, earnGlims, freshPlayer, fund, go, homeAt, homes, hurt, landOf, lane, myHome, place, readOn, shot, silasSays, talk, throughGate, type Home, DEED_BOUGHT, yardBuild, pellSays, DEEDS, AT_PELL, manageDeed, giveUpPlace } from './home-helpers'
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts'
import { LAND, buildableKind, clearable, clearedSet, effectiveKind, homeLights, isLit, type Land } from '../src/lib/homestead-land.ts'

/**
 * Homesteads, second version, against the real Go server
 * (playwright.config.ts starts it with a fresh database): the Commons lane
 * of gates, claiming a deed and being led to your gate, your own land and
 * lantern-light expansion, a joint deed signed at the deed table in Pell's
 * office by two players at once, leaving, and visiting. Each test signs in as new
 * Habitica ids; the lane is the world's, so tests read which gates are free.
 *
 * SCREENS=1 also saves review screenshots to .agent/screens/.
 */

const L = HOMESTEAD_DATA.land
const S = L.startLight

/** A tile on a home's land for a 1×1 piece, by what lights it and what stands there. */
function spotOn(home: Home, land: Land, want: (x: number, y: number, k: number, litNow: boolean) => boolean): { x: number; y: number } {
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

/** Claim the first unclaimed gate on the lane from Pell; returns the gate. */
async function claimFirstFree(page: Page): Promise<number> {
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status).toBe('ready')
  const free = (await homes(page)).gates.find((g) => g.homeId === null)!
  await pellSays(page, new RegExp(`The deed to Lot ${free.gate + 1}`))
  await expect.poll(async () => (await homes(page)).myGate).toBe(free.gate)
  // Pell answers once the server has the claim: read it (it would hold the screen).
  await readOn(page, DEED_BOUGHT)
  await go(page, 'commons', 23, 19)
  return free.gate
}

test('the Commons gate: walk in from Hearthwick and back, and through an unclaimed gate', async ({ page }) => {
  await freshPlayer(page)
  // The village's east gate, below the Lantern Road.
  await go(page, 'village', 39, 15)
  await page.keyboard.down('ArrowRight')
  await waitForArea(page, 'commons')
  await page.keyboard.up('ArrowRight')
  expect((await player(page)).x).toBeLessThan(6 * 16)
  await expectAreaCard(page, 'Hearthwick Commons')

  // The lane shows its spare gates, and the sign at one says what it is.
  const v = await homes(page)
  expect(v.gates.filter((g) => g.homeId === null).length).toBeGreaterThanOrEqual(HOMESTEAD_DATA.commons.spareGates)
  await go(page, 'commons', v.slots[0].entry.tx, v.slots[0].entry.ty)
  await talk(page, new RegExp(`Read the sign · Lot ${v.slots[0].gate + 1}`))

  // Through a gate: wild land, nobody's, and back out onto the lane.
  await throughGate(page, 0)
  await expectAreaCard(page, 'Unclaimed land')
  await expect(page.getByTestId('arrange')).toHaveCount(0)
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

test('claim and guidance, then expansion: lantern posts, naming, clearing, cottage, rest at home', async ({ page }) => {
  test.setTimeout(240_000)
  const id = await freshPlayer(page)
  await earnGlims(page, id)
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status).toBe('ready')
  let v = await homes(page)
  expect(v.claimed).toBe(false)
  expect(v.gates.filter((g) => g.homeId === null).length).toBeGreaterThanOrEqual(HOMESTEAD_DATA.commons.spareGates)
  const free = v.gates.find((g) => g.homeId === null)!
  expect(free.price).toBe(0) // the first deed is on the Compact

  // Read the sign at the gate you like, then buy its deed from Pell (the sign's gate is offered first).
  const slot = v.slots.find((s) => s.gate === free.gate)!
  await go(page, 'commons', slot.entry.tx, slot.entry.ty + 1)
  await talk(page, new RegExp(`Read the sign · Lot ${free.gate + 1}`))
  const glims = (await serverState(page)).body.state.glims
  await pellSays(page, new RegExp(`The deed to Lot ${free.gate + 1}`))
  await expect.poll(async () => (await homes(page)).myGate).toBe(free.gate)
  // Pell answers once the server has the claim: read it (it would hold the screen).
  await readOn(page, DEED_BOUGHT)
  expect((await serverState(page)).body.state.glims).toBe(glims)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('paper:deed-of-sale-commons-plot')

  // Guidance: the journal and the HUD say where, and out on the lane a marker leads there.
  await expect(page.getByTestId('home-goal')).toContainText(`Lot ${free.gate + 1}`)
  await go(page, 'commons', 53, 19)
  await expect.poll(async () => (await homes(page)).guide).not.toBeNull()
  v = await homes(page)
  expect(v.guide!.arrow).toBe(true) // the gate is off screen from the Yard's door
  await shot(page, 'claim-guidance-desktop')
  await page.keyboard.press('j')
  await expect(page.getByTestId('journal-home-goal')).toContainText(`Lot ${free.gate + 1}`)
  await page.keyboard.press('j')
  await go(page, 'commons', slot.entry.tx + (slot.side === 'west' ? 2 : -2), slot.entry.ty)
  expect((await homes(page)).guide!.arrow).toBe(false)
  await shot(page, 'claim-marker-desktop')

  // Through the gate: your land. The guidance is done.
  await throughGate(page, free.gate)
  await expectAreaCard(page, 'Your land')
  await expect(page.getByTestId('home-goal')).toHaveCount(0)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('home:arrived')
  await shot(page, 'land-camp-desktop')

  // Buy a stool and two lantern posts; the second post costs more.
  fund(id, { materials: { timber: 40, stone: 30, amber: 6, fiber: 10 } })
  await silasSays(page, /See the Yard/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  const first = HOMESTEAD_DATA.lanternPosts.costs[0]!.materials
  await expect(shop.locator('.row', { hasText: 'Lantern Post' })).toContainText(`${first.timber} timber`)
  // A camp opens on Build (the cottage is next); the stool is on Furnish.
  await shop.getByRole('tab', { name: 'Furnish' }).click()
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Wooden Stool is yours')
  await shop.getByRole('tab', { name: 'Build' }).click()
  await shop.locator('[data-buy="lantern-post"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Lantern Post is yours')
  const second = HOMESTEAD_DATA.lanternPosts.costs[1]!.materials
  await expect(shop.locator('.row', { hasText: 'Lantern Post' })).toContainText(`${second.timber} timber`)
  await shot(page, 'silas-shop-desktop')
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()
  let home = await myHome(page)
  expect(home.postsBought).toBe(1)
  expect(home.items.map((i) => i.itemDef).sort()).toEqual(['lantern-post', 'wooden-stool'])

  // Back on the land: a campsite can set out a stool on lit, open ground.
  await throughGate(page, free.gate)
  const tray = page.getByTestId('placement-tray')
  const ground = await landOf(page, free.gate)
  const near = spotOn(home, ground, (x, y, k, lit) => lit && buildableKind(k) && Math.abs(x - S.x) <= 4 && y > S.y)
  await go(page, `home:${free.gate}`, near.x, near.y + 1)
  await page.getByTestId('arrange').click()
  await carryTo(page, 'wooden-stool', near.x, near.y)
  await expect(tray.getByRole('button', { name: /Set it here/ })).toBeEnabled()
  await shot(page, 'placement-land-desktop')
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')

  // Past the lamplight, the stool is refused before anything is sent.
  home = await myHome(page)
  const edge = spotOn(home, ground, (x, y, k, lit) => lit && buildableKind(k) && (x - S.x) ** 2 + (y - S.y) ** 2 >= (S.radius - 1) ** 2 && y >= S.y - 2)
  const beyond = spotOn(home, ground, (x, y, k, lit) => !lit && buildableKind(k) && (x - edge.x) ** 2 + (y - edge.y) ** 2 <= (HOMESTEAD_DATA.lanternPosts.radius - 1) ** 2)
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

  // A tree in your light: Silas clears it for a glim, and the map opens up.
  home = await myHome(page)
  const tree = (() => {
    try {
      return spotOn(home, ground, (_x, _y, k, lit) => lit && clearable(k))
    } catch {
      return null
    }
  })()
  if (tree) {
    const before = (await serverState(page)).body.state.glims
    await page.evaluate(([tx, ty]) => {
      const w = window as unknown as { __fsDevTapTile?: (x: number, y: number) => void }
      w.__fsDevTapTile?.(tx, ty)
    }, [tree.x, tree.y] as const)
    await expect(page.getByTestId('clear-tile')).toBeVisible()
    await page.getByTestId('clear-tile').click()
    await expect.poll(async () => (await myHome(page)).cleared).toContainEqual([tree.x, tree.y])
    expect((await serverState(page)).body.state.glims).toBe(before - HOMESTEAD_DATA.clearTileGlims)
    await waitForArea(page, `home:${free.gate}`)
    expect(ground.tiles[tree.y * L.width + tree.x]).not.toBe(LAND.GRASS)
  } else if (await tray.isVisible()) {
    await tray.getByRole('button', { name: /Done/ }).click()
  }
  if (await tray.isVisible()) await tray.getByRole('button', { name: /Done/ }).click()

  // Home rest at the bedroll (your own land).
  const land = (await homes(page)).land!
  await hurt(page, 6)
  await go(page, `home:${free.gate}`, Math.floor((land.site.x * 16 - 64 + 96) / 16), Math.floor((land.site.y * 16 + 52) / 16))
  await talk(page, /Rest at your bedroll/, /Rest a while/)
  await expectToast(page, 'Home, and rested')

  // Raise the cottage, go inside: the cottage is a place of its own, saved inside.
  const embers2 = (await serverState(page)).body.state.glims
  await yardBuild(page, 'cottage')
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  expect((await serverState(page)).body.state.glims).toBe(embers2 - 15)
  await throughGate(page, free.gate)
  await go(page, `home:${free.gate}`, land.doorstep.tx + 1, land.doorstep.ty + 3)
  await shot(page, 'land-cottage-desktop')
  await go(page, `home:${free.gate}`, land.doorstep.tx, land.doorstep.ty)
  await expect(page.locator('.prompt')).toContainText('Go inside')
  await page.keyboard.press('e')
  await waitForArea(page, `in:home:${free.gate}`)
  await expect.poll(async () => (await serverState(page)).body.state.area).toBe(`in:home:${free.gate}`)
  await hurt(page, 4)
  await place(page, 181, 66)
  await talk(page, /Rest by your hearth/, /Rest a while/)
  await expectToast(page, 'Home, and rested')
  await place(page, 112, 13 * 16 - 4)
  await page.keyboard.down('ArrowDown')
  await waitForArea(page, `home:${free.gate}`)
  await page.keyboard.up('ArrowDown')
  expect(Math.floor((await player(page)).x / 16)).toBe(land.doorstep.tx)
})

/**
 * The partner as this page sees them: drawn at the deed table, from a
 * position the server relayed (presence), not just their name in the room's
 * roster. The deed needs both near the table on the server's side; a roster
 * sent on joining says nothing of where they stand (review 2026-10-11,
 * server 5: a join's first position can be held back by the last room's
 * throttle, and this wait is where that shows).
 */
async function seenAtTable(page: Page, accountId: string): Promise<void> {
  const t = HOMESTEAD_DATA.commons.deedTable
  const seen = () =>
    page.evaluate((id) => ((window as unknown as { __fsRemote?: () => { id: string; x: number; y: number }[] }).__fsRemote?.() ?? []).find((p) => p.id === id) ?? null, accountId)
  await expect
    .poll(async () => {
      const p = await seen()
      return !!p && Math.hypot(p.x - t.x, p.y - t.y) <= t.radius
    }, { timeout: SERVER_ANSWER_MS, message: `${accountId} drawn at the deed table (${t.x},${t.y} r${t.radius})` })
    .toBe(true)
    .catch(async (e: unknown) => {
      const peers = await page.evaluate(() => (window as unknown as { __fsPresence: () => unknown }).__fsPresence())
      throw new Error(`${String(e).slice(0, 300)}\nlast drawn: ${JSON.stringify(await seen())}; presence: ${JSON.stringify(peers)}`)
    })
}

test('a joint deed: two players sign at the deed table in Pell’s office', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const a = await freshPlayer(page, 'Tansy')
  await earnGlims(page, a)
  const gate = await claimFirstFree(page)
  const created = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  expect(created.ok()).toBe(true)
  const code = (await created.json()).code as string

  const ctx = await browser.newContext({ baseURL })
  try {
    const other = await ctx.newPage()
    const errors: string[] = []
    other.on('pageerror', (e) => errors.push(e.message))
    const b = await freshPlayer(other, 'Bram', code)
    fund(b, { materials: { timber: 10, stone: 6, amber: 2 } })

    // Both at the deed table in Pell's office (presence: the room, within the
    // table's reach), each drawn there on the other's screen, input live on both.
    await go(other, DEEDS, AT_PELL.tx, AT_PELL.ty)
    await go(page, DEEDS, AT_PELL.tx, AT_PELL.ty)
    await seenAtTable(page, accountOf(b))
    await seenAtTable(other, accountOf(a))
    await waitForLive(page)
    await waitForLive(other)

    // Tansy asks Pell for her deed, offers it to Bram from the panel, and signs her side.
    const deed = await manageDeed(page)
    await deed.locator(`[data-offer="${accountOf(b)}"]`).click({ timeout: SERVER_ANSWER_MS })
    await expect(deed.getByTestId('deed-message')).toContainText('Your name’s down', { timeout: SERVER_ANSWER_MS })
    await expect.poll(async () => (await lane(other)).invites.length, { timeout: SERVER_ANSWER_MS, message: 'Bram has the offer' }).toBe(1)
    await deed.getByRole('button', { name: 'Close your deed' }).click()
    await shot(other, 'joint-deed-offer-desktop')

    // Bram signs at the table, with Pell, within the window: both names on one deed.
    await pellSays(other, /Sign Tansy’s deed/)
    // Pell's offer itself says "Two names, one entry": wait for the line after the signature, which comes
    // with the server's answer (on a slow runner, well after talk() has read the offer).
    await readOn(other, /Two names, one entry, blotted/, { timeout: SERVER_ANSWER_MS })
    await expect.poll(async () => (await homes(other)).myGate, { timeout: SERVER_ANSWER_MS, message: 'Bram’s game adopts the deed' }).toBe(gate)
    await expect.poll(async () => (await myHome(page)).members.map((m) => m.displayName).sort(), { timeout: SERVER_ANSWER_MS }).toEqual(['Bram', 'Tansy'])
    // Tansy's game, waiting on the signature, hears of it without asking again.
    await expect.poll(async () => (await homes(page)).mine?.members.length ?? 0, { timeout: SERVER_ANSWER_MS }).toBe(2)
    // Equal members: Bram can build on the land too.
    await silasSays(other, /See the Yard/)
    const shop = other.getByRole('dialog', { name: 'Silas’s Yard' })
    await shop.locator('[data-buy="lantern-post"]').click()
    await expect(shop.locator('.msg.ok')).toContainText('Lantern Post is yours', { timeout: SERVER_ANSWER_MS })
    await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()
    expect((await myHome(page)).postsBought).toBe(1)
    await throughGate(other, gate)
    await expectAreaCard(other, 'Your land')
    await expect(other.getByTestId('arrange')).toBeVisible()
    await shot(other, 'joint-deed-land-desktop')
    expect(errors).toEqual([])
  } finally {
    await ctx.close()
  }
})

test('one of a joint deed gives up their place and keeps their pack; the land stays the other’s', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000)
  const a = await freshPlayer(page, 'Tansy')
  const created = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  expect(created.ok()).toBe(true)
  const code = (await created.json()).code as string
  const ctx = await browser.newContext({ baseURL })
  try {
    const other = await ctx.newPage()
    const errors: string[] = []
    other.on('pageerror', (e) => errors.push(e.message))
    const b = await freshPlayer(other, 'Bram', code)
    // A joint deed as the signing leaves it (the signing is the test above):
    // both on lot 1, a deed each on record (signing counts one for Bram too:
    // his next is not a free first), and a post Bram bought for it in his pack.
    const world = (await serverState(page)).body.worldId as string
    const home = `home-joint-${accountOf(a)}`
    const now = Math.floor(Date.now() / 1000)
    sql(`INSERT INTO homesteads(id,world_id,gate,tier,posts_bought,claimed_at) VALUES('${home}','${world}',0,0,1,${now});
INSERT INTO homestead_members VALUES('${accountOf(a)}','${home}',${now}), ('${accountOf(b)}','${home}',${now + 1});
INSERT INTO player_deeds VALUES('${accountOf(a)}',1), ('${accountOf(b)}',1);
INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('post-${accountOf(b)}','lantern-post','inventory','${accountOf(b)}');`)
    await expect.poll(async () => (await myHome(page)).members.map((m) => m.displayName).sort(), { timeout: SERVER_ANSWER_MS }).toEqual(['Bram', 'Tansy'])

    // Bram gives up his place (Pell, Manage your deed): he keeps his pack (the post), the land stays Tansy's.
    await giveUpPlace(other, /Pell strikes your name/)
    expect((await myHome(page)).members.map((m) => m.displayName)).toEqual(['Tansy'])
    // Not on a deed any more: no home chest for him (his own chest goes with him);
    // his post is still in his pack (mail can send it).
    const storage = await other.request.get('/api/storage', CONTRACT)
    expect(storage.status()).toBe(200)
    expect(await served(storage)).toMatchObject({ home: null, storage: null, shared: 'not-a-member' })
    const carried = await served(await other.request.get('/api/mail', CONTRACT))
    expect(carried.inventory.decorations['lantern-post']).toBe(1)
    // Giving up a place doesn't take back the deed he signed.
    expect(sql(`SELECT deeds FROM player_deeds WHERE account_id='${accountOf(b)}';`)).toBe('1')
    expect(errors).toEqual([])
  } finally {
    await ctx.close()
  }
})

test('visiting: a second player walks through a neighbour’s gate, sees their place and cottage, read-only', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const a = await freshPlayer(page, 'Tansy')
  await earnGlims(page, a)
  const gate = await claimFirstFree(page)
  await yardBuild(page, 'cottage')
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  const created = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
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
  await expectAreaCard(other, 'Tansy’s Place')
  await expect(other.getByTestId('arrange')).toHaveCount(0)
  expect((await homeAt(other, gate))!.member).toBe(false)
  // Each land is its own presence room: Tansy walks home and they see each other there.
  await throughGate(page, gate)
  const peers = (p: Page) => p.evaluate(() => (window as unknown as { __fsPresence: () => { area: string | null; peers: string[] } }).__fsPresence())
  await expect.poll(async () => (await peers(other)).peers, { timeout: 20_000 }).toContain(accountOf(a))
  expect((await peers(other)).area).toBe(`home:${gate}`)
  await shot(other, 'visiting-land-desktop')
  const land = (await homes(other)).land!
  await go(other, `home:${gate}`, land.doorstep.tx, land.doorstep.ty)
  await expect(other.locator('.prompt')).toContainText('Visit the cottage')
  await other.keyboard.press('e')
  await waitForArea(other, `in:home:${gate}`)
  await expectAreaCard(other, 'Tansy’s Place')
  await expect(other.getByTestId('arrange')).toHaveCount(0)
  await shot(other, 'visiting-interior-desktop')
  await place(other, 181, 66)
  await expect(other.locator('.prompt')).toContainText('Sit by the hearth')
  expect(await area(other)).toBe(`in:home:${gate}`)
  // The visitor's save is inside Tansy's cottage: they show up in its presence room.
  await expect.poll(async () => (await serverState(other)).body.state.area).toBe(`in:home:${gate}`)
  expect(errors).toEqual([])
  await ctx.close()
})


test('desolation: an empty homestead overgrows, its sign weathers, and in time the deed is lost', async ({ page }) => {
  test.setTimeout(180_000)
  const a = await freshPlayer(page, 'Tansy')
  await earnGlims(page, a)
  const gate = await claimFirstFree(page)
  await yardBuild(page, 'cottage')
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  // The last name off the deed: the land is empty from now. The confirmation
  // says how long it waits.
  const leaveNow = () => giveUpPlace(page, `${HOMESTEAD_DATA.desolation.deedLostAfterDays} days`)
  await leaveNow()
  expect((await homeAt(page, gate))!.desolate).toBe(false)
  // Changed her mind: Pell gives the deed back, as it stands, for nothing.
  const glims = (await serverState(page)).body.state.glims
  await pellSays(page, new RegExp(`Take back Lot ${gate + 1}`))
  await expect.poll(async () => (await lane(page)).mine?.gate).toBe(gate)
  // Pell answers once the server has it back: read it (it would hold the
  // screen, and the next talk would find no prompt).
  await readOn(page, /Written back in/)
  expect((await myHome(page)).tier).toBe(1)
  expect((await serverState(page)).body.state.glims).toBe(glims)
  await leaveNow()

  // Days pass (the e2e database's clock is moved back instead).
  const ago = (days: number) =>
    sql(`UPDATE homesteads SET vacant_since=strftime('%s','now')-${days}*86400 WHERE gate=${gate} AND world_id=(SELECT world_id FROM players WHERE account_id='${accountOf(a)}');`)
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
  expect(row.price).toBe(HOMESTEAD_DATA.deeds.glims)
})
