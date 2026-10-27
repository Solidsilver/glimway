import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures'
import { player, waitForLive, warp } from './helpers'
import { freshPlayer } from './home-helpers'
import { CLIFF, decodeTerrainBatch } from '../src/game/terrain/surface'
import { TerrainStore } from '../src/game/terrain/store'
import type { TerrainSettings } from '../src/game/terrain/settings'
import { buildWindow } from '../src/game/terrain/window-field'
import { windowView } from '../src/game/terrain/bake'
import { coveredPixels } from '../src/game/terrain/field'

/**
 * Generated height terrain in the real Wilds, on the dev server, behind the
 * dev switch (src/game/terrain, docs/planning/wide-world/terrain-ingame-notes.md).
 * The spec reads the dev route itself to find, near home, a chunk seam to
 * cross, a slope to climb, a cliff to be stopped by and a ridge to stand
 * behind; then walks them in top-down and in the true ¾ lift, saving the
 * frames (.e2e-artifacts/terrain-ingame/) to be looked at. With the switch
 * off nothing here runs and the Wilds are flat (the other open-map specs).
 */

const OUT = '.e2e-artifacts/terrain-ingame'
const T = 16
const S = 24
/** Chunks scanned round home for the features. */
const SCAN = 22

type Terrain = Record<string, unknown> & {
  on: boolean
  chunks: number
  pending: number
  images: { key: string; edges: number }[]
  hero: { x: number; y: number; tile: number[]; z: number; kind: number; walkable: boolean; gradient: number[] }
  k: number
  blocked: number
  cover: { covered: number; total: number }
  bakeMs: { p95: number; max: number; n: number }
  startMs: { p95: number; max: number; n: number }
  frameMs: { p95: number; max: number; n: number }
  textures: number
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __fsTerrain: () => Terrain | null }).__fsTerrain())
const setTerrain = (page: Page, s: Partial<TerrainSettings>) => page.evaluate((c) => (window as unknown as { __fsTerrainSet: (c: Partial<TerrainSettings>) => void }).__fsTerrainSet(c), s)

/** The terrain round the hero is in and every attached chunk baked for the current look. */
async function baked(page: Page): Promise<Terrain> {
  let last: Terrain | null = null
  await expect.poll(async () => {
    last = await state(page)
    return !!last && last.on && last.chunks >= 25 && last.pending === 0 && last.images.length >= 9
  }, { timeout: 60_000, message: `terrain baked: ${JSON.stringify(last)}` }).toBe(true)
  // A frame or two for the newest bake's texture to draw, and a settled camera.
  await page.waitForTimeout(900)
  const again = (await state(page))!
  if (again.pending) return baked(page)
  return again
}

async function shot(page: Page, name: string, frames: Record<string, unknown>): Promise<Terrain> {
  const st = await baked(page)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  const vp = page.viewportSize()!
  await page.screenshot({ path: `${OUT}/${name}-crop.png`, clip: { x: vp.width / 2 - 200, y: vp.height / 2 - 140, width: 400, height: 280 } })
  frames[name] = { hero: st.hero, cover: st.cover, images: st.images.length, edges: st.images.reduce((a, i) => a + i.edges, 0) }
  return st
}

async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await waitForLive(page)
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
  await page.waitForTimeout(150)
}

/** Stand at a world tile (feet a little below its middle) with the terrain baked round it. */
async function standAt(page: Page, tx: number, ty: number): Promise<Terrain> {
  await warp(page, 'outdoors', tx, ty)
  const st = await baked(page)
  return st
}

