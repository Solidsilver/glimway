import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures'
import { player, waitForLive, warp } from './helpers'
import { freshPlayer } from './home-helpers'
import { decodeTerrainBatch } from '../src/game/terrain/surface'
import { TerrainStore } from '../src/game/terrain/store'
import type { TerrainSettings } from '../src/game/terrain/settings'

/**
 * The ¾ lift beside high ground (exp/terrain-lift-fix,
 * docs/planning/wide-world/terrain-ingame-notes.md): no void where lifted
 * land reaches the view from chunks south of the attached 3×3, at full
 * height and compressed, right after a warp while bakes are pending, and
 * top-down. The void check draws one frame over a magenta background and
 * counts what shows through (__fsTerrainVoid). Frames go to
 * .e2e-artifacts/terrain-lift/ to be looked at.
 */

const OUT = '.e2e-artifacts/terrain-lift'
const T = 16
const S = 24
const HIGH = 8

type Terrain = Record<string, unknown> & {
  on: boolean
  chunks: number
  pending: number
  pendingQuick: number
  need: string[]
  missing: string[]
  images: { key: string; quick: boolean; look: string; w: number; h: number }[]
  hero: { x: number; y: number; tile: number[]; z: number }
  bytes: number
  textures: number
  bakes: number
  quick: number
  bakeMs: { p50: number; p95: number; max: number; n: number }
  quickMs: { p50: number; p95: number; max: number; n: number }
  startMs: { p50: number; p95: number; max: number; n: number }
  frameMs: { p50: number; p95: number; max: number; n: number }
}
type Void = { void: number; total: number; at: [number, number][]; why: Record<string, unknown>[] }

const state = (page: Page) => page.evaluate(() => (window as unknown as { __fsTerrain: () => Terrain | null }).__fsTerrain())
const setTerrain = (page: Page, s: Partial<TerrainSettings>) => page.evaluate((c) => (window as unknown as { __fsTerrainSet: (c: Partial<TerrainSettings>) => void }).__fsTerrainSet(c), s)
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __fsTerrainVoid: () => Promise<Void> | null }).__fsTerrainVoid()) as Promise<Void | null>

/** Every chunk the view needs drawn for the look, by its real bake (not a placeholder), nothing in flight. */
async function settled(page: Page): Promise<Terrain> {
  let last: Terrain | null = null
  await expect.poll(async () => {
    last = await state(page)
    if (!last || !last.on || last.pending || last.pendingQuick || last.missing.length || last.images.length < 9) return false
    const quick = new Set(last.images.filter((i) => i.quick).map((i) => i.key))
    return !last.need.some((k) => quick.has(k))
  }, { timeout: 90_000, message: `terrain settled: ${JSON.stringify(last)}` }).toBe(true)
  await page.waitForTimeout(900)
  const again = (await state(page))!
  if (again.pending || again.pendingQuick) return settled(page)
  return again
}

/** A frame: the void check, the screenshot and its middle crop, and the state, kept in the evidence. */
async function frame(page: Page, name: string, evidence: Record<string, unknown>): Promise<{ st: Terrain; v: Void }> {
  const v = (await probe(page))!
  const st = (await state(page))!
  await page.screenshot({ path: `${OUT}/${name}.png` })
  const vp = page.viewportSize()!
  await page.screenshot({ path: `${OUT}/${name}-crop.png`, clip: { x: vp.width / 2 - 240, y: vp.height / 2 - 170, width: 480, height: 340 } })
  evidence[name] = {
    void: v,
    hero: st.hero,
    need: st.need,
    missing: st.missing,
    pending: st.pending,
    pendingQuick: st.pendingQuick,
    images: st.images.length,
    quickImages: st.images.filter((i) => i.quick).map((i) => i.key),
    bytes: st.bytes,
    textures: st.textures,
    settings: st.settings
  }
  return { st, v }
}

/** The dev route's terrain within `r` chunks of home, into a store. */
async function scan(page: Page, r: number, store: TerrainStore, done: Set<string>): Promise<void> {
  const all: [number, number][] = []
  for (let cy = -r; cy <= r; cy++) for (let cx = -r; cx <= r; cx++) if (!done.has(`${cx},${cy}`)) all.push([cx, cy])
  for (let i = 0; i < all.length; i += 49) {
    const batch = all.slice(i, i + 49)
    const res = await page.request.get(`/api/dev/terrain?${batch.map(([cx, cy]) => `c=${cx},${cy}`).join('&')}`)
    expect(res.status(), 'the dev server serves terrain').toBe(200)
    for (const g of decodeTerrainBatch(new Uint8Array(await res.body()))) store.put(g.cx, g.cy, g.surface)
    for (const [cx, cy] of batch) done.add(`${cx},${cy}`)
  }
}

