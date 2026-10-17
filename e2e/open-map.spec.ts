import { expect, test, type Page } from './fixtures'
import type { BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, pinWorld, reenter, routeHabitica, serverState, setHabitica, waitForWorld, wickSlack, CONTRACT } from './connected'
import { diagnose, expectToast, frames, holdUntil, parkCreatures, player, settled, steady, waitForLive, waitForWilds, waitGame, warp, wilds, wildsWindow, windowWhole } from './helpers'
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
 * first, 4-way, within `reach` tiles); null when there is none yet. Body
 * aware: a tile counts as open only when its map data is open *and* no
 * collision body touches it (a decor body can stick out past its own tile),
 * so the hero's body fits wherever the route goes.
 */
async function route(page: Page, goal: { minTy?: number; maxTy?: number; minTx?: number; maxTx?: number }, reach = 70): Promise<{ x: number; y: number }[] | null> {
  return page.evaluate(([g, reach]) => {
    const w = window as unknown as { __fsPlayer: () => { x: number; y: number }; __fsTileSolid: (x: number, y: number) => boolean; __fsSolidAt: (x: number, y: number) => boolean }
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
        if (Math.abs(nx - sx) > reach || Math.abs(ny - sy) > reach || from.has(key(nx, ny)) || w.__fsTileSolid(nx, ny) || w.__fsSolidAt(nx, ny)) continue
        from.set(key(nx, ny), key(x, y))
        queue.push([nx, ny])
      }
    }
    return null
  }, [goal, reach] as const)
}

/** The hero's tile matches `goal`. */
const arrived = (p: { x: number; y: number }, g: Parameters<typeof route>[1]) => {
  const tx = Math.floor(p.x / TILE)
  const ty = Math.floor(p.y / TILE)
  return (g.minTy === undefined || ty >= g.minTy) && (g.maxTy === undefined || ty <= g.maxTy) && (g.minTx === undefined || tx >= g.minTx) && (g.maxTx === undefined || tx <= g.maxTx)
}

/**
 * Walk (as if steered) to the nearest open tile matching `goal`, and check
 * the hero gets there. Creatures are set aside as the walk goes (chunks
 * attached on the way bring their own). Progress is checked every second
 * of game time: a walk that stops moving and reaching waypoints for two of
 * them has stalled, and is logged (position, body, waypoint, build state)
 * and planned once more from where the hero stands; a second stall fails.
 * A walk that ends short of the goal fails too.
 */
async function walkTo(page: Page, goal: Parameters<typeof route>[1]): Promise<void> {
  type Walk = { walking: boolean; left: number; x: number; y: number }
  const read = (): Promise<Walk> =>
    page.evaluate(() => {
      const w = window as unknown as { __fsDevWalking: () => boolean; __fsDevWalkLeft: () => unknown[] | null; __fsPlayer: () => { x: number; y: number } }
      const p = w.__fsPlayer()
      return { walking: w.__fsDevWalking(), left: w.__fsDevWalkLeft()?.length ?? 0, x: p.x, y: p.y }
    })
  const stalls: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    await parkCreatures(page)
    let path = await route(page, goal)
    for (let tries = 0; !path && tries < 20; tries++) {
      await frames(page, 10)
      path = await route(page, goal)
    }
    if (!path) throw new Error(`no way to ${JSON.stringify(goal)}: ${await diagnose(page)}`)
    if (path.length > 1) {
      await page.evaluate((p) => (window as unknown as { __fsDevWalk: (p: { x: number; y: number }[]) => void }).__fsDevWalk(p), path)
      let last = await read()
      let still = 0
      while (last.walking && still < 2) {
        const now = await waitGame(page, read, (v) => !v.walking || v.left < last.left || Math.hypot(v.x - last.x, v.y - last.y) > 4, { seconds: 1 }).catch(() => null)
        await parkCreatures(page)
        if (now) {
          still = 0
          last = now
        } else {
          still += 1
          last = await read()
        }
      }
      if (last.walking) {
        stalls.push(await diagnose(page))
        console.log(`open-map walk stalled toward ${JSON.stringify(goal)}: ${stalls.at(-1)}`)
        await page.evaluate(() => (window as unknown as { __fsDevWalk: (p: { x: number; y: number }[]) => void }).__fsDevWalk([]))
        continue
      }
    }
    const at = await player(page)
    if (arrived(at, goal)) return
    stalls.push(`ended short at ${Math.round(at.x)},${Math.round(at.y)}: ${await diagnose(page)}`)
  }
  throw new Error(`the walk to ${JSON.stringify(goal)} stalled: ${stalls.join(' | ')}`)
}

