import { expect, test, type Page } from './fixtures'
import type { BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, reenter, routeHabitica, serverState, setHabitica, waitForWorld, CONTRACT } from './connected'
import { expectToast, holdUntil, player, settled, waitForWilds, warp, wilds, wildsWindow } from './helpers'
import { freshPlayer } from './home-helpers'

/**
 * The open map (docs/design/open-map.md 2.5, 2.6, 4): one Wilds scene, a
 * window of chunks moving with the hero. Out through the Commons gate,
 * through the Tangle and into the Whitequiet and beyond, across chunk edges
 * with no scene change and no long frames; a reload puts you back where you
 * stood; the drift at the frontier stops you and says why.
 * SCREENS=1 saves images to .agent/screens/.
 */

const TILE = 16
const S = 24

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

/**
 * A walkable route (world px waypoints) from the hero to the nearest open
 * tile matching `goal`, over the tiles the open map knows now (breadth
 * first, 4-way, within `reach` tiles); null when there is none yet.
 */
async function route(page: Page, goal: { minTy?: number; maxTy?: number; minTx?: number; maxTx?: number }, reach = 70): Promise<{ x: number; y: number }[] | null> {
  return page.evaluate(([g, reach]) => {
    const w = window as unknown as { __fsPlayer: () => { x: number; y: number }; __fsTileSolid: (x: number, y: number) => boolean }
    const p = w.__fsPlayer()
    const sx = Math.floor(p.x / 16)
    const sy = Math.floor(p.y / 16)
    const ok = (x: number, y: number) => (g.minTy === undefined || y >= g.minTy) && (g.maxTy === undefined || y <= g.maxTy) && (g.minTx === undefined || x >= g.minTx) && (g.maxTx === undefined || x <= g.maxTx)
    const key = (x: number, y: number) => `${x},${y}`
    const from = new Map<string, string | null>([[key(sx, sy), null]])
    const queue: [number, number][] = [[sx, sy]]
    while (queue.length) {
      const [x, y] = queue.shift()!
      if (ok(x, y)) {
        const out: { x: number; y: number }[] = []
        let k: string | null = key(x, y)
        while (k) {
          const [a, b] = k.split(',').map(Number)
          out.unshift({ x: a * 16 + 8, y: b * 16 + 12 })
          k = from.get(k) ?? null
        }
        return out
      }
      for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
        const nx = x + dx
        const ny = y + dy
        if (Math.abs(nx - sx) > reach || Math.abs(ny - sy) > reach || from.has(key(nx, ny)) || w.__fsTileSolid(nx, ny)) continue
        from.set(key(nx, ny), key(x, y))
        queue.push([nx, ny])
      }
    }
    return null
  }, [goal, reach] as const)
}

/**
 * Walk (as if steered) to the nearest open tile matching `goal`, and wait
 * until the hero gets there. Creatures are set aside first (a camp's
 * knockback would push the hero off the route); a walk that stalls is
 * planned again from where the hero stands.
 */
async function walkTo(page: Page, goal: Parameters<typeof route>[1]): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
    let path = await route(page, goal)
    for (let tries = 0; !path && tries < 20; tries++) {
      await page.waitForTimeout(250)
      path = await route(page, goal)
    }
    expect(path, `a way to ${JSON.stringify(goal)}`).not.toBeNull()
    if (path!.length <= 1) return
    await page.evaluate((p) => (window as unknown as { __fsDevWalk: (p: { x: number; y: number }[]) => void }).__fsDevWalk(p), path!)
    const done = await expect
      .poll(() => page.evaluate(() => (window as unknown as { __fsDevWalking: () => boolean }).__fsDevWalking()), { timeout: 20_000 })
      .toBe(false)
      .then(() => true, () => false)
    if (done) return
  }
  throw new Error(`the walk to ${JSON.stringify(goal)} kept stalling`)
}

