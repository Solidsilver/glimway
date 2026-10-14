import { expect, test, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { allow, CONTRACT, newUser, openTitleGuide, pasteAndConnect, reenter, routeHabitica, serverState, setHabitica, syncFromMenu, waitForWorld } from './connected'
import { commonsTile, exitTo, frames, holdUntil, inCommons, parkCreatures, player, waitForWilds, waitGame, warp, wildsWindow } from './helpers'
import { go, homes, throughGate } from './home-helpers'

/**
 * The Commons–Tangle join (docs/design/location-seam.md 6, lane S5): the
 * Commons is fixed ground on the open map, so the north arch is walked
 * through, not a portal. One scene and one window from the Commons into the
 * Tangle and back; the mouth (world y = 24, the safe ground's edge) turned
 * at and crossed on the slant; two players either side of it; reloads on
 * either side; the Yard's door and a home gate back out onto their anchors;
 * and zero HP held at the mouth. Positions are world pixels; Commons tiles
 * (as content names them) go through `commonsTile`.
 */

const TILE = 16
/** The mouth's row: tiles above y = 24 are the Tangle's (unsafe), from it on the Commons' (safe). */
const MOUTH_Y = 24 * TILE
/** The arch (anchor `commons:arch`, Commons tile 23,2), and just inside the Tangle's gate. */
const ARCH = commonsTile(23, 2)
const GATE_IN = { tx: 2, ty: 22 }

type Hero = { x: number; y: number }
const hero = (page: Page): Promise<Hero> => player(page)
const areaId = (page: Page) => page.evaluate(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId ?? null)
/** The window's identity and counts (a scene restart builds a new window: a new id). */
const win = async (page: Page) => (await wildsWindow(page))!
const enemies = (page: Page) => page.evaluate(() => (window as unknown as { __fsEnemies: () => { x: number; y: number; state: string; hp: number }[] }).__fsEnemies())
const presenceArea = (page: Page) => page.evaluate(() => (window as unknown as { __fsPresence?: () => { area: string | null } }).__fsPresence?.()?.area ?? null)
type Remote = { name: string; alpha: number }
const remotes = (page: Page) => page.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])

async function connected(page: Page, context: BrowserContext, name?: string): Promise<string> {
  const id = newUser()
  allow(id)
  if (name) await setHabitica(id, { name })
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
  return id
}

/** Hold `key` until the hero's y passes `y` (north: below it; south: at or past it). */
async function walkTo(page: Page, key: 'ArrowUp' | 'ArrowDown', y: number): Promise<void> {
  await holdUntil(page, key, async () => {
    const h = await hero(page)
    return key === 'ArrowUp' ? h.y < y : h.y >= y
  })
}

test('one scene from the Commons through the arch into the Tangle and back: the window and its id kept', async ({ page, context }) => {
  await connected(page, context)
  await warp(page, 'outdoors', ARCH.tx, ARCH.ty)
  await parkCreatures(page)
  const start = await win(page)
  expect(start.fixed, 'the Commons’ chunks attached').toContain('0,1')
  expect(await inCommons(page)).toBe(true)
  // North through the mouth into the Tangle's gate chunk.
  await walkTo(page, 'ArrowUp', 21 * TILE)
  expect(await areaId(page)).toBe('outdoors')
  const tangle = await win(page)
  expect(tangle.id, 'no scene restart').toBe(start.id)
  expect(tangle.center).toEqual({ cx: 0, cy: 0 })
  expect(await presenceArea(page)).toBe('outdoors:0:0')
  // And back down into the Commons.
  await walkTo(page, 'ArrowDown', 27 * TILE)
  const back = await win(page)
  expect(back.id).toBe(start.id)
  expect(back.center).toEqual({ cx: 0, cy: 1 })
  expect(await inCommons(page)).toBe(true)
  expect(await presenceArea(page)).toBe('outdoors:0:1')
  // The save follows, in world pixels, with no area change.
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __fsDevSaved: () => { area: string } }).__fsDevSaved())).area).toBe('outdoors')
})

test('turning back across the mouth again and again, and crossing it on the slant, rebuilds nothing', async ({ page, context }) => {
  await connected(page, context)
  await warp(page, 'outdoors', ARCH.tx, ARCH.ty)
  await parkCreatures(page)
  await walkTo(page, 'ArrowUp', MOUTH_Y + 8)
  const before = await win(page)
  for (let i = 0; i < 4; i++) {
    await walkTo(page, 'ArrowUp', MOUTH_Y - 6)
    await walkTo(page, 'ArrowDown', MOUTH_Y + 6)
  }
  const after = await win(page)
  expect(after.id).toBe(before.id)
  // Stepping back and forth over one edge, within the slack, attaches and drops nothing.
  expect(after.drops).toBe(before.drops)
  expect(after.attaches - before.attaches, 'only the Tangle’s row ahead, once').toBeLessThanOrEqual(3)
  // On the slant: up and right at once through the three-tile mouth, and back down and left.
  await warp(page, 'outdoors', 1, 25)
  await parkCreatures(page)
  const slant = await win(page)
  for (const [side, key, y] of [['ArrowRight', 'ArrowUp', MOUTH_Y - 4], ['ArrowLeft', 'ArrowDown', MOUTH_Y + 4]] as const) {
    const x0 = (await hero(page)).x
    await page.keyboard.down(side)
    try {
      await walkTo(page, key, y)
    } finally {
      await page.keyboard.up(side)
    }
    const h = await hero(page)
    expect(h.x, `${side} moved too`).not.toBe(x0)
  }
  expect((await win(page)).id).toBe(slant.id)
})