/** Frame gaps from now until `stopFrameGaps`: the time between one frame's callbacks and the next's, every frame the page draws. */
async function startFrameGaps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gaps: number[] = []
    let last = 0
    let on = true
    // performance.now(), not the frame's own timestamp: that one is snapped
    // to the display's beat and hides how late a frame's work really ran.
    const tick = () => {
      if (!on) return
      const t = performance.now()
      if (last) gaps.push(t - last)
      last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    ;(window as unknown as { __e2eGaps: { gaps: number[]; stop: () => void } }).__e2eGaps = { gaps, stop: () => (on = false) }
  })
}

/** The gaps since `startFrameGaps`: how many, p50, p95 and the longest (ms), and the wall time sampled. */
async function stopFrameGaps(page: Page): Promise<{ frames: number; p50: number; p95: number; max: number; ms: number }> {
  return page.evaluate(() => {
    const g = (window as unknown as { __e2eGaps: { gaps: number[]; stop: () => void } }).__e2eGaps
    g.stop()
    const b = [...g.gaps].sort((x, y) => x - y)
    const pct = (q: number) => (b.length ? Math.round(b[Math.min(b.length - 1, Math.floor(q * b.length))]! * 10) / 10 : 0)
    return { frames: b.length, p50: pct(0.5), p95: pct(0.95), max: Math.round((b.at(-1) ?? 0) * 10) / 10, ms: Math.round(g.gaps.reduce((a, x) => a + x, 0)) }
  })
}

