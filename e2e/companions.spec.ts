import { expect, test, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { allow, CONTRACT, newUser, openTitleGuide, pasteAndConnect, pastOpening, reenter, routeHabitica, setHabitica, sql, waitForWorld } from './connected'
import { claimDeed, earnPlenty, fund, go, homes, landOf, myHome, silasSays, throughGate, type Home } from './home-helpers'
import { SERVER_ANSWER_MS, frames, waitForArea, waitForLive } from './helpers'
import { HOMESTEAD_DATA, checkPlacement } from '../src/lib/homestead.ts'
import { buildableKind, clearable, clearedSet, effectiveKind, homeLights, isLit, type Land } from '../src/lib/homestead-land.ts'

/**
 * Companions and riding in the game (docs/design/crafts.md 2, 3; lane E):
 * the follower you choose holds through a reload, a friend's pet follows
 * them on your screen, and the stable: build it, stall a mount, Saddle up,
 * M down and up, Go home, and the village lead. Real Go server and fake
 * Habitica; only bundled companion art is used (Wolf-Base, Wolf-White), so
 * nothing waits on the sprite proxy.
 */

type Companions = { pets?: Record<string, number>; mounts?: Record<string, boolean>; currentPet?: string; currentMount?: string }
type Debug = { follower: { pose: string } | null; mountOut: string; led: { key: string; drawn: boolean } | null; riding: boolean; walkingHome: { key: string; x: number; y: number; bay: { x: number; y: number } | null; done: boolean } | null }
type Remote = { id: string; name: string; x: number; y: number; alpha: number; pet: string | null; riding: boolean; led: string | null }

const debug = (page: Page) => page.evaluate(() => (window as unknown as { __fsDebug: () => Debug }).__fsDebug())
const remotes = (page: Page) => page.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])

/** A new allowlisted Habitica hero with these companions, signed in and past the opening. */
async function heroWith(page: Page, name: string, companions: Companions, invite?: string): Promise<string> {
  const id = newUser()
  if (!invite) allow(id)
  await setHabitica(id, { name, ...companions })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, id, invite ? { invite } : {})
  await waitForWorld(page)
  if (!invite) await pastOpening(page, id)
  return id
}

/** The Character panel at its Companions page. */
async function openCompanions(page: Page): Promise<void> {
  await waitForLive(page)
  await page.keyboard.press('c')
  await page.getByTestId('char-tab-companions').click()
  await expect(page.getByTestId('companions-page')).toBeVisible()
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('companions-page')).toHaveCount(0)
}