test('two players see each other across the mouth', async ({ page, browser, baseURL }) => {
  const ash = await connected(page, page.context(), 'Ash')
  void ash
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const rowan = newUser()
  await setHabitica(rowan, { name: 'Rowan' })
  const ctx = await (browser as Browser).newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  try {
    await routeHabitica(ctx)
    const other = await ctx.newPage()
    await openTitleGuide(other)
    await pasteAndConnect(other, rowan, { invite: invite.code })
    await waitForWorld(other)
    await warp(page, 'outdoors', ARCH.tx, ARCH.ty)
    await warp(other, 'outdoors', GATE_IN.tx, GATE_IN.ty)
    expect(await presenceArea(page)).toBe('outdoors:0:1')
    expect(await presenceArea(other)).toBe('outdoors:0:0')
    await expect.poll(async () => (await remotes(page)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Rowan'])
    await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Ash'])
  } finally {
    await ctx.close()
  }
})

test('a Tangle wisp never steps past the mouth onto the Commons', async ({ page, context }) => {
  await connected(page, context)
  // Wake the gate's camps from just inside the Tangle, then step back onto the Commons and watch.
  await warp(page, 'outdoors', GATE_IN.tx, GATE_IN.ty)
  await frames(page, 30)
  await walkTo(page, 'ArrowDown', MOUTH_Y + 3 * TILE)
  expect(await inCommons(page)).toBe(true)
  await waitGame(
    page,
    async () => (await enemies(page)).filter((e) => e.hp > 0 && e.y >= MOUTH_Y),
    (past) => past.length > 0,
    { seconds: 8, message: 'watching the mouth' }
  ).then(
    (past) => {
      throw new Error(`an enemy stood on the Commons: ${JSON.stringify(past)}`)
    },
    () => undefined
  )
})

test('a reload on either side of the mouth comes back where it was', async ({ page, context }) => {
  await connected(page, context)
  for (const at of [ARCH, GATE_IN]) {
    await warp(page, 'outdoors', at.tx, at.ty)
    await parkCreatures(page)
    await page.evaluate(() => (window as unknown as { __fsDevSaveSoon: () => void }).__fsDevSaveSoon())
    await expect.poll(async () => (await serverState(page)).body.state.position).toEqual({ x: at.tx * TILE + 8, y: at.ty * TILE + 8 })
    await reenter(page, 'outdoors')
    await waitForWilds(page)
    expect(await hero(page)).toMatchObject({ x: at.tx * TILE + 8, y: at.ty * TILE + 8 })
    expect(await inCommons(page)).toBe(at === ARCH)
  }
})

test('the Yard’s door and a home gate bring you back out onto their anchors', async ({ page, context }) => {
  await connected(page, context)
  // Out of the Yard: its doorstep (anchor commons:yard-door, Commons tile 53,18).
  await go(page, 'in:commons:yard', 7, 7)
  const door = await exitTo(page, 'commons')
  await go(page, 'in:commons:yard', door.tx, door.ty - 1)
  const yardDoor = commonsTile(53, 18)
  await holdUntil(page, 'ArrowDown', async () => (await areaId(page)) === 'outdoors')
  await waitForWilds(page)
  const out = await hero(page)
  expect({ tx: Math.floor(out.x / TILE), ty: Math.floor(out.y / TILE) }).toEqual(yardDoor)
  // Through gate 0 and back: the lane in front of it (anchor commons:gate:0).
  await expect.poll(async () => (await homes(page)).status, { timeout: 15_000 }).not.toBe('loading')
  const slot = (await homes(page)).slots.find((s) => s.gate === 0)!
  expect(slot.entry).toEqual(commonsTile(20, 9))
  await throughGate(page, 0)
  await holdUntil(page, 'ArrowDown', async () => (await areaId(page)) === 'outdoors')
  await waitForWilds(page)
  const back = await hero(page)
  expect({ tx: Math.floor(back.x / TILE), ty: Math.floor(back.y / TILE) }).toEqual(slot.entry)
})

test('at zero HP the mouth holds: the Commons is home ground, the Tangle is not', async ({ page, context }) => {
  const id = await connected(page, context)
  await warp(page, 'outdoors', ARCH.tx, ARCH.ty + 2)
  // Too hurt to fight: Habitica says 0 HP, synced on safe ground.
  await setHabitica(id, { hp: 0 })
  await syncFromMenu(page)
  await expect.poll(async () => (await serverState(page)).body.state.hp, { timeout: 15_000 }).toBe(0)
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsFrame: () => { live: boolean } }).__fsFrame().live)).toBe(true)
  await page.keyboard.down('ArrowUp')
  try {
    // Walk at the mouth for a while: the hero never passes y = 24.
    await waitGame(page, () => hero(page), (h) => h.y < MOUTH_Y, { seconds: 3, message: 'held at the mouth' }).then(
      (h) => {
        throw new Error(`a hero at 0 HP walked into the Tangle: ${JSON.stringify(h)}`)
      },
      () => undefined
    )
  } finally {
    await page.keyboard.up('ArrowUp')
  }
  const h = await hero(page)
  expect(h.y).toBeGreaterThanOrEqual(MOUTH_Y)
  expect(h.y).toBeLessThan(MOUTH_Y + 2 * TILE)
})