test('walk from the gate through the Tangle into the Whitequiet and on, with no scene change; reload in place', async ({ page }) => {
  test.setTimeout(240_000)
  await freshPlayer(page)
  // North from the Commons through its arch: the open map, one scene, into the Tangle's gate chunk.
  await warp(page, 'outdoors', 2, 26)
  const win = (await wildsWindow(page))!
  await holdUntil(page, 'ArrowUp', () => page.evaluate(() => (window as unknown as { __fsPlayer: () => { y: number } }).__fsPlayer().y < 22 * 16 + 8))
  await waitForWilds(page)
  await windowWhole(page)
  const start = await wilds(page)
  expect(start.chunk).toEqual({ cx: 0, cy: 0 })
  expect(start.epochId).toBe(start.stillEpoch)
  const gate = (await wildsWindow(page))!
  expect(gate.id, 'walked in, no scene change').toBe(win.id)
  // The whole 3×3: the Tangle's row, the gate's and the Commons' (fixed) south of it; no drift.
  // (The Commons' far row stays a few steps more: the slack behind a crossing.)
  const around = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => `${dx},${dy}`))
  expect(gate.attached).toEqual(expect.arrayContaining(around))
  expect(gate.fixed).toEqual(expect.arrayContaining(['-1,1', '0,1', '1,1']))
  expect(gate.drift).toEqual([])
  await shot(page, '60-open-map-gate-desktop')

  // North chunk by chunk: (0,-1), (0,-2) in the Tangle, over the crossing into
  // the Whitequiet (0,-3), (0,-4), and out of its far side into the Beyond.
  // This world's seed is its own (varied land; the drift test below is pinned):
  // a stall logs the epoch, so the same geometry can be read again.
  // The frames are sampled over each actual crossing and the builds it starts
  // (until the window around the hero is whole again), not a fixed window before it.
  const crossings: { p95: number; p50: number; max: number; frames: number; ms: number }[] = []
  for (let cy = -1; cy >= -6; cy--) {
    await startFrameGaps(page)
    await walkTo(page, { maxTy: cy * S + S - 3 })
    await windowWhole(page)
    crossings.push(await stopFrameGaps(page))
    const here = await wilds(page)
    expect(here.chunk.cy, 'the hero walked into the next row').toBe(cy)
    const w = (await wildsWindow(page))!
    expect(w.id, 'the same window: the scene never restarted').toBe(win.id)
    expect(w.center).toEqual(here.chunk)
    expect(await page.evaluate(() => (window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId)).toBe('outdoors')
    if (cy === -3) {
      expect(here.epochId, 'the Whitequiet turns: the wick’s epoch').toBe(here.wickEpoch)
      await shot(page, '61-open-map-whitequiet-desktop')
    }
  }
  // No long frames crossing the edges (painting is off the walking frame).
  // p95 is the coarse guard; the longest gap of each crossing is recorded
  // beside it (a single build hitch shows there), not a phone frame budget.
  test.info().annotations.push({ type: 'frame gaps per row (ms)', description: JSON.stringify(crossings) })
  for (const f of crossings) expect(f.p95, `frame gaps while crossing: ${JSON.stringify(crossings)}`).toBeLessThan(120)
  const paints = (await wildsWindow(page))!.paints.filter((p) => !p.drift)
  // For the report: frame gaps per row crossed, and how long the chunks took to paint (and where).
  console.log('open-map walk', JSON.stringify({ crossings, maxGap: Math.max(...crossings.map((f) => f.max)), paints: paints.map((p) => [p.chunk, p.ms, p.thread]) }))
  expect(paints.some((p) => p.thread === 'worker'), 'chunks painted off the main thread while walking').toBe(true)
  await shot(page, '62-open-map-beyond-desktop')

  // Reload: the place is the server's; Continue puts you back where you stood
  // (once the report after the walk has reached it).
  const before = await steady(page, () => player(page), { frames: 4, seconds: 20, message: 'hero position after the open-map walk' })
  await expect.poll(async () => {
    const st = (await serverState(page)).body.state as { area: string; position: { x: number; y: number } }
    return st.area === 'outdoors' && Math.hypot(st.position.x - before.x, st.position.y - before.y) <= 17
  }, { timeout: 20_000 }).toBe(true)
  // And this tab's own record has it (a reload starts from the place the page last saved).
  await page.evaluate(() => (window as unknown as { __fsDevSaveSoon: () => void }).__fsDevSaveSoon())
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsDevSaved: () => { pending: boolean } }).__fsDevSaved().pending), {
    message: `local save should settle at ${before.x},${before.y}`
  }).toBe(false)
  const saved = await steady(page, () => page.evaluate(() => {
    const { area, position } = (window as unknown as { __fsDevSaved: () => { area: string; position: { x: number; y: number } } }).__fsDevSaved()
    return { area, ...position }
  }), { frames: 3, seconds: 20, message: 'local save position after the walk' })
  expect(saved.area).toBe('outdoors')
  expect(Math.abs(saved.x - before.x), 'local save x matches the settled hero').toBeLessThanOrEqual(17)
  expect(Math.abs(saved.y - before.y), 'local save y matches the settled hero').toBeLessThanOrEqual(17)
  // Reload rebuilds the enemy system: parked from its first frame, so a camp's
  // room that chased the parked hero can't knock him off the spot first.
  await parkCreatures(page, { keep: true })
  await reenter(page, 'outdoors')
  await waitForWilds(page)
  const after = await steady(page, () => player(page), { frames: 4, seconds: 20, message: 'hero position after re-entering the open map' })
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(17)
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(17)
})

/** The drift test's world (pinned; the edge is wick land, so its corridor is the same within a wick). */
const DRIFT_SEED = 'e2e-drift'
/** How many open rows a corridor up to the north edge has. */
const CORRIDOR = 4

/**
 * A straight corridor up to the frontier's north edge in the attached
 * chunks, nearest the hero first: a column whose edge-row tile and the
 * CORRIDOR - 1 tiles below it are open, with the columns either side open
 * too (room for the hero's body), by the map's data and by the collision
 * bodies actually built. Its foot and its top (the edge row), in tiles.
 */