test('walk from the gate through the Tangle into the Whitequiet and on, with no scene change; reload in place', async ({ page }) => {
  test.setTimeout(240_000)
  await freshPlayer(page)
  // North through the Commons arch: the open map, just inside the gate.
  await warp(page, 'commons', 23, 2)
  const inWilds = () => page.evaluate(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'wilds')
  await holdUntil(page, 'ArrowUp', inWilds)
  await waitForWilds(page)
  const start = await wilds(page)
  expect(start.chunk).toEqual({ cx: 0, cy: 0 })
  expect(start.position).toEqual({ x: 40, y: 360 })
  expect(start.epochId).toBe(start.stillEpoch)
  const win = (await wildsWindow(page))!
  expect(win.attached.length).toBe(6) // the 3×3 minus the row south of the gate (the village side)
  expect(win.drift.sort()).toEqual(['-1,1', '0,1', '1,1'])
  await shot(page, '60-open-map-gate-desktop')

  // North chunk by chunk: (0,-1), (0,-2) in the Tangle, over the crossing into
  // the Whitequiet (0,-3), (0,-4), and out of its far side into the Beyond.
  const frames: { p95: number; p50: number }[] = []
  for (let cy = -1; cy >= -6; cy--) {
    const timing = page.evaluate(() => (window as unknown as { __fsDevFrameTimes: (ms: number) => Promise<{ gap: { p50: number; p95: number } }> }).__fsDevFrameTimes(2500))
    await walkTo(page, { maxTy: cy * S + S - 3 })
    frames.push((await timing).gap)
    const here = await wilds(page)
    expect(here.chunk.cy, 'the hero walked into the next row').toBe(cy)
    const w = (await wildsWindow(page))!
    expect(w.id, 'the same window: the scene never restarted').toBe(win.id)
    expect(w.center).toEqual(here.chunk)
    expect(await page.evaluate(() => (window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId)).toBe('wilds')
    if (cy === -3) {
      expect(here.epochId, 'the Whitequiet turns: the wick’s epoch').toBe(here.wickEpoch)
      await shot(page, '61-open-map-whitequiet-desktop')
    }
  }
  // No long frames crossing the edges (painting is off the walking frame).
  for (const f of frames) expect(f.p95, `frame gaps while crossing: ${JSON.stringify(frames)}`).toBeLessThan(120)
  const paints = (await wildsWindow(page))!.paints.filter((p) => !p.drift)
  // For the report: frame gaps per row crossed, and how long the chunks took to paint (and where).
  console.log('open-map walk', JSON.stringify({ frames, paints: paints.map((p) => [p.chunk, p.ms, p.thread]) }))
  expect(paints.some((p) => p.thread === 'worker'), 'chunks painted off the main thread while walking').toBe(true)
  await shot(page, '62-open-map-beyond-desktop')

  // Reload: the place is the server's; Continue puts you back where you stood
  // (once the report after the walk has reached it).
  const before = await player(page)
  await expect.poll(async () => {
    const st = (await serverState(page)).body.state as { area: string; position: { x: number; y: number } }
    return st.area === 'wilds' && Math.hypot(st.position.x - before.x, st.position.y - before.y) <= 17
  }, { timeout: 20_000 }).toBe(true)
  // And this tab's own record has it (a reload starts from the place the page last saved).
  await page.evaluate(() => (window as unknown as { __fsDevSaveSoon: () => void }).__fsDevSaveSoon())
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsDevSaved: () => { pending: boolean } }).__fsDevSaved().pending)).toBe(false)
  await reenter(page, 'wilds')
  await waitForWilds(page)
  const after = await player(page)
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(17)
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(17)
})

test('the drift at the frontier stops you, and says so the first time', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  // The north edge of the frontier is cy -8 (three chunks past the Whitequiet).
  await warp(page, 'wilds', 12, -8 * S + 12)
  await waitForWilds(page)
  const w = (await wildsWindow(page))!
  expect(w.drift.length, 'past the edge is the drift').toBeGreaterThan(0)
  const frontierTop = -8 * S * TILE
  // Walk to the northmost open tile in reach; if it is on the edge row, push into the drift.
  if (!(await route(page, { maxTy: -8 * S }, 40))) test.skip(true, 'no open tile on this world’s north edge near the warp')
  await walkTo(page, { maxTy: -8 * S })
  await page.keyboard.down('ArrowUp')
  try {
    await expectToast(page, /The drift is thick here\. Not without a lamp\./, { timeout: 8_000 })
  } finally {
    await page.keyboard.up('ArrowUp')
  }
  expect((await player(page)).y, 'the hero never passes the frontier').toBeGreaterThanOrEqual(frontierTop)
  await shot(page, '63-open-map-drift-desktop')
  await settled(page, { area: 'wilds' })
})

type Remote = { name: string; x: number; y: number; alpha: number }
const remotes = (p: Page) => p.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])

test('two players in neighbouring chunks see each other; two chunks apart they don’t', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000)
  const ash = newUser()
  const rowan = newUser()
  allow(ash)
  await setHabitica(ash, { name: 'Ash' })
  await setHabitica(rowan, { name: 'Rowan' })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, ash)
  await waitForWorld(page)
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx: BrowserContext = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  await pasteAndConnect(other, rowan, { invite: invite.code })
  await waitForWorld(other)

  // Ash by the east edge of the Tangle's middle chunk (0, -1); Rowan just over it in (1, -1).
  await warp(page, 'wilds', 22, -12)
  await waitForWilds(page)
  await warp(other, 'wilds', 25, -12)
  await waitForWilds(other)
  expect((await wilds(page)).chunk).toEqual({ cx: 0, cy: -1 })
  expect((await wilds(other)).chunk).toEqual({ cx: 1, cy: -1 })
  await expect.poll(async () => (await remotes(page)).map((r) => r.name), { timeout: 20_000 }).toEqual(['Rowan'])
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 20_000 }).toEqual(['Ash'])
  const seen = (await remotes(page))[0]!
  const there = await player(other)
  expect(Math.hypot(seen.x - there.x, seen.y - there.y), 'drawn where Rowan stands (world pixels)').toBeLessThan(24)
  await expect.poll(async () => (await remotes(page))[0]?.alpha ?? 0).toBe(1)
  await shot(page, '64-open-map-two-players-desktop')

  // Rowan goes two chunks further east: out of Ash's 3×3, so they part.
  await warp(other, 'wilds', 3 * S + 12, -12)
  await waitForWilds(other)
  await expect.poll(async () => (await remotes(page)).length, { timeout: 15_000 }).toBe(0)
  await ctx.close()
})