/** The terrain near home, read from the dev route the game reads, into the client's own store. */
async function scan(page: Page): Promise<TerrainStore> {
  const store = new TerrainStore(() => Promise.reject(new Error('scan only')))
  const all: [number, number][] = []
  for (let cy = -SCAN; cy <= SCAN; cy++) for (let cx = -SCAN; cx <= SCAN; cx++) all.push([cx, cy])
  for (let i = 0; i < all.length; i += 49) {
    const q = all.slice(i, i + 49).map(([cx, cy]) => `c=${cx},${cy}`).join('&')
    const res = await page.request.get(`/api/dev/terrain?${q}`)
    expect(res.status(), 'the dev server serves terrain').toBe(200)
    for (const g of decodeTerrainBatch(new Uint8Array(await res.body()))) store.put(g.cx, g.cy, g.surface)
  }
  return store
}

interface Spot {
  tx: number
  ty: number
  /** Tiles the walk crosses: none may be solid in the flat Wilds (a tree, the Tangle). */
  path: [number, number][]
  /** A climb: the key that walks up it (and the other way back). */
  up?: 'ArrowUp' | 'ArrowDown'
  /** The seam's or the face's row or column. */
  at: number
  rise: number
}
interface Spots {
  seam: Spot[]
  climb: Spot[]
  cliff: Spot[]
  ridge: Spot[]
}

/** Candidates for each feature, nearest home first, at least four tiles apart (the flat Wilds' trees are checked once there). */
function find(t: TerrainStore): Spots {
  const lo = -SCAN * S + 4
  const hi = (SCAN + 1) * S - 4
  const near: [number, number][] = []
  for (let ty = lo; ty < hi; ty++) for (let tx = lo; tx < hi; tx++) near.push([tx, ty])
  // Home is the Commons, about (12, 60).
  near.sort((a, b) => Math.hypot(a[0] - 12, a[1] - 60) - Math.hypot(b[0] - 12, b[1] - 60))
  const z = (tx: number, ty: number) => t.zAt(tx * T + 8, ty * T + 8)
  const open = (tx: number, ty: number, n: number, dx: number, dy: number) => {
    for (let i = 0; i < n; i++) if (!t.canStep(tx + dx * i, ty + dy * i, dx === 1 ? 1 : dx === -1 ? 3 : dy === 1 ? 2 : 0)) return false
    return true
  }
  const line = (tx: number, ty: number, n: number, dx: number, dy: number): [number, number][] => Array.from({ length: n + 1 }, (_, i) => [tx + dx * i, ty + dy * i])
  const out: Spots = { seam: [], climb: [], cliff: [], ridge: [] }
  const add = (list: Spot[], s: Spot) => {
    // Broad shoulders offer many climbs along the same wooded foothill. Spread
    // candidates across it so one patch of cover cannot exhaust the search.
    const climb = list === out.climb
    if (list.length >= (climb ? 64 : 12) || list.some((o) => Math.hypot(o.tx - s.tx, o.ty - s.ty) < (climb ? 12 : 4))) return
    list.push(s)
  }
  for (const [tx, ty] of near) {
    if (out.seam.length >= 12 && out.climb.length >= 64 && out.cliff.length >= 12 && out.ridge.length >= 12) break
    // A chunk edge crossed on open, raised ground: four tiles either side.
    if (((tx + 4) % S + S) % S === 0 && z(tx, ty) > 0.2 && open(tx, ty, 8, 1, 0)) add(out.seam, { tx, ty, path: line(tx, ty, 8, 1, 0), at: tx + 4, rise: 0 })
    // A straight climb north or south: 8 open steps rising at least 0.6 of a level.
    if (open(tx, ty, 8, 0, -1) && z(tx, ty - 8) - z(tx, ty) > 0.6) add(out.climb, { tx, ty, path: line(tx, ty, 8, 0, -1), at: ty - 8, rise: z(tx, ty - 8) - z(tx, ty), up: 'ArrowUp' })
    else if (open(tx, ty, 8, 0, 1) && z(tx, ty + 8) - z(tx, ty) > 0.6) add(out.climb, { tx, ty, path: line(tx, ty, 8, 0, 1), at: ty + 8, rise: z(tx, ty + 8) - z(tx, ty), up: 'ArrowDown' })
    // A cliff face's bottom row with open ground below it and room to walk up to it.
    if (t.kindAt(tx, ty) === CLIFF && t.kindAt(tx, ty - 1) === CLIFF && open(tx, ty + 1, 3, 0, 1)) add(out.cliff, { tx, ty: ty + 2, path: line(tx, ty - 1, 5, 0, 1), at: ty, rise: 0 })
    // Ground rising to the south: in the lift, nearer and higher ground covers the legs, not the head.
    if (out.ridge.length < 12 && t.walkable(tx, ty)) {
      const here = z(tx, ty)
      const foot = ty + 0.7 - 3 * here
      let top = Infinity
      let rise = 0
      for (let k = 1; k <= 46; k++) {
        const zk = z(tx, ty + k)
        if (Number.isNaN(zk) || zk < here + 0.3) continue
        top = Math.min(top, ty + k - 3 * zk)
        rise = Math.max(rise, zk - here)
      }
      // Near the knees to the waist by a rough look, then exactly as the game works it out (./field.ts coveredPixels)
      // for a hero-sized box standing where a warp puts the feet: some of it covered, not all.
      if (top < foot - 0.1 && top > foot - 2) {
        const ox = tx - 6
        const oy = ty - 8
        const view = windowView(buildWindow(t, ox, oy, 13, 56), true)
        const fx = tx * T + 8
        const fy = ty * T + 8
        const zf = t.zAt(fx, fy - 2)
        const sy = fy - 3 * T * zf
        const mask = coveredPixels(view, fy - 2 - oy * T, zf, fx - 6 - ox * T, sy - 21 - (oy - view.pad) * T, 12, 22)
        const n = mask.reduce((a, m) => a + m, 0)
        if (n > 12 * 22 * 0.1 && n < 12 * 22 * 0.75) add(out.ridge, { tx, ty, path: [[tx, ty]], at: ty, rise })
      }
    }
  }
  for (const k of ['seam', 'climb', 'cliff', 'ridge'] as const) expect(out[k].length, `${k} candidates near home`).toBeGreaterThan(0)
  return out
}

