import { expect, test, type Page } from './fixtures'
import { expectToast, player, settled, waitForLive, warp, waitForArea } from './helpers'
import { freshPlayer, shot } from './home-helpers'
import { CONTRACT, reenter, serverState } from './connected'
import { DOORSTEP, goIn, inRoom, roomView, setHour } from './room-helpers'

/**
 * Rooms are places (docs/design/indoors.md 2–4): the front door takes you
 * in, the doorway out onto the doorstep facing away from it; the mill's
 * stairs climb to the sack loft; you save inside; friends meet in a room;
 * and Hazel and Finn come and go on their hour. Screens of each room go to
 * .agent/screens/ with SCREENS=1 (desktop and phone).
 *
 * The world keeps a room's place (lane A2). The refusal test forces its own
 * refusal (a world that doesn't know the room), so it holds either way; the
 * phone and hearth checks play offline, since what they check is drawing
 * and local regen.
 */

type Seat = { seated: boolean; bonus: number; mana: number; maxMana: number }
const seat = (page: Page) => page.evaluate(() => (window as unknown as { __fsSeat: () => Seat }).__fsSeat())

/**
 * Answer the first report that names `area` as a place the world doesn't
 * take (a real refusal: the world's own state with it, holding the hero on
 * the doorstep outside, as a world that doesn't know the room would).
 * Other reports go through.
 */
async function refuseReportFrom(page: Page, area: string): Promise<void> {
  let refused = false
  await page.route('**/api/report', async (route) => {
    if (refused || !(route.request().postData() ?? '').includes(area)) return route.continue()
    refused = true
    // A moment later than a world would answer, so the room is seen to settle first.
    await new Promise((r) => setTimeout(r, 1500))
    const { state } = await (await page.request.get('/api/state', CONTRACT)).json()
    state.place = { ...state.place, area: 'village', x: 7 * 16 + 8, y: 8 * 16 + 8 }
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid-position' }, state }) })
  })
}

type Npc = { id: string; x: number; y: number; present: boolean; spot: string | null; walking: boolean }
const npc = (page: Page, id: string) => page.evaluate((who) => (window as unknown as { __fsNpcs: () => Npc[] }).__fsNpcs().find((n) => n.id === who) ?? null, id)

/** Walk out through the doorway (hold Down from the arrival spot) onto the village. */
async function walkOut(page: Page): Promise<void> {
  await waitForLive(page)
  await page.keyboard.down('ArrowDown')
  await settled(page, { area: 'village' })
  await page.keyboard.up('ArrowDown')
}

const ROOMS = [
  { id: 'in:village:bakery', name: /Hazel.s kitchen/, screen: 'room-kitchen', art: 'kitchen-hearth' },
  { id: 'in:village:mill', name: /Finn.s mill/, screen: 'room-mill', art: 'millstones' },
  { id: 'in:village:library', name: /The library reading room/, screen: 'room-library', art: 'library-shelves' }
] as const

test('each room: in at its front door, facing in, framed close; out through the doorway onto the doorstep', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  // Both residents home (:20, Hazel at her worktable, Finn at his stones): the doors say "Go into".
  await setHour(page, { minute: 25 })
  const outdoors = (await roomView(page)).zoom
  for (const r of ROOMS) {
    await goIn(page, r.id, { prompt: new RegExp(`Go into ${r.name.source}`) })
    const v = await roomView(page)
    expect(v.room?.name).toMatch(r.name)
    expect(v.facing.y, 'arriving facing into the room').toBeLessThan(0)
    expect(v.zoom, 'a room is framed closer than outdoors').toBeGreaterThan(outdoors)
    expect(v.props.some((p) => p.art === r.art && p.frame.startsWith('in-art:')), `${r.art} is drawn with the indoors pass`).toBe(true)
    // You stand on the room's arrival tile.
    const at = await player(page)
    expect([Math.floor(at.x / 16), Math.floor(at.y / 16)]).toEqual([v.room!.arrive.tx, v.room!.arrive.ty])
    await shot(page, r.screen)
    await walkOut(page)
    const out = await player(page)
    expect([Math.floor(out.x / 16), Math.floor(out.y / 16)], 'out on the doorstep').toEqual(DOORSTEP[r.id])
    expect((await roomView(page)).facing.y, 'facing away from the door').toBeGreaterThan(0)
  }
})

test('the mill’s stairs: up the west wall to the loft, out north of its opening; back down, out south of the stairs', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  await goIn(page, 'in:village:mill')
  // At the stairs' foot, then up onto them.
  await warp(page, 'in:village:mill', 1, 6)
  await waitForLive(page)
  await page.keyboard.down('ArrowUp')
  await inRoom(page, 'in:village:mill:2')
  await page.keyboard.up('ArrowUp')
  let at = await player(page)
  expect([Math.floor(at.x / 16), Math.floor(at.y / 16)], 'just north of the opening').toEqual([1, 3])
  expect((await roomView(page)).facing.y, 'facing on, north').toBeLessThan(0)
  expect((await roomView(page)).props.some((p) => p.art === 'mill-hoist')).toBe(true)
  await shot(page, 'room-loft')
  // Back down through the opening: out on the mill floor south of the stairs.
  await waitForLive(page)
  await page.keyboard.down('ArrowDown')
  await inRoom(page, 'in:village:mill')
  await page.keyboard.up('ArrowDown')
  at = await player(page)
  expect([Math.floor(at.x / 16), Math.floor(at.y / 16)]).toEqual([1, 6])
  expect((await roomView(page)).facing.y, 'facing on, south').toBeGreaterThan(0)
})