test('the follower you choose walks with you, and is still yours after a reload', async ({ page }) => {
  test.setTimeout(150_000)
  await heroWith(page, 'Tansy', { pets: { 'Wolf-Base': 1, 'Wolf-White': 1 }, currentPet: 'Wolf-Base' })
  // Before a homestead: Habitica's current pet, and no choosing.
  await openCompanions(page)
  await expect(page.getByTestId('companions-follower-name')).toHaveText('Base Wolf')
  await expect(page.getByTestId('companions-change-follower')).toHaveCount(0)
  await closePanel(page)

  // With a deed (any tier, the campsite too), the choice opens.
  await claimDeed(page)
  await openCompanions(page)
  await page.getByTestId('companions-change-follower').click()
  const picker = page.getByTestId('companions-picker')
  await expect(picker).toBeVisible()
  await expect(page.getByTestId('companions-pick-first')).toContainText('Habitica’s current pet')
  await page.getByTestId('companions-pick-Wolf-White').click()
  // At once (predicted), and drawn.
  await expect(page.getByTestId('companions-follower-name')).toHaveText('White Wolf')
  await expect(page.getByTestId('companions-follower')).toContainText('Chosen here')
  await closePanel(page)
  await expect.poll(async () => (await debug(page)).follower, { timeout: SERVER_ANSWER_MS }).not.toBeNull()
  // The server kept it (and never touched Habitica's current pet).
  await expect
    .poll(async () => (await (await page.request.get('/api/state', CONTRACT)).json()).state?.companions?.followPet ?? null, { timeout: SERVER_ANSWER_MS })
    .toBe('Wolf-White')

  await reenter(page, 'commons')
  await openCompanions(page)
  await expect(page.getByTestId('companions-follower-name')).toHaveText('White Wolf')
  await expect(page.getByTestId('companions-follower')).toContainText('Chosen here')
  await closePanel(page)
  expect((await debug(page)).follower).not.toBeNull()

  // Back to Habitica's current pet.
  await openCompanions(page)
  await page.getByTestId('companions-change-follower').click()
  await page.getByTestId('companions-pick-first').click()
  await expect(page.getByTestId('companions-follower-name')).toHaveText('Base Wolf')
  await expect(page.getByTestId('companions-follower')).toContainText('Habitica’s current pet')

  // No pet (the owner's playtest): its own choice, kept, and nothing follows.
  await page.getByTestId('companions-change-follower').click()
  await expect(page.getByTestId('companions-pick-none')).toContainText('No pet')
  await page.getByTestId('companions-pick-none').click()
  await expect(page.getByTestId('companions-follower-name')).toHaveText('No pet')
  await closePanel(page)
  await expect.poll(async () => (await debug(page)).follower, { timeout: SERVER_ANSWER_MS }).toBeNull()
  await expect
    .poll(async () => (await (await page.request.get('/api/state', CONTRACT)).json()).state?.companions?.followPet ?? null, { timeout: SERVER_ANSWER_MS })
    .toBe('none')
  await reenter(page, 'commons')
  await openCompanions(page)
  await expect(page.getByTestId('companions-follower-name')).toHaveText('No pet')
  await page.getByTestId('companions-change-follower').click()
  await expect(page.getByTestId('companions-pick-none')).toHaveClass(/\bon\b/)
  await page.keyboard.press('Escape')
  await closePanel(page)
  // The companions are read (the panel showed the server's choice), so a
  // follower would be drawn within a few frames: a second of game time, not
  // of wall time, and still none.
  await frames(page, 60)
  expect((await debug(page)).follower).toBeNull()
})

test('a friend\'s pet follows them on your screen, and you can pet it', async ({ page, browser, baseURL }) => {
  const ash = newUser()
  allow(ash)
  await setHabitica(ash, { name: 'Ash', pets: { 'Wolf-Base': 1 }, currentPet: 'Wolf-Base', mounts: {}, currentMount: '' })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, ash)
  await waitForWorld(page)
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()

  const ctx: BrowserContext = await (browser as Browser).newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  const rowan = newUser()
  await setHabitica(rowan, { name: 'Rowan', pets: {}, currentPet: '', mounts: {}, currentMount: '' })
  await openTitleGuide(other)
  await pasteAndConnect(other, rowan, { invite: invite.code })
  await waitForWorld(other)

  // Ash's own follower, and Ash's pet beside Ash on Rowan's screen.
  await expect.poll(async () => (await debug(page)).follower, { timeout: SERVER_ANSWER_MS }).not.toBeNull()
  await expect.poll(async () => (await remotes(other)).map((r) => [r.name, r.pet]), { timeout: 15_000 }).toEqual([['Ash', 'Wolf-Base']])
  // Rowan has no pet: nothing follows them on Ash's screen (never a stand-in).
  await expect.poll(async () => (await remotes(page)).map((r) => [r.name, r.pet]), { timeout: 15_000 }).toEqual([['Rowan', null]])
  await expect.poll(async () => (await remotes(other)).map((r) => [r.name, r.led])).toEqual([['Ash', null]])

  // Out in the open (a bench or a resident outranks a pet), Rowan walks up to
  // Ash: the action button says Pet. Only Rowan sees the heart.
  await go(page, 'woodland', 15, 20)
  await go(other, 'woodland', 15, 20)
  await expect.poll(async () => (await remotes(other)).map((r) => [r.name, r.pet]), { timeout: 15_000 }).toEqual([['Ash', 'Wolf-Base']])
  await other.bringToFront()
  await expect(other.locator('.prompt')).toContainText('Pet', { timeout: 15_000 })

  // Ash chooses No pet (a deed opens the choice): on Rowan's screen nothing
  // follows Ash, not even Habitica's current pet.
  await page.bringToFront()
  await claimDeed(page)
  await openCompanions(page)
  await page.getByTestId('companions-change-follower').click()
  await page.getByTestId('companions-pick-none').click()
  await expect(page.getByTestId('companions-follower-name')).toHaveText('No pet')
  await closePanel(page)
  await go(other, 'commons', 23, 21)
  await expect.poll(async () => (await remotes(other)).map((r) => [r.name, r.pet]), { timeout: 15_000 }).toEqual([['Ash', null]])
  await ctx.close()
})