async function northCorridor(page: Page, edgeTy: number): Promise<{ tx: number; foot: number; top: number } | null> {
  return page.evaluate(([edge, rows]) => {
    const w = window as unknown as { __fsPlayer: () => { x: number; y: number }; __fsTileSolid: (x: number, y: number) => boolean; __fsSolidAt: (x: number, y: number) => boolean; __fsWildsWindow: () => { attached: string[] } }
    const open = (x: number, y: number) => !w.__fsTileSolid(x, y) && !w.__fsSolidAt(x, y)
    const hx = Math.floor(w.__fsPlayer().x / 16)
    const cols = [...new Set(w.__fsWildsWindow().attached.map((k) => Number(k.split(',')[0])))]
      .flatMap((cx) => Array.from({ length: 24 }, (_, i) => cx * 24 + i))
      .filter((x) => w.__fsWildsWindow().attached.includes(`${Math.floor(x / 24)},${Math.floor(edge / 24)}`))
      .sort((a, b) => Math.abs(a - hx) - Math.abs(b - hx))
    for (const x of cols) {
      let ok = true
      for (let y = edge; y < edge + rows && ok; y++) ok = open(x - 1, y) && open(x, y) && open(x + 1, y)
      if (ok) return { tx: x, foot: edge + rows - 1, top: edge }
    }
    return null
  }, [edgeTy, CORRIDOR] as const)
}

test('the drift at the frontier stops you, and says so the first time', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  // The frontier's land is the wick's: both clocks a day or more from its turning.
  await wickSlack(page)
  await pinWorld(page, DRIFT_SEED)
  // The north edge of the frontier is cy -8 (three chunks past the Whitequiet).
  const edge = -8 * S
  const frontierTop = edge * TILE
  let corridor: Awaited<ReturnType<typeof northCorridor>> = null
  const tried: string[] = []
  for (const cx of [0, -3, 3]) {
    await warp(page, 'outdoors', cx * S + 12, edge + 12)
    await windowWhole(page)
    const w = (await wildsWindow(page))!
    expect(w.drift.length, 'past the edge is the drift').toBeGreaterThan(0)
    corridor = await northCorridor(page, edge)
    if (corridor) break
    tried.push(`no corridor around chunk ${cx},-8: ${await diagnose(page)}`)
  }
  expect(corridor, `a straight open corridor up to the north edge (seed ${DRIFT_SEED}): ${tried.join(' | ')}`).not.toBeNull()

  // At its foot, then up it to the edge row: the hero has to get there.
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [corridor!.tx * TILE + 8, corridor!.foot * TILE + 12] as const)
  await windowWhole(page)
  await walkTo(page, { maxTy: corridor!.top, minTx: corridor!.tx, maxTx: corridor!.tx })
  expect(Math.floor((await player(page)).y / TILE), `on the edge row: ${await diagnose(page)}`).toBe(corridor!.top)
  // Push into the drift.
  await waitForLive(page)
  await page.keyboard.down('ArrowUp')
  try {
    await expectToast(page, /The drift is thick here\. Not without a lamp\./, { timeout: 8_000 })
  } finally {
    await page.keyboard.up('ArrowUp')
  }
  expect((await player(page)).y, 'the hero never passes the frontier').toBeGreaterThanOrEqual(frontierTop)
  await shot(page, '63-open-map-drift-desktop')
  await settled(page, { area: 'outdoors' })
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
  await warp(page, 'outdoors', 22, -12)
  await waitForWilds(page)
  await warp(other, 'outdoors', 25, -12)
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
  await warp(other, 'outdoors', 3 * S + 12, -12)
  await waitForWilds(other)
  await expect.poll(async () => (await remotes(page)).length, { timeout: 15_000 }).toBe(0)
  await ctx.close()
})

type SceneSize = { list: number; tweens: number; transientTweens: number; statics: number; textures: number; listeners: number; kinds: Record<string, number> }
const sceneSize = (p: Page) => p.evaluate(() => (window as unknown as { __fsSceneSize: () => SceneSize }).__fsSceneSize())

