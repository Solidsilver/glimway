import { expect, test, type Page } from './fixtures'
import { CONTRACT, accountOf, pinWorld, readApiGet, served, serverState, sql, wickSlack } from './connected'
import { waitForWilds, warp } from './helpers'
import { freshPlayer } from './home-helpers'
import { decodeChunk } from '../src/lib/api/chunks.ts'
import { epochKindAt } from '../src/lib/wilds/coords.ts'
import type { WorldChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js'

/**
 * The lamp art on the Lantern Road (docs/art-request-lamps.md): a relit
 * stone draws the open-map pass's relit frames over the dark one, and the
 * Keeper's-hand quest stone (the read's cut_stone) is the route stone, dark
 * until someone lights it.
 */

const S = 24
const LAMP_STONE = 7

/** Every chunk of the frontier with a lamp stone, as the server serves them. */
async function stoneChunks(page: Page): Promise<WorldChunk[]> {
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
      const res = await page.request.get(`/api/wilds/chunk/${encodeURIComponent(epochs.get(epochKindAt(cx, cy))!)}/0/${cx}/${cy}`, { headers: { ...CONTRACT.headers, Accept: 'application/x-protobuf' } })
      expect(res.ok(), `chunk ${cx},${cy}`).toBe(true)
      const c = decodeChunk(new Uint8Array(await res.body()))
      if (c.sites.some((s) => s.kind === LAMP_STONE)) out.push(c)
    }
  return out
}

const stones = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsCommunalLamps: () => { stones: { site: string; frame: string }[] } | null }).__fsCommunalLamps()?.stones ?? [])

test('relit road stones and the quest stone draw their open-map frames', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Wick')
  const now = await wickSlack(page)
  await pinWorld(page, 'lamp-art')
  const world = (await serverState(page)).body.worldId as string
  const read = await served(await readApiGet(page, '/api/communal-lamps'))
  const cut = (read.cutStone ?? read.cut_stone) as string
  expect(cut, 'the world has a quest stone').toMatch(/^lamp-stone:/)

  const chunks = await stoneChunks(page)
  const siteOf = (site: string) => {
    for (const c of chunks) {
      const s = c.sites.find((x) => x.id === site)
      if (s) return { c, s, at: { tx: c.cx * S + s.tx, ty: c.cy * S + s.ty } }
    }
    return null
  }
  const quest = siteOf(cut)
  expect(quest, 'the quest stone lies in the frontier').not.toBeNull()
  // Another stone, two chunks or more away, so its 3×3 doesn't take in the quest stone.
  const other = chunks.flatMap((c) => c.sites.filter((s) => s.kind === LAMP_STONE).map((s) => siteOf(s.id)!)).find((o) => Math.max(Math.abs(o.c.cx - quest!.c.cx), Math.abs(o.c.cy - quest!.c.cy)) >= 2)
  expect(other, 'a second road stone').toBeDefined()

  // Dark: the quest stone is the route stone; a plain dark stone needs no more than its chunk draws.
  await warp(page, 'outdoors', quest!.at.tx, quest!.at.ty + 2)
  await waitForWilds(page)
  await expect.poll(() => stones(page), { timeout: 40_000 }).toContainEqual({ site: cut, frame: 'route-stone-dark' })

  // Both lit (as a relight writes them), then read again on walking into another chunk.
  const lit = (o: NonNullable<ReturnType<typeof siteOf>>) => `('${world}','${o.s.id}','stone',${o.c.cx},${o.c.cy},${o.s.tx},${o.s.ty},'${accountOf(id)}',${now})`
  sql(`INSERT INTO communal_lamps(world_id,id,kind,cx,cy,x,y,setter,lit_at) VALUES ${lit(quest!)}, ${lit(other!)};`)
  try {
    await warp(page, 'outdoors', other!.at.tx, other!.at.ty + 2)
    await waitForWilds(page)
    await expect.poll(() => stones(page), { timeout: 40_000 }).toContainEqual({ site: other!.s.id, frame: 'lamp-stone-relit-0' })

    await warp(page, 'outdoors', quest!.at.tx, quest!.at.ty + 2)
    await waitForWilds(page)
    await expect.poll(() => stones(page), { timeout: 40_000 }).toContainEqual({ site: cut, frame: 'route-stone-relit-0' })
    expect((await stones(page)).filter((s) => s.site === cut)).toHaveLength(1)
  } finally {
    sql(`DELETE FROM communal_lamps WHERE world_id='${world}' AND id IN ('${quest!.s.id}','${other!.s.id}');`)
  }
})
