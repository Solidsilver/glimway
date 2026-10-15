import { expect, test, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { allow, CONTRACT, newUser, openTitleGuide, pasteAndConnect, reenter, routeHabitica, serverState, setHabitica, syncFromMenu, waitForWorld } from './connected'
import { exitTo, frames, holdUntil, inCommons, parkCreatures, player, waitForWilds, waitGame, warp, wildsWindow, windowWhole } from './helpers'
import { setHour } from './room-helpers'
import { go, homes, throughGate } from './home-helpers'

/**
 * The Commons–Tangle join (docs/design/location-seam.md 6, lane S5): the
 * Commons is fixed ground on the open map, so the north arch is walked
 * through, not a portal. One scene and one window from the Commons into the
 * Tangle and back; the mouth (world y = 24, the safe ground's edge) turned
 * at and crossed on the slant; two players either side of it; reloads on
 * either side; the Yard's door and a home gate back out onto their anchors;
 * and zero HP held at the mouth. Positions are world pixels.
 */

const TILE = 16
/** The mouth's row: tiles above y = 24 are the Tangle's (unsafe), from it on the Commons' (safe). */
const MOUTH_Y = 24 * TILE
/** The arch (anchor `hearthwick:arch`), and just inside the Tangle's gate. */
const ARCH = { tx: 2, ty: 26 }
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
    // Poll the exact return position: right after a reload the hero can still be
    // settling when read under heavy single-worker load (it lands exactly here;
    // passing runs confirm the match).
    await expect.poll(async () => await hero(page)).toMatchObject({ x: at.tx * TILE + 8, y: at.ty * TILE + 8 })
    expect(await inCommons(page)).toBe(at === ARCH)
  }
})

test('a slow fixed-chunk read preserves a Commons save beyond the boot wait', async ({ page, context }) => {
  await connected(page, context);
  const tile = { tx: 2, ty: 40 };
  const position = { x: tile.tx * TILE + 8, y: tile.ty * TILE + 8 };
  await warp(page, 'outdoors', tile.tx, tile.ty);
  await page.evaluate(() => (window as unknown as { __fsDevSaveSoon: () => void }).__fsDevSaveSoon());
  await expect.poll(async () => (await serverState(page)).body.state.position).toEqual(position);
  // Force the next page to fetch the immutable chunks instead of using IndexedDB.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('glimway-chunks');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fixedRoute = /\/api\/wilds\/chunk\/fixed(?::|%3A)/;
  let requests = 0;
  await page.route(fixedRoute, async (route) => {
    // The pre-game read fails; Boot retries and its bounded wait expires.
    if (++requests <= 6) { await route.abort(); return; }
    await held;
    await route.continue();
  });
  try {
    await reenter(page, 'outdoors'); // Boot starts the scene after its four-second wait.
    expect(await hero(page)).toMatchObject(position);
    await page.keyboard.down('ArrowDown');
    await frames(page, 15);
    await page.keyboard.up('ArrowDown');
    expect(await hero(page)).toMatchObject(position);
    expect((await serverState(page)).body.state.position).toEqual(position);
  } finally {
    release();
    await page.keyboard.up('ArrowDown');
  }
  await waitForWilds(page);
  expect(await hero(page)).toMatchObject(position);
  await page.unroute(fixedRoute);
});