type SceneSize = { list: number; tweens: number; statics: number; kinds: Record<string, number> }
const sceneSize = (p: Page) => p.evaluate(() => (window as unknown as { __fsSceneSize: () => SceneSize }).__fsSceneSize())

/** The nearest open tile to (tx, ty), searched outward (the open map answers by world tile). */
const openNear = (p: Page, tx: number, ty: number) =>
  p.evaluate(([x0, y0]) => {
    const solid = (window as unknown as { __fsTileSolid: (x: number, y: number) => boolean }).__fsTileSolid
    for (let r = 0; r < 12; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r && !solid(x0 + dx, y0 + dy)) return { tx: x0 + dx, ty: y0 + dy }
    return null
  }, [tx, ty] as const)

/** Stand on a tile, and wait until the window around it is whole (every chunk attached and built). */
async function standAt(p: Page, at: { tx: number; ty: number }): Promise<void> {
  await p.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [at.tx * TILE + 8, at.ty * TILE + 12] as const)
  const chunk = `${Math.floor(at.tx / S)},${Math.floor(at.ty / S)}`
  await expect.poll(async () => {
    const w = await wildsWindow(p)
    return !!w && w.ready && `${w.center?.cx},${w.center?.cy}` === chunk
  }, { timeout: 20_000 }).toBe(true)
}

test('chunks walked in and out leave nothing behind: the tweens, the collision bodies and what is drawn come back to the same', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  await warp(page, 'wilds', 12, -12)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
  // Two spots three chunks apart: moving between them swaps the whole 3×3
  // (the far one is known once the hero has stood halfway).
  const a = (await openNear(page, 12, -12))!
  await standAt(page, (await openNear(page, 12, -12 - 2 * S))!)
  const b = (await openNear(page, 12, -12 - 3 * S))!
  expect(a && b, 'open ground at both spots').toBeTruthy()
  await standAt(page, b)
  await standAt(page, a)
  await page.waitForTimeout(500)
  const before = await sceneSize(page)
  expect(before.tweens, 'something glints here (the test needs tweens to watch)').toBeGreaterThan(0)
  expect(Object.keys(before.kinds).some((k) => k.startsWith('Blitter:')), 'flat decals are drawn by a blitter a chunk').toBe(true)
  for (let i = 0; i < 4; i++) {
    await standAt(page, b)
    await standAt(page, a)
  }
  await page.waitForTimeout(500)
  const after = await sceneSize(page)
  // What the window draws (images, sprites, blitters), by type and texture; an
  // animation's frame is the same sprite, and the hero's thought bubbles come and go.
  const drawn = (z: SceneSize) => {
    const out: Record<string, number> = {}
    for (const [k, n] of Object.entries(z.kinds)) {
      if (!/^(Image|Sprite|Blitter):/.test(k)) continue
      const key = k.replace(/-\d+$/, '')
      out[key] = (out[key] ?? 0) + n
    }
    return out
  }
  expect({ tweens: after.tweens, statics: after.statics, drawn: drawn(after) }, 'after four trips').toEqual({ tweens: before.tweens, statics: before.statics, drawn: drawn(before) })
})

test('stepping back and forth over a chunk edge builds and drops nothing; the 3×3 around the hero is always whole', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  await warp(page, 'wilds', 12, -12)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
  // Two tiles south of the edge between (0, -1) and (0, -2), and two north of it.
  const south = (await openNear(page, 12, -S + 2))!
  const north = (await openNear(page, 12, -S - 3))!
  expect(Math.floor(south.ty / S), 'south of the edge').toBe(-1)
  expect(Math.floor(north.ty / S), 'north of the edge').toBe(-2)
  await standAt(page, south)
  await standAt(page, north)
  const first = (await wildsWindow(page))!
  for (let i = 0; i < 5; i++) {
    await standAt(page, south)
    await standAt(page, north)
  }
  const after = (await wildsWindow(page))!
  expect({ attaches: after.attaches, drops: after.drops }, 'nothing built or dropped crossing back and forth').toEqual({ attaches: first.attaches, drops: first.drops })
  expect(after.attached, 'the row behind is kept while the hero is near the edge').toContain('0,0')
  // Further on, the row behind goes.
  await standAt(page, (await openNear(page, 12, -2 * S + 4))!)
  await expect.poll(async () => (await wildsWindow(page))!.attached, { timeout: 5_000 }).not.toContain('0,0')
})
