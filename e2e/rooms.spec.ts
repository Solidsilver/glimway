import { expect, test, type Page } from './fixtures'
import { expectToast, player, settled, waitForLive, warp, waitForArea } from './helpers'
import { freshPlayer, shot } from './home-helpers'
import { reenter, serverState } from './connected'
import { DOORSTEP, goIn, inRoom, roomView, setHour } from './room-helpers'

/**
 * Rooms are places (docs/design/indoors.md 2–4): the front door takes you
 * in, the doorway out onto the doorstep facing away from it; the mill's
 * stairs climb to the sack loft; you save inside; friends meet in a room;
 * and Hazel and Finn come and go on their hour. Screens of each room go to
 * .agent/screens/ with SCREENS=1 (desktop and phone).
 *
 * The reload and two-player tests need the server to know rooms (lane A2:
 * `validArea`, presence rooms); until then the server refuses a room's place.
 */

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

test('the mill’s stairs: up to the sack loft and back down', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  await goIn(page, 'in:village:mill')
  // Just below the stairs up, then onto them.
  await warp(page, 'in:village:mill', 10, 7)
  await waitForLive(page)
  await page.keyboard.down('ArrowUp')
  await inRoom(page, 'in:village:mill:2')
  await page.keyboard.up('ArrowUp')
  let at = await player(page)
  expect([Math.floor(at.x / 16), Math.floor(at.y / 16)], 'beside the stairs down').toEqual([4, 5])
  expect((await roomView(page)).facing.x, 'facing east, off the stairs').toBeGreaterThan(0)
  expect((await roomView(page)).props.some((p) => p.art === 'mill-hoist')).toBe(true)
  await shot(page, 'room-loft')
  // West, onto the stairs down: back on the mill floor beside the stairs up.
  await waitForLive(page)
  await page.keyboard.down('ArrowLeft')
  await inRoom(page, 'in:village:mill')
  await page.keyboard.up('ArrowLeft')
  at = await player(page)
  expect([Math.floor(at.x / 16), Math.floor(at.y / 16)]).toEqual([9, 6])
  expect((await roomView(page)).facing.x, 'facing west').toBeLessThan(0)
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

test('a reload inside comes back inside (needs A2: the server keeps a room’s place)', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  await goIn(page, 'in:village:library')
  await warp(page, 'in:village:library', 9, 6)
  await expect.poll(async () => (await serverState(page)).body.state.area, { timeout: 20_000 }).toBe('in:village:library')
  await reenter(page, 'in:village:library')
  const at = await player(page)
  expect([Math.floor(at.x / 16), Math.floor(at.y / 16)]).toEqual([9, 6])
})

test('two players in one room see each other (needs A2: rooms are presence rooms)', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000)
  await freshPlayer(page, 'Tansy')
  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  await freshPlayer(other, 'Bram')
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