/** The churn invariant: animation frames are one sprite; thought bubbles come and go. */
async function sceneResources(p: Page) {
  const z = await sceneSize(p)
  const drawn: Record<string, number> = {}
  for (const [k, n] of Object.entries(z.kinds)) {
    if (!/^(Image|Sprite|Blitter):/.test(k)) continue
    const key = k.replace(/-\d+$/, '')
    drawn[key] = (drawn[key] ?? 0) + n
  }
  // steady compares JSON, so changing display-list order must not change the sample.
  return { tweens: z.tweens, transientTweens: z.transientTweens, statics: z.statics, textures: z.textures, listeners: z.listeners, drawn: Object.fromEntries(Object.entries(drawn).sort(([a], [b]) => a.localeCompare(b))) }
}

/** Only the motes and their tween lifetime matter to a site redraw. */
async function moteResources(p: Page) {
  const z = await sceneSize(p)
  return { motes: z.kinds['Image:site-mote'] ?? 0, tweens: z.tweens }
}

/** A stable empty scene can precede the presence join: wait for every camp's sprites. */
async function campSpritesReady(p: Page): Promise<void> {
  await expect.poll(() => p.evaluate(() => {
    const hooks = window as unknown as {
      __fsWilds: () => { chunk: { cx: number; cy: number }; entities: { id: string; kind: string; state: string; availableIn: number; chunk: { cx: number; cy: number }; enemies: string[] }[] }
      __fsEnemies: () => { id: string; fight: unknown }[]
    }
    // Physics can settle the placed hero into another chunk. Read both sides
    // in one frame and derive coverage from that current physical position.
    const w = hooks.__fsWilds()
    const expected = Object.fromEntries(w.entities
      .filter(e => e.kind === 'camp' && e.state === 'available' && e.availableIn === 0 && Math.abs(e.chunk.cx - w.chunk.cx) <= 1 && Math.abs(e.chunk.cy - w.chunk.cy) <= 1)
      .map(e => [e.id, e.enemies.length]))
    const enemies = hooks.__fsEnemies()
    const counts: Record<string, number> = {}
    for (const e of enemies) {
      if (!e.fight) continue
      const camp = e.id.replace(/^wilds:/, '').replace(/:\d+$/, '')
      counts[camp] = (counts[camp] ?? 0) + 1
    }
    return {
      missing: Object.entries(expected).filter(([id, n]) => (counts[id] ?? 0) < n),
      extra: Object.entries(counts).filter(([id, n]) => n > (expected[id] ?? 0))
    }
  }), { timeout: 20_000, message: 'server sprites match the available camps in the current physical 3×3' }).toEqual({ missing: [], extra: [] })
}

/** The nearest open tile to (tx, ty), searched outward within any supplied bounds. */
const openNear = (p: Page, tx: number, ty: number, bounds: Parameters<typeof route>[1] = {}) =>
  p.evaluate(([x0, y0, b]) => {
    const hooks = window as unknown as { __fsTileSolid: (x: number, y: number) => boolean; __fsSolidAt: (x: number, y: number) => boolean }
    for (let r = 0; r < 12; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const x = x0 + dx
          const y = y0 + dy
          if (b.minTx !== undefined && x < b.minTx || b.maxTx !== undefined && x > b.maxTx || b.minTy !== undefined && y < b.minTy || b.maxTy !== undefined && y > b.maxTy) continue
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r && !hooks.__fsTileSolid(x, y) && !hooks.__fsSolidAt(x, y)) return { tx: x, ty: y }
        }
    return null
  }, [tx, ty, bounds] as const)

/** Stand on a tile, and wait until the window around it is whole (every chunk attached and built). */
async function standAt(p: Page, at: { tx: number; ty: number }): Promise<void> {
  await p.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [at.tx * TILE + 8, at.ty * TILE + 12] as const)
  const chunk = `${Math.floor(at.tx / S)},${Math.floor(at.ty / S)}`
  await expect.poll(async () => {
    const w = await wildsWindow(p)
    return !!w && w.ready && `${w.center?.cx},${w.center?.cy}` === chunk
  }, { timeout: 20_000 }).toBe(true)
}