test('the Yard’s door and a home gate bring you back out onto their anchors', async ({ page, context }) => {
  await connected(page, context)
  // Out of the Yard: its doorstep (anchor hearthwick:yard-door).
  await go(page, 'in:commons:yard', 7, 7)
  const door = await exitTo(page, 'hearthwick')
  await go(page, 'in:commons:yard', door.tx, door.ty - 1)
  const yardDoor = { tx: 34, ty: 35 }
  await holdUntil(page, 'ArrowDown', async () => (await areaId(page)) === 'outdoors')
  await waitForWilds(page)
  const out = await hero(page)
  expect({ tx: Math.floor(out.x / TILE), ty: Math.floor(out.y / TILE) }).toEqual(yardDoor)
  // Through gate 0 and back: the lane in front of it (anchor hearthwick:lot:0).
  await expect.poll(async () => (await homes(page)).status, { timeout: 15_000 }).not.toBe('loading')
  const slot = (await homes(page)).slots.find((s) => s.gate === 0)!
  expect(slot.entry).toEqual({ tx: -60, ty: 44 })
  await throughGate(page, 0)
  await holdUntil(page, 'ArrowDown', async () => (await homes(page)).land === null)
  await waitForWilds(page)
  const back = await hero(page)
  expect(Math.abs(Math.floor(back.x / TILE) - slot.entry.tx)).toBeLessThanOrEqual(1)
  expect(Math.floor(back.y / TILE)).toBe(slot.entry.ty)
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
  // A shove already integrated by Arcade must be stopped before postUpdate
  // writes it to the sprite; checking a later frame would miss the bypass.
  const shoved = await page.evaluate(() => (window as unknown as { __fsDevShove: (dx: number, dy: number) => Promise<Hero> }).__fsDevShove(4, -64))
  expect(shoved.y).toBeGreaterThanOrEqual(MOUTH_Y)
  expect(shoved.x).toBeCloseTo(h.x + 4)
  // A scene rebuild must forget the previous scene's safe spot. A legacy
  // zero-HP arrival in the Tangle can still walk home from where it arrived.
  await warp(page, 'outdoors', GATE_IN.tx, GATE_IN.ty)
  await parkCreatures(page)
  await frames(page, 3)
  expect(await hero(page)).toMatchObject({ x: GATE_IN.tx * TILE + 8, y: GATE_IN.ty * TILE + 8 })
})

test('Silas walks to the Yard door when his hour changes on the open map', async ({ page, context }) => {
  await connected(page, context)
  await setHour(page, { minute: 5 })
  await warp(page, 'outdoors', 29, 37)
  await parkCreatures(page)
  const id = (await win(page)).id
  await expect.poll(() => page.evaluate(() => window.__fsNpcs!().find((n) => n.id === 'silas')?.present)).toBe(true)
  await setHour(page, { minute: 21 })
  await expect.poll(() => page.evaluate(() => window.__fsNpcs!().find((n) => n.id === 'silas')?.walking), { intervals: [50] }).toBe(true)
  const door = { tx: 34, ty: 34 }
  await expect.poll(() => page.evaluate(([x, y]) => {
    const n = window.__fsNpcs!().find((n) => n.id === 'silas')
    return !!n && Math.abs(n.x - x) < 2 && Math.abs(n.y - y) < 2
  }, [door.tx * TILE + 8, (door.ty + 1) * TILE] as const), { intervals: [50], timeout: 10_000 }).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__fsNpcs!().find((n) => n.id === 'silas')?.walking)).toBe(false)
  expect((await win(page)).id).toBe(id)
})

test('Carting Day dressing and Commons interactions leave with their chunks and return three times', async ({ page, context }) => {
  await connected(page, context)
  const carting = Date.parse('2026-01-05T00:00:00Z') / 1000 + (5 * 7 + 5) * 86400 + 300
  await page.evaluate((t) => window.__fsDevCalendar!(t), carting)
  await warp(page, 'outdoors', 2, 44)
  await parkCreatures(page)
  const id = (await win(page)).id
  const dressing = () => page.evaluate(() => {
    const kinds = window.__fsSceneSize!().kinds
    return ['a', 'b', 'c'].reduce((n, s) => n + (kinds[`Image:stall-${s}`] ?? 0), 0)
  })
  const place = async (ty: number) => {
    await page.evaluate((ty) => window.__fsDevPlace!(40, ty * 16 + 12), ty)
    await expect.poll(async () => {
      const w = await win(page)
      return w.ready && w.center?.cy === Math.floor(ty / 24)
    }, { timeout: 20_000 }).toBe(true)
  }
  await expect.poll(dressing).toBe(3)
  for (let round = 0; round < 3; round++) {
    await place(-60)
    await expect.poll(async () => (await win(page)).fixed, { timeout: 5_000, message: 'fixed chunks drain while standing still' }).toEqual([])
    expect(await dressing()).toBe(0)
    expect(await page.evaluate(() => window.__fsNpcs!().map((n) => n.id))).toEqual([])
    expect(await page.evaluate(() => window.__fsPickups!())).toEqual([])
    expect(await page.evaluate(() => window.__fsRepairs!())).toEqual([])
    await place(44)
    await expect.poll(dressing).toBe(3)
    expect((await win(page)).id).toBe(id)
    expect(await page.evaluate(() => window.__fsNpcs!().map((n) => n.id).sort())).toEqual(['ada', 'elara', 'hazel', 'mara', 'orrin', 'silas'])
  }
})

