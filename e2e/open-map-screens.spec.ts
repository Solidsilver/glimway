import { expect, test, type Page } from './fixtures'
import { CONTRACT, pinWorld } from './connected'
import { waitForWilds, warp, wildsWindow } from './helpers'
import { freshPlayer } from './home-helpers'
import { decodeChunk } from '../src/lib/api/chunks.ts'
import { epochKindAt } from '../src/lib/wilds/coords.ts'
import type { WorldChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js'

/**
 * The open map on screen, from a real world (generator v3 on the Go
 * server): the gate, the Tangle, the seam where the Tangle meets the
 * Whitequiet, meadow, the Wend at a ford, the Lantern Road with a dark lamp
 * stone, a landmark, and the drift at the frontier with the glimpse past it.
 * The whole frontier is read first (near reads and chunk bodies) to find
 * each. SCREENS=1 saves the images to .agent/screens/.
 */

const S = 24

/** SHOTS names a set of screenshots (before/after a change); the default is the open map's own. */
const SET = process.env.SHOTS ?? 'open-map'

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(600)
  await page.screenshot({ path: `.agent/screens/${name.replace('open-map', SET)}.png` })
}

/**
 * One fixed world for the screens, so a change can be seen before and
 * after on the same land (pinWorld, e2e/connected.ts). The Beyond still
 * follows the week's wick.
 */
const pinScreensWorld = (page: Page) => pinWorld(page, 'open-map-screens')

/** Every chunk of the 0.8 frontier, as the server serves them. */
async function frontierChunks(page: Page): Promise<WorldChunk[]> {
  const epochs = new Map<string, string>()
  for (const [cx, cy] of [[-2, -6], [3, -6], [-2, -1], [3, -1]]) {
    const res = await page.request.get(`/api/wilds/near/${cx}/${cy}`, CONTRACT)
    expect(res.ok()).toBe(true)
    const near = (await res.json()) as { still: { id: string }; wick: { id: string } }
    epochs.set('still', near.still.id)
    epochs.set('wick', near.wick.id)
  }
  const out: WorldChunk[] = []
  for (let cy = -8; cy <= 0; cy++)
    for (let cx = -4; cx <= 4; cx++) {
      const epoch = epochs.get(epochKindAt(cx, cy))!
      const res = await page.request.get(`/api/wilds/chunk/${encodeURIComponent(epoch)}/0/${cx}/${cy}`, { headers: { ...CONTRACT.headers, Accept: 'application/x-protobuf' } })
      expect(res.ok(), `chunk ${cx},${cy}`).toBe(true)
      out.push(decodeChunk(new Uint8Array(await res.body())))
    }
  return out
}

/** The world tile of a chunk-local tile. */
const world = (c: WorldChunk, tx: number, ty: number) => ({ tx: c.cx * S + tx, ty: c.cy * S + ty })

/** The first tile of a chunk whose ground is `terrain` (palette name), or null. */
function tileOf(c: WorldChunk, terrain: string): { tx: number; ty: number } | null {
  const k = c.palette.indexOf(terrain)
  if (k < 0) return null
  for (let i = 0; i < S * S; i++) if (((c.ground[i >> 1]! >> (4 * (i & 1))) & 15) === k) return world(c, i % S, Math.floor(i / S))
  return null
}

async function visit(page: Page, at: { tx: number; ty: number }, name: string): Promise<void> {
  await warp(page, 'outdoors', at.tx, at.ty)
  await waitForWilds(page)
  // The ring's landmarks and the drift come a few frames after the 3×3.
  await expect.poll(async () => (await wildsWindow(page))?.far.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0)
  await shot(page, name)
}