/**
 * Top-left tiles where the stable stands with one stall and could grow a
 * second (lit, and open once the trees, stumps and boulders there are
 * cleared), with open ground at the bays' doors; and the tiles to clear.
 */
function stableSpot(home: Home, land: Land, items: Home['items'] = home.items): { x: number; y: number; clear: [number, number][] } | null {
  const homeLike = { tier: 2, items: items as never, plants: [] }
  const one = { id: 'probe', itemDef: 'stable', scene: null, x: null, y: null, rotation: null, stalls: 1 }
  const two = { ...one, stalls: 2 }
  const s = HOMESTEAD_DATA.land.startLight
  const base = clearedSet(home.cleared)
  const reserved = (tx: number, ty: number) => HOMESTEAD_DATA.outdoorReserved.some((r) => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h)
  const order: [number, number][] = []
  for (let y = 1; y < land.height - 4; y++) for (let x = 1; x < land.width - 7; x++) order.push([x, y])
  order.sort((a, b) => Math.hypot(a[0] - s.x, a[1] - s.y) - Math.hypot(b[0] - s.x, b[1] - s.y))
  for (const [x, y] of order) {
    const clear: [number, number][] = []
    for (let ty = y; ty < y + 4; ty++) for (let tx = x; tx < x + 6; tx++) if (clearable(effectiveKind(land, base, tx, ty))) clear.push([tx, ty])
    const ground = { land, cleared: new Set([...base, ...clear.map(([cx, cy]) => `${cx},${cy}`)]) }
    if (checkPlacement(homeLike, one, 'outdoor', x, y, 0, HOMESTEAD_DATA, ground)) continue
    if (checkPlacement(homeLike, two, 'outdoor', x, y, 0, HOMESTEAD_DATA, ground)) continue
    // The hero stands at the bays' doors, the row below: open ground.
    if (![0, 1, 2, 3, 4, 5].every((dx) => buildableKind(effectiveKind(land, ground.cleared, x + dx, y + 3)) && !reserved(x + dx, y + 3))) continue
    if (items.some((i) => i.scene === 'outdoor' && i.y === y + 3 && i.x !== null && i.x >= x && i.x <= x + 5)) continue
    return { x, y, clear }
  }
  return null
}

/**
 * Where the stable goes. The campsite's own light holds little open ground
 * (the site and the gate path take its middle), so a test-only lantern post
 * may go in first, in the home's light, wherever it makes room (as a player
 * would set one), and Silas's clearing is done by the same lever.
 */
function lightForStable(home: Home, land: Land): { spot: { x: number; y: number; clear: [number, number][] }; post: { x: number; y: number } | null } {
  const now = stableSpot(home, land)
  if (now) return { spot: now, post: null }
  const lights = homeLights([])
  const cleared = clearedSet(home.cleared)
  const reserved = (x: number, y: number) => HOMESTEAD_DATA.outdoorReserved.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
  for (let y = 1; y < land.height - 1; y++)
    for (let x = 1; x < land.width - 1; x++) {
      if (!isLit(lights, x, y) || reserved(x, y) || !buildableKind(effectiveKind(land, cleared, x, y))) continue
      const post = { id: 'e2e-post', itemDef: HOMESTEAD_DATA.lanternPosts.item, scene: 'outdoor', x, y, rotation: 0 }
      const spot = stableSpot(home, land, [...home.items, post])
      if (spot) return { spot, post: { x, y } }
    }
  throw new Error('no ground for a two-stall stable, even with a post')
}