test('a resident at the change of the hour: Hazel walks out of her kitchen, and her door says Knock', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  // :39:50, Hazel at her worktable; inside, the hearth burns.
  await setHour(page, { minute: 39, second: 50 })
  await goIn(page, 'in:village:bakery')
  await expect.poll(async () => (await npc(page, 'hazel'))?.present).toBe(true)
  expect((await roomView(page)).lights.find((l) => l.kind === 'hearth')?.visible).toBe(true)
  // The hour turns: she walks to the doorway, then she's gone.
  await expect.poll(async () => (await npc(page, 'hazel'))?.walking, { timeout: 20_000 }).toBe(true)
  await shot(page, 'room-kitchen-hazel-leaving')
  await expect.poll(async () => (await npc(page, 'hazel'))?.present, { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => (await npc(page, 'hazel'))?.walking).toBe(false)
  // Outside she's in the square, and her door says Knock: you hear where she is, and go in anyway.
  await walkOut(page)
  await expect.poll(async () => (await npc(page, 'hazel'))?.present).toBe(true)
  expect((await roomView(page)).houses.find((h) => h.room === 'in:village:bakery')).toMatchObject({ window: false, smoke: false })
  await warp(page, 'village', ...DOORSTEP['in:village:bakery'])
  await expect(page.locator('.prompt')).toContainText(/Knock at Hazel.s kitchen/)
  await waitForLive(page)
  await page.keyboard.press('e')
  await expectToast(page, /Hazel, from the square: “Out with the basket/)
  await inRoom(page, 'in:village:bakery')
  expect((await npc(page, 'hazel'))?.present, 'an empty kitchen').toBe(false)
})

test('a reload inside comes back inside', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  await goIn(page, 'in:village:library')
  await warp(page, 'in:village:library', 9, 6)
  await expect.poll(async () => (await serverState(page)).body.state.area, { timeout: 20_000 }).toBe('in:village:library')
  await reenter(page, 'in:village:library')
  const at = await player(page)
  expect([Math.floor(at.x / 16), Math.floor(at.y / 16)]).toEqual([9, 6])
})

test('two players in one room see each other, and the room is left behind on the way out', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000)
  await freshPlayer(page, 'Tansy')
  // Presence is per world: Bram joins Tansy's by her invite.
  const created = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  expect(created.ok()).toBe(true)
  const code = (await created.json()).code as string
  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  await freshPlayer(other, 'Bram', code)
  for (const p of [page, other]) await goIn(p, 'in:village:mill')
  const presence = (p: Page) => p.evaluate(() => (window as unknown as { __fsPresence: () => { area: string | null; peers: string[] } }).__fsPresence())
  expect((await presence(page)).area).toBe('in:village:mill')
  await expect.poll(async () => (await presence(page)).peers.length, { timeout: 20_000 }).toBe(1)
  await expect.poll(async () => (await presence(other)).peers.length, { timeout: 20_000 }).toBe(1)
  await shot(page, 'room-mill-two-players')
  // Out in the village, the mill's room is left behind.
  await walkOut(other)
  await waitForArea(other, 'village')
  await expect.poll(async () => (await presence(page)).peers.length, { timeout: 20_000 }).toBe(0)
  await ctx.close()
})

test('a room place the world refuses: the hero is put back where the world says, and a reload starts there too', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  await refuseReportFrom(page, 'in:village:bakery')
  await goIn(page, 'in:village:bakery')
  // The arrival's report is refused: back outside, by the world's place (where the server holds the hero).
  await settled(page, { area: 'village' })
  const at = await player(page)
  expect(Math.hypot(at.x - (7 * 16 + 8), at.y - (8 * 16 + 8)), 'on the place the world said').toBeLessThan(24)
  // The next report names that place, so the world holds it, and a reload starts there.
  await page.unroute('**/api/report')
  await expect.poll(async () => (await serverState(page)).body.state.area, { timeout: 20_000 }).toBe('village')
  await reenter(page, 'village')
})

test('on a phone the whole room is in view, all four walls; standing at the hearth warms you', async ({ browser, baseURL }) => {
  test.setTimeout(150_000)
  const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await freshPlayer(page)
  // What this checks is the framing and local regen: the world's answers (which,
  // before A2, refuse a room and rightly put the hero back outside) are held back.
  await page.route('**/api/**', (route) => route.abort())
  for (const r of ROOMS) {
    await goIn(page, r.id, { touch: true })
    const box = await page.evaluate(() => {
      const w = window as unknown as { __fsDevToScreen: (x: number, y: number) => { x: number; y: number }; __fsWorld: () => { widthPx: number; heightPx: number } }
      const world = w.__fsWorld()
      return { tl: w.__fsDevToScreen(0, 0), br: w.__fsDevToScreen(world.widthPx, world.heightPx) }
    })
    expect(box.tl.x, `${r.id}: the west wall`).toBeGreaterThanOrEqual(0)
    expect(box.tl.y, `${r.id}: the back wall`).toBeGreaterThanOrEqual(0)
    expect(box.br.x, `${r.id}: the east wall`).toBeLessThanOrEqual(390)
    expect(box.br.y, `${r.id}: the near wall`).toBeLessThanOrEqual(844)
    await page.evaluate(() => (window as unknown as { __fsDevWarp: (a: string, x: number, y: number) => void }).__fsDevWarp('village', 8, 10))
    await settled(page, { area: 'village' })
  }
  // The kitchen's oven: standing on its apron, the seated bonus without a seat.
  await goIn(page, 'in:village:bakery', { touch: true })
  expect((await seat(page)).bonus, 'by the door: nothing').toBe(0)
  await warp(page, 'in:village:bakery', 7, 4)
  await expect.poll(async () => (await seat(page)).bonus).toBe(5)
  expect((await seat(page)).seated, 'standing, not seated').toBe(false)
  await ctx.close()
})