/** Warp to a candidate and keep it if no tile of its walk is solid in the flat Wilds; the first that works. */
async function usable(page: Page, list: Spot[], name: string): Promise<Spot> {
  const tried: string[] = []
  for (const s of list) {
    await standAt(page, s.tx, s.ty)
    const blocked = await page.evaluate((path) => {
      // Collision bodies only (trees, water): the terrain's own closed ground is solid to the open map too.
      const w = window as unknown as { __fsSolidAt: (x: number, y: number) => boolean }
      return path.filter(([x, y]) => w.__fsSolidAt(x, y)).length
    }, s.path)
    const p = await player(page)
    if (!blocked && Math.floor(p.x / T) === s.tx && Math.floor((p.y - 2) / T) === s.ty) return s
    tried.push(`${s.tx},${s.ty}: ${blocked} solid, stood at ${Math.floor(p.x / T)},${Math.floor((p.y - 2) / T)}`)
  }
  throw new Error(`no usable ${name}: ${tried.join(' | ')}`)
}
test.describe('height terrain in the Wilds', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('dev switch: walk generated land near home, top-down and in the ¾ lift', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await freshPlayer(page)
    const spots = find(await scan(page))
    const frames: Record<string, unknown> = { candidates: spots }
    const save = () => writeFileSync(`${OUT}/evidence.json`, JSON.stringify(frames, null, 1))
    // Full height: the ridge was picked by the 3-rows-a-level lift (find).
    await setTerrain(page, { on: true, mode: 'top', tall: 'full', sunClock: false, sunTime: 0.3, edgeShade: 0.6, uphill: 60, downhill: 6 })
    const seam = await usable(page, spots.seam, 'seam')
    const climb = await usable(page, spots.climb, 'climb')
    const cliff = await usable(page, spots.cliff, 'cliff')
    const ridge = await usable(page, spots.ridge, 'ridge')
    frames.chosen = { seam, climb, cliff, ridge }
    save()

    for (const mode of ['top', 'lift'] as const) {
      await setTerrain(page, { mode })
      // Cross a chunk seam, east, on raised ground.
      await standAt(page, seam.tx, seam.ty)
      await shot(page, `${mode}-seam`, frames)
      await holdKey(page, 'ArrowRight', 1300)
      const across = await player(page)
      expect(Math.floor(across.x / T), `${mode}: crossed the seam at ${seam.at}`).toBeGreaterThanOrEqual(seam.at)
      await shot(page, `${mode}-seam-crossed`, frames)

      // Climb: slower up than down the same slope, each walked from its own warp (the foot, then the top).
      // Measured twice at most: a creature can wander into the way.
      let up = 0
      let down = 0
      const back = climb.up === 'ArrowDown' ? 'ArrowUp' : 'ArrowDown'
      for (let tries = 0; tries < 2; tries++) {
        await standAt(page, climb.tx, climb.ty)
        if (tries === 0) await shot(page, `${mode}-climb-foot`, frames)
        const y0 = (await player(page)).y
        await holdKey(page, climb.up ?? 'ArrowUp', 700)
        const st = (await state(page))!
        up = Math.abs((await player(page)).y - y0)
        await standAt(page, climb.tx, climb.at)
        const y1 = (await player(page)).y
        await holdKey(page, back, 700)
        const st2 = (await state(page))!
        down = Math.abs((await player(page)).y - y1)
        frames[`${mode}-climb-${tries}`] = { up, down, kUp: st.k, kDown: st2.k, gradient: st.hero.gradient, blocked: st2.blocked }
        save()
        if (up > 8 && up / down < 0.92) break
      }
      expect(up, `${mode}: walked uphill`).toBeGreaterThan(8)
      expect(up / down, `${mode}: uphill is slower (up ${up}, down ${down})`).toBeLessThan(0.92)
      await shot(page, `${mode}-climb-after`, frames)

      // A cliff: walking north into its face stops below it.
      await standAt(page, cliff.tx, cliff.ty)
      const before = (await state(page))!.blocked
      await holdKey(page, 'ArrowUp', 1200)
      const p = await player(page)
      const after = (await state(page))!
      frames[`${mode}-cliff`] = { at: [p.x, p.y], face: cliff.at, blocked: after.blocked - before }
      expect(Math.floor((p.y - 2) / T), `${mode}: stopped below the face`).toBeGreaterThan(cliff.at)
      expect(after.blocked, `${mode}: the field blocked the walk`).toBeGreaterThan(before)
      await shot(page, `${mode}-cliff`, frames)

      // Behind a ridge: in the lift, only what's covered shows as the outline.
      await standAt(page, ridge.tx, ridge.ty)
      const behind = await shot(page, `${mode}-ridge`, frames)
      if (mode === 'lift') {
        expect(behind.cover.covered, 'lift: part of the hero is behind the ridge').toBeGreaterThan(0)
        expect(behind.cover.covered, 'lift: not all of it').toBeLessThan(behind.cover.total)
      } else expect(behind.cover.covered, 'top-down: nothing covers the hero').toBe(0)
      save()
    }

    // Budgets: terrain work per frame, bakes, and textures let go.
    // Measured over a steady walk in the lift (warps and arrivals are the bake starts, timed apart).
    await standAt(page, seam.tx, seam.ty)
    await page.evaluate(() => (window as unknown as { __fsTerrainReset: () => void }).__fsTerrainReset())
    for (let i = 0; i < 3; i++) {
      await holdKey(page, 'ArrowRight', 900)
      await holdKey(page, 'ArrowLeft', 900)
    }
    const last = (await state(page))!
    frames.budget = { frameMs: last.frameMs, startMs: last.startMs, bakeMs: last.bakeMs, textures: last.textures, images: last.images.length }
    save()
    expect(last.frameMs.p95, 'terrain CPU p95 per frame (ms)').toBeLessThan(2)
    expect(last.startMs.p95, 'a chunk bake started: no big stall (ms)').toBeLessThan(16)
    expect(last.textures, 'textures only for attached chunks').toBeLessThanOrEqual(last.images.length + 2)

    // Off again: the flat Wilds, the terrain gone.
    await setTerrain(page, { on: false })
    await expect.poll(async () => (await state(page))?.on).toBe(false)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/off.png` })
    expect((await state(page))!.textures).toBe(0)
  })
})

// The original short hill check cannot catch an entirely closed upper range.
// Find a substantial high shoulder in the bytes served to this player, then
// use real keyboard movement (and the flat Wilds collision bodies) to climb it.
test('generated range shoulder: walk uphill at least three levels', async ({ page }) => {
  test.setTimeout(600_000)
  mkdirSync(OUT, { recursive: true })
  await freshPlayer(page)
  const terrain = await scan(page)
  const candidates: Spot[] = []
  const z = (x: number, y: number) => terrain.zAt(x * T + 8, y * T + 8)
  for (let y = -SCAN * S + 40; y < SCAN * S - 40; y += 3) {
    for (let x = -SCAN * S + 40; x < SCAN * S - 40; x += 3) {
      for (const dy of [-1, 1]) {
        const n = 36
        const rise = z(x, y + dy * n) - z(x, y)
        if (rise < 3.6 || z(x, y + dy * n) < 8 || z(x, y) < 2) continue
        const path: [number, number][] = Array.from({ length: n + 1 }, (_, i) => [x, y + dy * i])
        if (path.some(([tx, ty], i) => !terrain.walkable(tx, ty) || (i < n && !terrain.canStep(tx, ty, dy > 0 ? 2 : 0)) || (i > 0 && z(tx, ty) < z(x, ty - dy) - 0.02))) continue
        candidates.push({ tx: x, ty: y, path, at: y + dy * n, rise, up: dy > 0 ? 'ArrowDown' : 'ArrowUp' })
      }
    }
  }
  expect(candidates.length, 'long walkable shoulders reaching level eight').toBeGreaterThan(0)
  candidates.sort((a, b) => Math.hypot(a.tx - 12, a.ty - 60) - Math.hypot(b.tx - 12, b.ty - 60))
  await setTerrain(page, { on: true, mode: 'top', uphill: 0, downhill: 0, sunClock: false, sunTime: 0.3 })
  const shoulder = await usable(page, candidates.slice(0, 100), 'high range shoulder')
  const frames: Record<string, unknown> = { shoulder, candidates: candidates.length }
  for (const mode of ['top', 'lift'] as const) {
    await setTerrain(page, { mode })
    const start = await standAt(page, shoulder.tx, shoulder.ty)
    await shot(page, `shoulder-${mode}-foot`, frames)
    await waitForLive(page)
    await page.keyboard.down(shoulder.up!)
    try {
      await expect.poll(async () => ((await state(page))?.hero.z ?? start.hero.z) - start.hero.z,
        { timeout: 25_000, message: `${mode}: climb three levels through actual terrain collision` }).toBeGreaterThanOrEqual(3)
    } finally {
      await page.keyboard.up(shoulder.up!)
    }
    const end = await shot(page, `shoulder-${mode}-high`, frames)
    expect(end.hero.walkable).toBe(true)
    expect(end.hero.z - start.hero.z).toBeGreaterThanOrEqual(3)
    frames[`${mode}-rise`] = { start: start.hero, end: end.hero, rise: end.hero.z - start.hero.z }
    writeFileSync(`${OUT}/shoulder-evidence.json`, JSON.stringify(frames, null, 2))
  }
})