/** In the tray: pick a piece, then walk it to (x, y) with the arrow keys (as homestead.spec.ts). */
async function carryTo(page: Page, piece: string, x: number, y: number): Promise<void> {
  const tray = page.getByTestId('placement-tray')
  await tray.locator(`[data-piece="${piece}"]`).first().click()
  await expect.poll(async () => (await homes(page)).placement?.spot ?? null).not.toBeNull()
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

test('the stable: build it, stall a mount, Saddle up, M down and up, Go home, and the village lead', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000)
  const id = await heroWith(page, 'Tansy', { pets: { 'Wolf-Base': 1 }, currentPet: 'Wolf-Base', mounts: { 'Wolf-Base': true }, currentMount: 'Wolf-Base' })
  // Riding lives behind the stable now: Habitica's current mount alone doesn't ride.
  await waitForLive(page)
  await waitForLive(page)
  await page.keyboard.press('m')
  await expect(page.getByText(/somewhere to stand at home first/)).toBeVisible()
  expect((await debug(page)).riding).toBe(false)

  await earnPlenty(page, id)
  const gate = await claimDeed(page)
  // Esc gets you out of a talk (the owner's playtest): Silas's replies have
  // a goodbye, so Esc takes it, and the Menu doesn't open on the same press.
  const silasAt = (await homes(page)).features?.silas ?? { tx: 0, ty: 0 }
  await go(page, 'commons', silasAt.tx, silasAt.ty + 1)
  await expect(page.locator('.prompt')).toContainText('Talk to Silas')
  await waitForLive(page)
  await page.keyboard.press('e')
  const talking = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(talking).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(talking).toHaveCount(0)
  await expect(page.getByTestId('world-card')).toHaveCount(0)
  // Silas's Yard: the stable heads its own Buildings section, after the
  // cottage and before the finished pieces, locked until the Workshop stands.
  await silasSays(page, /See what you’ve finished/)
  const yard = page.getByRole('dialog', { name: 'Silas’s Yard' })
  const sections = await yard.locator('section').evaluateAll((all) => all.map((el) => el.getAttribute('aria-label')))
  expect(sections.indexOf('Buildings')).toBeGreaterThan(sections.indexOf('The cottage'))
  expect(sections.indexOf('Buildings')).toBeLessThan(sections.indexOf('Finished pieces'))
  await expect(yard.getByTestId('shop-locked-stable')).toContainText('workshop')
  await expect(yard.locator('[data-buy="stable"]')).toBeDisabled()
  await expect(yard.getByRole('region', { name: 'Finished pieces' }).locator('[data-buy="stable"]')).toHaveCount(0)
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()
  // Test lever: the Workshop tier (the stable comes after it) without the build-up.
  const mine = await myHome(page)
  sql(`UPDATE homesteads SET tier=2 WHERE id='${mine.id}';`)
  const bill = HOMESTEAD_DATA.stable.stallCost
  fund(id, { materials: { timber: 16 + bill.timber, stone: 8 + bill.stone, fiber: 6 + bill.fiber } })

  // Silas sells the stable.
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await expect(shop.locator('.row', { hasText: 'Stable' })).toContainText('30 embers')
  await shop.locator('[data-buy="stable"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('is yours')
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // Placed like any outdoor piece, on lit, open ground.
  const lit = lightForStable(await myHome(page), await landOf(page, gate))
  if (lit.post) sql(`INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation,name) VALUES('e2e-post-${mine.id.slice(-8)}','${HOMESTEAD_DATA.lanternPosts.item}','placed','${mine.id}','outdoor',${lit.post.x},${lit.post.y},0,'Stable lamp');`)
  if (lit.spot.clear.length) sql(lit.spot.clear.map(([cx, cy]) => `INSERT OR IGNORE INTO homestead_cleared(homestead_id,x,y) VALUES('${mine.id}',${cx},${cy});`).join('\n'))
  const spot = lit.spot
  await throughGate(page, gate)
  await go(page, `home:${gate}`, spot.x + 1, spot.y + 4)
  await page.getByTestId('arrange').click()
  await carryTo(page, 'stable', spot.x, spot.y)
  const tray = page.getByTestId('placement-tray')
  await expect(tray.getByRole('button', { name: /Set it here/ })).toBeEnabled()
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')
  await tray.getByRole('button', { name: /Done/ }).click()
  const stable = (await myHome(page)).items.find((i) => i.itemDef === 'stable')!
  expect([stable.scene, stable.x, stable.y]).toEqual(['outdoor', spot.x, spot.y])

  // An empty stall: Choose a mount opens Companions at the stable.
  await go(page, `home:${gate}`, spot.x + 3, spot.y + 3)
  await expect(page.locator('.prompt')).toContainText('Choose a mount')
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(page.getByTestId('companions-stalls')).toBeVisible()
  await page.getByTestId('companions-stall-1').click()
  await page.getByTestId('companions-pick-Wolf-Base').click()
  await expect(page.getByTestId('companions-stalls')).toContainText('Base Wolf')
  // The server keeps it (HomeView.stalls).
  await expect
    .poll(async () => ((await myHome(page)) as unknown as { stalls?: { stall: number; mount: string }[] }).stalls?.find((s) => s.stall === 1)?.mount ?? null, { timeout: SERVER_ANSWER_MS })
    .toBe('Wolf-Base')
  await closePanel(page)
  // It stands in its bay.
  await expect.poll(async () => (await homes(page)).stalled, { timeout: SERVER_ANSWER_MS }).toEqual(['Wolf-Base'])

  // A visitor (a friend in this world) stands at the stable and sees it too.
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx: BrowserContext = await (browser as Browser).newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const visitor = await ctx.newPage()
  const rowan = newUser()
  await setHabitica(rowan, { name: 'Rowan', pets: {}, currentPet: '', mounts: {}, currentMount: '' })
  await openTitleGuide(visitor)
  await pasteAndConnect(visitor, rowan, { invite: invite.code })
  await waitForWorld(visitor)
  await go(visitor, 'commons', 23, 21)
  await throughGate(visitor, gate)
  await go(visitor, `home:${gate}`, spot.x + 2, spot.y + 5)
  await waitForLive(visitor)
  await expect.poll(async () => (await homes(visitor)).stalled, { timeout: SERVER_ANSWER_MS }).toEqual(['Wolf-Base'])

  // Saddle up at the stall: you're on it, and it's out with you.
  await page.bringToFront()
  await expect(page.locator('.prompt')).toContainText('Saddle up')
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect.poll(async () => { const d = await debug(page); return [d.riding, d.mountOut] }, { timeout: SERVER_ANSWER_MS }).toEqual([true, 'Wolf-Base'])
  await expect(page.getByRole('button', { name: /Get down/ })).toBeVisible()
  // The bay stands empty while it's out (the owner's playtest): for you, and for the visitor.
  await expect.poll(async () => (await homes(page)).stalled).toEqual([])
  await expect.poll(async () => (await homes(visitor)).stalled, { timeout: SERVER_ANSWER_MS }).toEqual([])

  // M: down, on the lead; M again: back up.
  await waitForLive(page)
  await page.keyboard.press('m')
  await expect.poll(async () => (await debug(page)).riding).toBe(false)
  await expect.poll(async () => (await debug(page)).led?.key ?? null).toBe('Wolf-Base')
  await expect(page.getByRole('button', { name: /Send your mount home/ })).toBeVisible()
  await waitForLive(page)
  await page.keyboard.press('m')
  await expect.poll(async () => (await debug(page)).riding).toBe(true)
  await expect.poll(async () => (await debug(page)).led).toBeNull()

  // Build a stall: the stable grows east.
  await waitForLive(page)
  await page.keyboard.press('m')
  await expect.poll(async () => (await debug(page)).riding).toBe(false)
  // At the east end, just past the last bay.
  await go(page, `home:${gate}`, spot.x + 4, spot.y + 3)
  await expect(page.locator('.prompt')).toContainText('Build a stall', { timeout: 10_000 })
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect.poll(async () => (await myHome(page)).items.find((i) => i.itemDef === 'stable') as unknown as { stalls?: number }, { timeout: SERVER_ANSWER_MS }).toMatchObject({ stalls: 2 })

  // The village is a no-ride zone: you lead it through.
  await waitForLive(page)
  await page.keyboard.press('m')
  await expect.poll(async () => (await debug(page)).riding).toBe(true)
  await go(page, 'village', 16, 19)
  await waitForArea(page, 'village')
  await expect.poll(async () => (await debug(page)).riding).toBe(false)
  await expect.poll(async () => (await debug(page)).led?.key ?? null).toBe('Wolf-Base')
  await waitForLive(page)
  await page.keyboard.press('m')
  await expect(page.getByText(/hoofprints in the square/)).toBeVisible()

  // Go home (H): away from its land it walks off the screen, and it's back in its stall.
  await page.keyboard.press('h')
  await expect.poll(async () => (await debug(page)).mountOut).toBe('')
  await expect.poll(async () => (await debug(page)).walkingHome).toMatchObject({ key: 'Wolf-Base', bay: null })
  await expect
    .poll(async () => (await (await page.request.get('/api/state', CONTRACT)).json()).state?.companions?.mountOut ?? null, { timeout: SERVER_ANSWER_MS })
    .toBe('')
  await expect(page.getByRole('button', { name: /Send your mount home/ })).toHaveCount(0)
  // Home from the village, far from the stable: the visitor sees it back in its bay.
  await expect.poll(async () => (await homes(visitor)).stalled, { timeout: SERVER_ANSWER_MS }).toEqual(['Wolf-Base'])
  // And so do you, once you're back.
  await go(page, `home:${gate}`, spot.x + 2, spot.y + 5)
  await expect.poll(async () => (await homes(page)).stalled, { timeout: SERVER_ANSWER_MS }).toEqual(['Wolf-Base'])

  // Go home on your own land (the owner's request, review F6): it walks back
  // into its bay, the bay empty until it steps in, then it stands in its stall.
  await go(page, `home:${gate}`, spot.x + 3, spot.y + 3)
  await expect(page.locator('.prompt')).toContainText('Saddle up')
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect.poll(async () => (await debug(page)).riding, { timeout: SERVER_ANSWER_MS }).toBe(true)
  await waitForLive(page)
  await page.keyboard.press('m')
  await expect.poll(async () => (await debug(page)).led?.key ?? null).toBe('Wolf-Base')
  await expect.poll(async () => (await homes(page)).stalled).toEqual([])
  await page.keyboard.press('h')
  await expect.poll(async () => (await debug(page)).mountOut).toBe('')
  await expect.poll(async () => (await debug(page)).walkingHome?.bay ?? null, { message: 'walking to its bay, not off the screen' }).not.toBeNull()
  const bay = (await debug(page)).walkingHome!.bay!
  // Stall 1's floor, inside the footprint: x within its tiles, its feet above the bottom edge.
  expect(bay.x).toBeGreaterThan(spot.x * 16)
  expect(bay.x).toBeLessThan((spot.x + 4) * 16)
  expect(bay.y).toBeLessThan((spot.y + 3) * 16)
  // It gets there, and the stable draws it standing in its stall.
  await expect.poll(async () => (await debug(page)).walkingHome?.done, { timeout: 10_000 }).toBe(true)
  expect((await debug(page)).walkingHome).toMatchObject({ x: Math.round(bay.x), y: Math.round(bay.y) })
  await expect.poll(async () => (await homes(page)).stalled, { timeout: 10_000 }).toEqual(['Wolf-Base'])
  await ctx.close()
})