for (const [device, vp] of [['desktop', { width: 1200, height: 760 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`open map screens (${device})`, async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize(vp)
    await freshPlayer(page)
    await pinScreensWorld(page)
    const chunks = await frontierChunks(page)
    expect(chunks.length).toBe(81)

    await visit(page, { tx: 2, ty: 22 }, `70-open-map-gate-${device}`)
    await visit(page, { tx: 12, ty: -12 }, `71-open-map-tangle-${device}`)
    // The crossing: the Tangle's north edge at chunk (0, -2) meets the Whitequiet.
    await visit(page, { tx: 12, ty: -2 * S + 1 }, `72-open-map-seam-${device}`)

    const meadow = chunks.find((c) => c.land === 'meadow' && tileOf(c, 'grass_c'))
    expect(meadow, 'some meadow in the frontier').toBeDefined()
    await visit(page, tileOf(meadow!, 'grass_c')!, `73-open-map-meadow-${device}`)

    const ford = chunks.find((c) => tileOf(c, 'water_b'))
    expect(ford, 'a ford over the Wend').toBeDefined()
    const fordAt = tileOf(ford!, 'water_b')!
    await visit(page, { tx: fordAt.tx, ty: fordAt.ty }, `74-open-map-ford-${device}`)

    const road = chunks.find((c) => c.sites.some((s) => s.kind === 7))
    expect(road, 'the Lantern Road with a dark lamp stone').toBeDefined()
    const lamp = road!.sites.find((s) => s.kind === 7)!
    await visit(page, world(road!, lamp.tx, lamp.ty + 2), `75-open-map-lamp-stone-${device}`)

    const placed = chunks.find((c) => c.places.length > 0)
    expect(placed, 'a place with its landmark').toBeDefined()
    const mark = placed!.places[0]!
    await visit(page, world(placed!, mark.tx, mark.ty + 3), `76-open-map-landmark-${device}`)

    // A trodden path through meadow, and the Lantern Road's edge into the grass.
    const trodden = chunks.find((c) => c.land === 'meadow' && tileOf(c, 'dirt'))
    if (trodden) await visit(page, tileOf(trodden, 'dirt')!, `78-open-map-trodden-${device}`)
    const paved = chunks.filter((c) => tileOf(c, 'cobble'))
    const edge = paved.map((c) => tileOf(c, 'sand') ?? tileOf(c, 'cobble')).find(Boolean)
    if (edge) await visit(page, edge, `79-open-map-road-edge-${device}`)

    // Where woods meets meadow across a chunk edge (no box edges along it): an
    // east-west pair and a north-south pair of chunks of different lands.
    const byKey = new Map(chunks.map((c) => [`${c.cx},${c.cy}`, c]))
    const meadowShare = (c: WorldChunk) => {
      const k = c.palette.indexOf('grass_c')
      if (k < 0) return 0
      let n = 0
      for (let i = 0; i < S * S; i++) if (((c.ground[i >> 1]! >> (4 * (i & 1))) & 15) === k) n++
      return n / (S * S)
    }
    const differ = (a: WorldChunk, b: WorldChunk) => Math.abs(meadowShare(a) - meadowShare(b)) > 0.25
    const ew = chunks.find((c) => byKey.get(`${c.cx + 1},${c.cy}`) && differ(c, byKey.get(`${c.cx + 1},${c.cy}`)!))
    if (ew) await visit(page, { tx: (ew.cx + 1) * S, ty: ew.cy * S + S / 2 }, `80-open-map-border-ew-${device}`)
    const ns = chunks.find((c) => byKey.get(`${c.cx},${c.cy + 1}`) && differ(c, byKey.get(`${c.cx},${c.cy + 1}`)!))
    if (ns) await visit(page, { tx: ns.cx * S + S / 2, ty: (ns.cy + 1) * S }, `81-open-map-border-ns-${device}`)

    // A frozen pond (a point of interest), where this world has one.
    const pond = chunks.find((c) => c.entities.some((e) => e.kind === 'poi' && e.poi === 'frozen-pond'))
    if (pond) {
      const e = pond.entities.find((x) => x.poi === 'frozen-pond')!
      await visit(page, world(pond, e.tx, e.ty + 2), `69-open-map-pond-${device}`)
    }

    // The drift: the frontier's west edge, half-way up, with the glimpse past it.
    await visit(page, { tx: -4 * S + 2, ty: -4 * S + 12 }, `77-open-map-drift-${device}`)
    expect((await wildsWindow(page))!.drift.length).toBeGreaterThan(0)
  })
}

test('walking the Lantern Road across chunk edges keeps the frames steady', async ({ page }) => {
  test.setTimeout(180_000)
  await freshPlayer(page)
  await pinScreensWorld(page)
  const chunks = await frontierChunks(page)
  // The road's paving tiles, in world tiles; walk from its southernmost to the farthest along it.
  const paving = new Set<string>()
  for (const c of chunks) {
    const k = c.palette.indexOf('cobble')
    if (k < 0) continue
    for (let i = 0; i < S * S; i++) if (((c.ground[i >> 1]! >> (4 * (i & 1))) & 15) === k) paving.add(`${c.cx * S + (i % S)},${c.cy * S + Math.floor(i / S)}`)
  }
  expect(paving.size).toBeGreaterThan(50)
  // The road's longest stretch (its paving, joined eight ways), from its south end.
  const N8 = [[0, -1], [1, 0], [-1, 0], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]]
  const unseen = new Set(paving)
  let stretch: [number, number][] = []
  for (const k of paving) {
    if (!unseen.has(k)) continue
    unseen.delete(k)
    const piece: [number, number][] = []
    const stack = [k.split(',').map(Number) as [number, number]]
    while (stack.length) {
      const [x, y] = stack.pop()!
      piece.push([x, y])
      for (const [dx, dy] of N8) if (unseen.delete(`${x + dx!},${y + dy!}`)) stack.push([x + dx!, y + dy!])
    }
    if (piece.length > stretch.length) stretch = piece
  }
  const start = stretch.sort((a, b) => b[1] - a[1])[0]!
  // Breadth first along the paving to the farthest tile, then walk it.
  const from = new Map<string, string | null>([[start.join(','), null]])
  const queue = [start]
  let last = start
  while (queue.length) {
    const [x, y] = queue.shift()!
    last = [x, y]
    // The road steps diagonally where it bends: eight ways.
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]]) {
      const k = `${x + dx},${y + dy}`
      if (paving.has(k) && !from.has(k)) {
        from.set(k, `${x},${y}`)
        queue.push([x + dx, y + dy])
      }
    }
  }
  const path: { x: number; y: number }[] = []
  for (let k: string | null = last.join(','); k; k = from.get(k) ?? null) {
    const [x, y] = k.split(',').map(Number)
    path.unshift({ x: x! * 16 + 8, y: y! * 16 + 12 })
  }
  await warp(page, 'outdoors', start[0], start[1])
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
  const timing = page.evaluate(() => (window as unknown as { __fsDevFrameTimes: (ms: number) => Promise<{ gap: { p50: number; p95: number } }> }).__fsDevFrameTimes(6000))
  await page.evaluate((p) => (window as unknown as { __fsDevWalk: (p: { x: number; y: number }[]) => void }).__fsDevWalk(p), path.slice(0, 120))
  const gap = (await timing).gap
  console.log('road walk', JSON.stringify({ tiles: path.length, gap }))
  expect(gap.p95, 'no long frames on the road').toBeLessThan(120)
})