/** Let the lazy tool hint settle too: a new hint image is legitimate, not a chunk leak. */
async function standForChurn(p: Page, at: { tx: number; ty: number }): Promise<void> {
  await standAt(p, at)
  await waitGame(p, () => p.evaluate(() => (window as unknown as { __fsGather: () => { hintSettled: boolean } }).__fsGather().hintSettled), v => v, { seconds: 5, message: 'the stationary gathering hint has settled' })
}

test('chunks walked in and out leave nothing behind: the tweens, the collision bodies and what is drawn come back to the same', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  await warp(page, 'outdoors', 12, -12)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
  // Two spots three chunks apart: moving between them swaps the whole 3×3
  // (the far one is known once the hero has stood halfway).
  const a = (await openNear(page, 12, -12))!
  await standAt(page, (await openNear(page, 12, -12 - 2 * S))!)
  const b = (await openNear(page, 12, -12 - 3 * S))!
  expect(a && b, 'open ground at both spots').toBeTruthy()
  await standForChurn(page, b)
  await standForChurn(page, a)
  await campSpritesReady(page)
  const before = await steady(page, () => sceneResources(page), { frames: 5, seconds: 20, message: 'open-map scene counts before churn', ready: z => z.transientTweens === 0 })
  expect(before.tweens, 'something glints here (the test needs tweens to watch)').toBeGreaterThan(0)
  expect(Object.keys(before.drawn).some((k) => k.startsWith('Blitter:')), 'flat decals are drawn by a blitter a chunk').toBe(true)
  for (let i = 0; i < 4; i++) {
    await standForChurn(page, b)
    await standForChurn(page, a)
  }
  await campSpritesReady(page)
  const after = await steady(page, () => sceneResources(page), { frames: 5, seconds: 20, message: 'open-map scene counts after churn', ready: z => z.transientTweens === 0 })
  expect(after, 'after four trips').toEqual(before)
})

test('the Commons’ fixed chunks walked in and out leave nothing behind either', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  // The Commons' square (fixed chunk 0,1, its lamps glowing) and the Tangle three chunks north:
  // standing at one then the other swaps the whole 3×3 (fixed and generated chunks both).
  await warp(page, 'outdoors', 2, 44)
  await waitForWilds(page)
  await windowWhole(page)
  await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
  const a = (await openNear(page, 2, 44))!
  await standAt(page, (await openNear(page, 2, 44 - 2 * S))!)
  const b = (await openNear(page, 2, 44 - 3 * S))!
  expect(a && b, 'open ground at both spots').toBeTruthy()
  await standForChurn(page, b)
  await standForChurn(page, a)
  expect((await wildsWindow(page))!.fixed.length, 'the Commons attached').toBe(6)
  await campSpritesReady(page)
  const before = await steady(page, () => sceneResources(page), { frames: 5, seconds: 20, message: 'Commons scene counts before churn', ready: z => z.transientTweens === 0 })
  expect(Object.keys(before.drawn).some((k) => k.startsWith('Image:hw2:') || k.startsWith('Image:commons-')), 'the Commons’ scenery is drawn').toBe(true)
  for (let i = 0; i < 4; i++) {
    await standForChurn(page, b)
    await expect.poll(async () => (await wildsWindow(page))!.fixed, { timeout: 5_000, message: 'the Commons detached' }).toEqual([])
    await standForChurn(page, a)
  }
  await campSpritesReady(page)
  const after = await steady(page, () => sceneResources(page), { frames: 5, seconds: 20, message: 'Commons scene counts after churn', ready: z => z.transientTweens === 0 })
  expect(after, 'after four trips').toEqual(before)
})