interface Spot {
  tx: number
  ty: number
  /** The high ground's tile and level. */
  high: [number, number, number]
}

/**
 * Walkable low tiles near high ground (level HIGH and up), nearest home
 * first: `south`, the range lies south of the tile (lifted into the view
 * from chunks past the 3×3); `beside`, it lies east or west on about the
 * same row (its east or west side in view).
 */
function spots(t: TerrainStore, r: number): { south: Spot[]; beside: Spot[]; top: number } {
  const z = (tx: number, ty: number) => t.zAt(tx * T + 8, ty * T + 8)
  const high: [number, number, number][] = []
  let top = 0
  for (let cy = -r; cy <= r; cy++)
    for (let cx = -r; cx <= r; cx++) {
      const m = t.top(cx, cy)
      top = Math.max(top, m || 0)
      if (!(m >= HIGH)) continue
      for (let ty = cy * S; ty < cy * S + S; ty += 2) for (let tx = cx * S; tx < cx * S + S; tx += 2) if (z(tx, ty) >= HIGH) high.push([tx, ty, z(tx, ty)])
    }
  const out = { south: [] as Spot[], beside: [] as Spot[], top }
  const near = new Set<string>()
  for (const [hx, hy] of high) for (let dy = -40; dy <= 4; dy += 3) for (let dx = -16; dx <= 16; dx += 3) near.add(`${hx + dx},${hy + dy}`)
  const cands = [...near].map((k) => k.split(',').map(Number) as [number, number]).filter(([tx, ty]) => t.walkable(tx, ty) && z(tx, ty) <= 4)
  cands.sort((a, b) => Math.hypot(a[0] - 12, a[1] - 60) - Math.hypot(b[0] - 12, b[1] - 60))
  for (const [tx, ty] of cands) {
    if (out.south.length >= 10 && out.beside.length >= 10) break
    const s = high.find(([hx, hy]) => Math.abs(hx - tx) <= 10 && hy - ty >= 6 && hy - ty <= 36)
    if (s && out.south.length < 10 && !out.south.some((o) => Math.hypot(o.tx - tx, o.ty - ty) < 6)) out.south.push({ tx, ty, high: s })
    const b = high.find(([hx, hy]) => Math.abs(hy - ty) <= 3 && Math.abs(hx - tx) >= 4 && Math.abs(hx - tx) <= 14)
    if (b && out.beside.length < 10 && !out.beside.some((o) => Math.hypot(o.tx - tx, o.ty - ty) < 6)) out.beside.push({ tx, ty, high: b })
  }
  return out
}

/** Warp to the first spot the hero can stand on (the flat Wilds may have a tree there, or it lies past the border). */
async function stand(page: Page, list: Spot[], name: string): Promise<Spot> {
  const tried: string[] = []
  for (const s of list) {
    await warp(page, 'outdoors', s.tx, s.ty)
    await waitForLive(page)
    const p = await player(page)
    if (Math.abs(Math.floor(p.x / T) - s.tx) <= 1 && Math.abs(Math.floor((p.y - 2) / T) - s.ty) <= 1) return s
    tried.push(`${s.tx},${s.ty} → ${Math.floor(p.x / T)},${Math.floor((p.y - 2) / T)}`)
  }
  throw new Error(`no ${name} spot to stand on: ${tried.join(' | ')}`)
}

async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await waitForLive(page)
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
  await page.waitForTimeout(150)
}