test('walking from the Tangle waits for fixed collision before crossing or saving into the Commons', async ({ page, context }) => {
  await connected(page, context)
  await warp(page, 'outdoors', 2, 22)
  await page.evaluate(() => window.__fsDevSaveSoon!())
  await expect.poll(async () => (await serverState(page)).body.state.position).toEqual({ x: 40, y: 360 })
  await page.goto('/')
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('glimway-chunks')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('chunks', 'readwrite')
      tx.objectStore('chunks').clear()
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }))
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const fixedRoute = /\/api\/wilds\/chunk\/fixed(?::|%3A)/
  await page.route(fixedRoute, async (route) => { await held; await route.continue() })
  try {
    await page.getByTestId('continue-world').click()
    await waitForWorld(page, 'outdoors')
    await parkCreatures(page)
    await page.keyboard.down('ArrowDown')
    await frames(page, 180)
    await page.keyboard.up('ArrowDown')
    expect((await hero(page)).y).toBeLessThan(MOUTH_Y)
    expect((await page.evaluate(() => window.__fsDevSaved!())).position.y).toBeLessThan(MOUTH_Y)
    expect((await win(page)).fixed).not.toContain('0,1')
  } finally {
    release()
    await page.keyboard.up('ArrowDown')
  }
  await expect.poll(async () => (await win(page)).fixed).toContain('0,1')
  await walkTo(page, 'ArrowDown', 26 * TILE)
  expect(await inCommons(page)).toBe(true)
  await page.unroute(fixedRoute)
})

/** Median brightness (0–255) of a screenshot's columns `x0`–`x1` (fractions of its width), decoded in the page. */
async function medianLuma(page: Page, png: Buffer, x0: number, x1: number): Promise<number> {
  return page.evaluate(async ({ b64, x0, x1 }) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const c = new OffscreenCanvas(img.width, img.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const from = Math.floor(img.width * x0)
    const d = ctx.getImageData(from, 0, Math.floor(img.width * x1) - from, img.height).data
    const luma: number[] = []
    for (let i = 0; i < d.length; i += 4) luma.push(0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!)
    luma.sort((a, b) => a - b)
    return luma[luma.length >> 1]!
  }, { b64: png.toString('base64'), x0, x1 })
}

test('Hearthwick and the lots both draw their ground', async ({ page, context }) => {
  // Each fixed chunk is painted by the Wilds' painter, per chunk (once each
  // footprint's shared tileset key let the second paint destroy the first's,
  // and its ground drew black).
  await connected(page, context)
  // On Lot Row West, where the west lots (to x = -25) meet Hearthwick (from world tile x = -24).
  await warp(page, 'outdoors', -23, 69)
  await parkCreatures(page)
  await windowWhole(page)
  await expect.poll(async () => (await win(page)).fixed).toEqual(expect.arrayContaining(['-2,2', '-1,2']))
  await expect.poll(async () => (await win(page)).painted).toEqual(expect.arrayContaining(['-2,2', '-1,2']))
  await frames(page, 2)
  // A band across the middle of the screen, clear of the HUD.
  const vp = page.viewportSize()!
  const png = await page.screenshot({ clip: { x: 0, y: Math.round(vp.height * 0.35), width: vp.width, height: Math.round(vp.height * 0.4) } })
  const lots = await medianLuma(page, png, 0, 0.3)
  const town = await medianLuma(page, png, 0.7, 1)
  expect(lots, 'the lots’ ground is drawn').toBeGreaterThan(20)
  expect(town, 'Hearthwick’s ground is drawn').toBeGreaterThan(20)
})