test('stepping back and forth over a chunk edge builds and drops nothing; the 3×3 around the hero is always whole', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  await warp(page, 'outdoors', 12, -12)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
  // Stay on the intended side and within the window's eight-tile retention
  // slack: a search through solid ground must not cross the edge itself.
  const south = await openNear(page, 12, -S + 2, { minTx: 0, maxTx: S - 1, minTy: -S, maxTy: -S + 7 })
  const north = await openNear(page, 12, -S - 3, { minTx: 0, maxTx: S - 1, minTy: -S - 8, maxTy: -S - 1 })
  expect(south, 'open land just south of the edge').not.toBeNull()
  expect(north, 'open land just north of the edge').not.toBeNull()
  expect(Math.floor(south!.ty / S), 'south of the edge').toBe(-1)
  expect(Math.floor(north!.ty / S), 'north of the edge').toBe(-2)
  await standAt(page, south!)
  await standAt(page, north!)
  const first = (await wildsWindow(page))!
  for (let i = 0; i < 5; i++) {
    await standAt(page, south!)
    await standAt(page, north!)
  }
  const after = (await wildsWindow(page))!
  expect({ attaches: after.attaches, drops: after.drops }, 'nothing built or dropped crossing back and forth').toEqual({ attaches: first.attaches, drops: first.drops })
  expect(after.attached, 'the row behind is kept while the hero is near the edge').toContain('0,0')
  // Further on, the row behind goes.
  await standAt(page, (await openNear(page, 12, -2 * S + 4))!)
  await expect.poll(async () => (await wildsWindow(page))!.attached, { timeout: 5_000 }).not.toContain('0,0')
})

/** The white quiet's motes the scene holds (26 a chunk in the deep drift's look). */
const motes = async (p: Page) => (await sceneSize(p)).kinds['Image:site-mote'] ?? 0
const MOTES = 26

test('the Whitequiet’s motes drift with each outer chunk, stay through its sites redrawing, and go with it', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  await warp(page, 'outdoors', 12, -3 * S + 12)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
  const here = (await openNear(page, 12, -3 * S + 12))!
  await standAt(page, here)
  const outer = (await steady(page, () => wildsWindow(page), { frames: 4, seconds: 20, message: 'Whitequiet window around the hero' }))!.outer
  expect(outer.length, 'outer chunks around the Whitequiet').toBeGreaterThan(0)
  expect(await motes(page), `${MOTES} motes a chunk for ${outer.join(' ')}`).toBe(MOTES * outer.length)
  const before = await steady(page, () => moteResources(page), { frames: 5, seconds: 20, message: 'Whitequiet scene counts before redraw' })

  // A paper found redraws every site layer (its key counts paper flags): the motes stay, nothing doubles.
  await page.evaluate(() => (window as unknown as { __fsDevAddFlag: (f: string) => void }).__fsDevAddFlag('paper:motes-test'))
  await frames(page, 5)
  await expect.poll(async () => moteResources(page), {
    timeout: 20_000,
    message: 'Whitequiet scene counts settle after redraw'
  }).toEqual({
    motes: MOTES * outer.length,
    tweens: before.tweens
  })
  const after = await moteResources(page)
  expect(after.motes, 'the motes survive the redraw').toBe(MOTES * outer.length)
  expect(after.tweens, 'and so do their tweens (no more, no fewer)').toBe(before.tweens)

  // Back into the Tangle: the outer chunks go, and their motes and tweens with them.
  await standAt(page, (await openNear(page, 12, -S - 12))!)
  await standAt(page, (await openNear(page, 12, 12))!)
  const left = (await steady(page, () => wildsWindow(page), { frames: 4, seconds: 20, message: 'outer chunks after returning to the Tangle' }))!.outer
  expect(await motes(page), `only the outer chunks still attached (${left.join(' ') || 'none'}) keep theirs`).toBe(MOTES * left.length)
  expect((await sceneSize(page)).tweens).toBeLessThan(before.tweens - MOTES * (outer.length - left.length) + 1)
})

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })
  test('the Whitequiet’s motes stand still', async ({ page }) => {
    test.setTimeout(120_000)
    await freshPlayer(page)
    await warp(page, 'outdoors', 12, -3 * S + 12)
    await waitForWilds(page)
    await standAt(page, (await openNear(page, 12, -3 * S + 12))!)
    const outer = (await steady(page, () => wildsWindow(page), { frames: 4, seconds: 20, message: 'reduced-motion Whitequiet window' }))!.outer
    expect(await motes(page)).toBe(MOTES * outer.length)
    const tweens = await steady(page, async () => (await sceneSize(page)).tweens, { frames: 5, seconds: 20, message: 'reduced-motion scene tween count' })
    expect(tweens, 'nothing in the Wilds tweens with motion reduced').toBe(0)
  })
})