test.describe('height terrain: the ¾ lift beside high ground', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('no void beside a high range: full height, compressed, while bakes land, and top-down', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await freshPlayer(page)
    const store = new TerrainStore(() => Promise.reject(new Error('scan only')))
    const done = new Set<string>()
    let found = { south: [] as Spot[], beside: [] as Spot[], top: 0 }
    let r = 0
    for (r of [12, 20, 28]) {
      await scan(page, r, store, done)
      found = spots(store, r)
      if (found.south.length && found.beside.length) break
    }
    const evidence: Record<string, unknown> = { scanned: r, highest: found.top, candidates: found }
    const save = () => writeFileSync(`${OUT}/evidence.json`, JSON.stringify(evidence, null, 1))
    save()
    expect(found.south.length, `a walkable spot with level-${HIGH}+ ground south (highest seen ${found.top})`).toBeGreaterThan(0)
    expect(found.beside.length, `a walkable spot with level-${HIGH}+ ground east or west`).toBeGreaterThan(0)

    await setTerrain(page, { on: true, mode: 'lift', tall: 'full', sunClock: false, sunTime: 0.35, edgeShade: 0.6 })
    const south = await stand(page, found.south, 'south')
    evidence.south = south
    // Right after the warp: the terrain is still arriving and baking. Whatever isn't drawn yet, nothing is empty.
    const pend = await frame(page, 'lift-full-pending', evidence)
    save()
    expect.soft(pend.v.void, `no void right after the warp (${JSON.stringify(pend.v.why)})`).toBeLessThanOrEqual(20)
    let st = await settled(page)
    const full = await frame(page, 'lift-full', evidence)
    save()
    expect.soft(full.v.void, `full height: no void (${JSON.stringify(full.v.why)})`).toBeLessThanOrEqual(20)
    expect(st.need.length, 'the view needs chunks past the 3×3').toBeGreaterThan(0)

    // Compressed: every bake's look changes; placeholders go in first.
    await setTerrain(page, { tall: 'compressed', tallKnee: 4, tallStep: 16 })
    await page.waitForTimeout(120)
    const sw = await frame(page, 'lift-compressed-switch', evidence)
    save()
    expect.soft(sw.v.void, `switching: no void (${JSON.stringify(sw.v.why)})`).toBeLessThanOrEqual(20)
    await settled(page)
    const comp = await frame(page, 'lift-compressed', evidence)
    save()
    expect.soft(comp.v.void, `compressed: no void (${JSON.stringify(comp.v.why)})`).toBeLessThanOrEqual(20)

    // Beside the range: its east or west side in view.
    await setTerrain(page, { tall: 'full' })
    const beside = await stand(page, found.beside, 'beside')
    evidence.beside = beside
    await settled(page)
    const bf = await frame(page, 'lift-full-beside', evidence)
    expect.soft(bf.v.void, `beside, full height: no void (${JSON.stringify(bf.v.why)})`).toBeLessThanOrEqual(20)
    await setTerrain(page, { tall: 'compressed' })
    await settled(page)
    const bc = await frame(page, 'lift-compressed-beside', evidence)
    expect.soft(bc.v.void, `beside, compressed: no void (${JSON.stringify(bc.v.why)})`).toBeLessThanOrEqual(20)
    save()

    // Top-down, at both spots.
    await setTerrain(page, { mode: 'top' })
    await settled(page)
    const tb = await frame(page, 'top-beside', evidence)
    expect.soft(tb.v.void, "top-down beside: no void").toBeLessThanOrEqual(20)
    await stand(page, [south], 'south again')
    await settled(page)
    const ts = await frame(page, 'top-south', evidence)
    expect.soft(ts.v.void, "top-down south: no void").toBeLessThanOrEqual(20)
    save()

    // Budget: a steady walk beside the range in the lift at full height (the widest window).
    await setTerrain(page, { mode: 'lift', tall: 'full' })
    await stand(page, [beside], 'beside again')
    await settled(page)
    await page.evaluate(() => (window as unknown as { __fsTerrainReset: () => void }).__fsTerrainReset())
    for (let i = 0; i < 3; i++) {
      await holdKey(page, 'ArrowRight', 900)
      await holdKey(page, 'ArrowLeft', 900)
    }
    st = (await state(page))!
    const walked = (await probe(page))!
    evidence.budget = { frameMs: st.frameMs, startMs: st.startMs, scheduleMs: st.scheduleMs, passMs: st.passMs, bakeMs: st.bakeMs, quickMs: st.quickMs, bakes: st.bakes, quick: st.quick, images: st.images.length, need: st.need.length, textures: st.textures, bytes: st.bytes, void: walked.void }
    save()
    expect.soft(walked.void, 'after walking: no void').toBeLessThanOrEqual(20)
    expect(st.frameMs.p95, 'terrain CPU p95 per frame (ms)').toBeLessThan(4)
    expect(st.startMs.p95, 'a bake started: no big stall (ms)').toBeLessThan(16)
    expect(st.textures, 'textures only for the baked chunks').toBeLessThanOrEqual(st.images.length + 2)

    await setTerrain(page, { on: false })
    await expect.poll(async () => (await state(page))?.on).toBe(false)
    await page.waitForTimeout(500)
    expect((await state(page))!.textures).toBe(0)
  })
})
