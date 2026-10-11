import { expect, test, type Page } from './fixtures'
import { CONTRACT } from './connected'
import { waitForWilds, warp, wildsWindow } from './helpers'
import { freshPlayer } from './home-helpers'
import { decodeChunk } from '../src/lib/api/chunks.ts'
import { epochKindAt } from '../src/lib/wilds/coords.ts'
import type { WildsChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js'

/**
 * The open map on screen, from a real world (generator v3 on the Go
 * server): the gate, the Tangle, the seam where the Tangle meets the
 * Whitequiet, meadow, the Wend at a ford, the Lantern Road with a dark lamp
 * stone, a landmark, and the drift at the frontier with the glimpse past it.
 * The whole frontier is read first (near reads and chunk bodies) to find
 * each. SCREENS=1 saves the images to .agent/screens/.
 */

const S = 24

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(600)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

/** Every chunk of the 0.8 frontier, as the server serves them. */
async function frontierChunks(page: Page): Promise<WildsChunk[]> {
  const epochs = new Map<string, string>()
  for (const [cx, cy] of [[-2, -6], [3, -6], [-2, -1], [3, -1]]) {
    const res = await page.request.get(`/api/wilds/near/${cx}/${cy}`, CONTRACT)
    expect(res.ok()).toBe(true)
    const near = (await res.json()) as { still: { id: string }; wick: { id: string } }
    epochs.set('still', near.still.id)
    epochs.set('wick', near.wick.id)
  }
  const out: WildsChunk[] = []
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
const world = (c: WildsChunk, tx: number, ty: number) => ({ tx: c.cx * S + tx, ty: c.cy * S + ty })

/** The first tile of a chunk whose ground is `terrain` (palette name), or null. */
function tileOf(c: WildsChunk, terrain: string): { tx: number; ty: number } | null {
  const k = c.palette.indexOf(terrain)
  if (k < 0) return null
  for (let i = 0; i < S * S; i++) if (((c.ground[i >> 1]! >> (4 * (i & 1))) & 15) === k) return world(c, i % S, Math.floor(i / S))
  return null
}

async function visit(page: Page, at: { tx: number; ty: number }, name: string): Promise<void> {
  await warp(page, 'wilds', at.tx, at.ty)
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

    // The drift: the frontier's west edge, half-way up, with the glimpse past it.
    await visit(page, { tx: -4 * S + 2, ty: -4 * S + 12 }, `77-open-map-drift-${device}`)
    expect((await wildsWindow(page))!.drift.length).toBeGreaterThan(0)
  })
}
