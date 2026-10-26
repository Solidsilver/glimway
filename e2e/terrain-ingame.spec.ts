import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures'
import { player, waitForLive, warp } from './helpers'
import { freshPlayer } from './home-helpers'
import { CLIFF, decodeTerrainBatch } from '../src/game/terrain/surface'
import { TerrainStore } from '../src/game/terrain/store'
import type { TerrainSettings } from '../src/game/terrain/settings'

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
const SCAN = 18

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

interface Spots {
  seam: { tx: number; ty: number; edge: number }
  climb: { tx: number; ty: number; rise: number }
  cliff: { tx: number; ty: number; face: number }
  ridge: { tx: number; ty: number; rise: number }
}

/** The nearest-home examples of each feature (tiles), on ground the hero can stand on. */
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
  let seam: Spots['seam'] | null = null
  let climb: Spots['climb'] | null = null
  let cliff: Spots['cliff'] | null = null
  let ridge: Spots['ridge'] | null = null
  for (const [tx, ty] of near) {
    // A chunk edge crossed on open, raised ground: four tiles either side.
    if (!seam && ((tx + 4) % S + S) % S === 0 && z(tx, ty) > 0.2 && open(tx, ty, 8, 1, 0) && open(tx, ty - 1, 8, 1, 0)) seam = { tx, ty, edge: tx + 4 }
    // A straight climb north: 8 open steps rising at least a level.
    if (!climb && open(tx, ty, 8, 0, -1) && open(tx - 1, ty, 8, 0, -1) && z(tx, ty - 8) - z(tx, ty) > 1) climb = { tx, ty, rise: z(tx, ty - 8) - z(tx, ty) }
    // A cliff face's bottom row with open ground below it and room to walk up to it.
    if (!cliff && t.kindAt(tx, ty) === CLIFF && t.walkable(tx, ty + 1) && open(tx, ty + 1, 3, 0, 1) && open(tx - 1, ty + 1, 3, 0, 1) && t.kindAt(tx, ty - 1) === CLIFF) cliff = { tx, ty: ty + 2, face: ty }
    // Ground rising fast to the south: in the lift, nearer and higher ground hides the legs.
    if (!ridge && t.walkable(tx, ty) && t.walkable(tx, ty - 1)) {
      let rise = 0
      for (let k = 1; k <= 6; k++) if (ty + k + 0.5 - 3 * z(tx, ty + k) < ty + 0.7 - 3 * z(tx, ty) - 0.4) rise = Math.max(rise, z(tx, ty + k) - z(tx, ty))
      if (rise > 0.9) ridge = { tx, ty, rise }
    }
    if (seam && climb && cliff && ridge) break
  }
  expect(seam, 'a seam to cross near home').not.toBeNull()
  expect(climb, 'a slope to climb near home').not.toBeNull()
  expect(cliff, 'a cliff near home').not.toBeNull()
  expect(ridge, 'a ridge to stand behind near home').not.toBeNull()
  return { seam: seam!, climb: climb!, cliff: cliff!, ridge: ridge! }
}

test.describe('height terrain in the Wilds', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('dev switch: walk generated land near home, top-down and in the ¾ lift', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await freshPlayer(page)
    const spots = find(await scan(page))
    const frames: Record<string, unknown> = { spots }
    const save = () => writeFileSync(`${OUT}/evidence.json`, JSON.stringify(frames, null, 1))
    await setTerrain(page, { on: true, mode: 'top', sunClock: false, sunTime: 0.3, edgeShade: 0.6, uphill: 60, downhill: 6 })

    for (const mode of ['top', 'lift'] as const) {
      await setTerrain(page, { mode })
      // Cross a chunk seam, east, on raised ground.
      await standAt(page, spots.seam.tx, spots.seam.ty)
      await shot(page, `${mode}-seam`, frames)
      await holdKey(page, 'ArrowRight', 1300)
      const across = await player(page)
      expect(Math.floor(across.x / T), `${mode}: crossed the seam at ${spots.seam.edge}`).toBeGreaterThanOrEqual(spots.seam.edge)
      await shot(page, `${mode}-seam-crossed`, frames)

      // Climb: slower up than down the same slope.
      await standAt(page, spots.climb.tx, spots.climb.ty)
      await shot(page, `${mode}-climb-foot`, frames)
      const y0 = (await player(page)).y
      await holdKey(page, 'ArrowUp', 700)
      const st = (await state(page))!
      const y1 = (await player(page)).y
      await holdKey(page, 'ArrowDown', 700)
      const y2 = (await player(page)).y
      const up = y0 - y1
      const down = y2 - y1
      frames[`${mode}-climb`] = { up, down, k: st.k, gradient: st.hero.gradient }
      expect(up, `${mode}: walked uphill`).toBeGreaterThan(8)
      expect(up / down, `${mode}: uphill is slower (up ${up}, down ${down})`).toBeLessThan(0.92)
      await shot(page, `${mode}-climb-after`, frames)

      // A cliff: walking north into its face stops below it.
      await standAt(page, spots.cliff.tx, spots.cliff.ty)
      const before = (await state(page))!.blocked
      await holdKey(page, 'ArrowUp', 1200)
      const p = await player(page)
      const after = (await state(page))!
      frames[`${mode}-cliff`] = { at: [p.x, p.y], face: spots.cliff.face, blocked: after.blocked - before }
      expect(Math.floor((p.y - 2) / T), `${mode}: stopped below the face`).toBeGreaterThan(spots.cliff.face)
      expect(after.blocked, `${mode}: the field blocked the walk`).toBeGreaterThan(before)
      await shot(page, `${mode}-cliff`, frames)

      // Behind a ridge: in the lift, only what's covered shows as the outline.
      await standAt(page, spots.ridge.tx, spots.ridge.ty)
      const behind = await shot(page, `${mode}-ridge`, frames)
      if (mode === 'lift') {
        expect(behind.cover.covered, 'lift: part of the hero is behind the ridge').toBeGreaterThan(0)
        expect(behind.cover.covered, 'lift: not all of it').toBeLessThan(behind.cover.total)
      } else expect(behind.cover.covered, 'top-down: nothing covers the hero').toBe(0)
      save()
    }

    // Budgets: terrain work per frame, bakes, and textures let go.
    const last = (await state(page))!
    frames.budget = { frameMs: last.frameMs, bakeMs: last.bakeMs, textures: last.textures, images: last.images.length }
    save()
    expect(last.frameMs.p95, 'terrain CPU p95 per frame (ms)').toBeLessThan(2)
    expect(last.textures, 'textures only for attached chunks').toBeLessThanOrEqual(last.images.length + 2)

    // Off again: the flat Wilds, the terrain gone.
    await setTerrain(page, { on: false })
    await expect.poll(async () => (await state(page))?.on).toBe(false)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/off.png` })
    expect((await state(page))!.textures).toBe(0)
  })
})
