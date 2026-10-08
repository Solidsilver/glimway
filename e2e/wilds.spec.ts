import { expect, test, type Page } from './fixtures'
import type { BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, waitForWorld, serverState, sql, CONTRACT } from './connected'
import { hold, holdUntil, warp, waitForWilds, wilds, type WildsDump, frames, untilLine, expectToast, expectLine } from './helpers'
import { freshPlayer } from './home-helpers'
import { chunkAreaId, wildsArrivalPosition, guestEpoch } from '../src/game/wilds/regions.ts'

/**
 * The Tangle (the generated Wilds, region inner-1): chunk-to-chunk walking,
 * claims against the real Go server, position persistence across reloads,
 * and the fallen-hero lantern. Entering is by the dev warp until the Commons
 * exit lands (another worktree builds it).
 */

const TILE = 16

const chunkOf = (dump: WildsDump) => dump.chunk
const areaOfChunk = (c: { cx: number; cy: number }) => chunkAreaId(c.cx, c.cy)

/**
 * Warp next to an entity (its surroundings are kept clear by the generator).
 * The tile beside it is chosen so the TARGET is the nearest claimable thing
 * — a second entity one tile over must not win the prompt.
 */
async function warpToEntity(page: Page, dump: WildsDump, pick: (d: WildsDump) => WildsDump['entities'][number] | undefined): Promise<WildsDump['entities'][number]> {
  const target = pick(dump)
  if (!target) throw new Error('no such entity in the Tangle')
  const others = dump.entities.filter((e) => e.id !== target.id && e.claimable)
  const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  const score = ([ox, oy]: number[]) =>
    Math.min(...others.filter((e) => e.chunk.cx === target.chunk.cx && e.chunk.cy === target.chunk.cy).map((e) => Math.hypot(e.tx - target.tx - ox, e.ty - target.ty - oy)), 99)
  const [ox, oy] = candidates.sort((a, b) => score(b) - score(a))[0]
  await warp(page, areaOfChunk(target.chunk), target.tx + ox, target.ty + oy)
  const after = await wilds(page)
  const found = after.entities.find((e) => e.id === target.id)
  if (!found) throw new Error(`entity ${target.id} vanished after the warp`)
  return found
}

/** Press E at a prompt, then wait for a toast carrying the text. */
async function act(page: Page, prompt: RegExp, toast: RegExp): Promise<void> {
  await expect(page.locator('.prompt')).toContainText(prompt)
  await page.keyboard.press('e')
  await expectToast(page, toast)
}

const materialSum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)

/**
 * Sign in on a fresh world pinned to the `handoff-tiles` seed (its camps sit
 * far from the entry). This checks handoff coordinates, so keep combat away
 * from the entry: a random camp at (2,20) can knock us south through the
 * return exit while waitForWilds lets the scene settle. Keep random worlds in
 * the exploration/claim tests below; only this traversal fixture is seeded.
 */
async function handoffWorld(page: Page, context: BrowserContext): Promise<void> {
  const id = newUser()
  allow(id)
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
  const worldId = (await serverState(page)).body.worldId as string
  expect(worldId).toMatch(/^[a-f0-9]+$/)
  sql(`UPDATE worlds SET seed='handoff-tiles' WHERE id='${worldId}' AND id NOT IN (SELECT world_id FROM region_epochs);`)
  const region = await page.request.get('/api/wilds/region/inner-1', CONTRACT)
  expect(region.ok()).toBe(true)
  expect((await region.json()).epoch.worldSeed).toBe('handoff-tiles')
}

// The exit check and the once-a-second position sample can run in the same
// frame; the sample used to store the Commons spot as a Tangle position
// (about one crossing in 60). Sampling every frame makes the crossing frame
// always sample, so this fails every time without the fix (bugs #2).
test('connected: the Commons arch leads into the Tangle (handoff tiles)', async ({ page, context }) => {
  await handoffWorld(page, context)
  // North through the Commons arch: the Wilds entry chunk, at the agreed
  // arrival tile ({2,22} — the region-wide position the server expects).
  await warp(page, 'commons', 23, 2)
  await page.evaluate(() => (window as unknown as { __fsDevSampleEveryFrame: (on: boolean) => void }).__fsDevSampleEveryFrame(true))
  const inWilds = () =>
    page.evaluate(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId.startsWith('chunk:inner-1') === true)
  await holdUntil(page, 'ArrowUp', inWilds)
  await waitForWilds(page)
  const dump = await wilds(page)
  expect(dump.chunk).toEqual({ cx: 1, cy: 1 })
  const arrival = wildsArrivalPosition(guestEpoch())
  expect(dump.position.x).toBe(arrival.x)
  expect(dump.position.y).toBe(arrival.y)
})

test('connected: the Tangle leads back to the Commons arch (handoff tiles)', async ({ page, context }) => {
  await handoffWorld(page, context)
  // In at the agreed arrival tile, then back south through the commons gap
  // (tiles 1–3, NOT the chunk gap): the Commons, at the north arch. (2,22)
  // is the gap's inward tile.
  await warp(page, 'wilds', 2, 22)
  await waitForWilds(page)
  expect((await wilds(page)).chunk).toEqual({ cx: 1, cy: 1 })
  await warp(page, chunkAreaId(1, 1), 2, 22)
  const backInCommons = () =>
    page.evaluate(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'commons')
  await holdUntil(page, 'ArrowDown', backInCommons)
  const hero = await page.evaluate(() => (window as unknown as { __fsPlayer: () => { x: number; y: number } }).__fsPlayer!())
  expect(hero.x).toBe((23 + 0.5) * TILE)
  expect(hero.y).toBe((2 + 0.5) * TILE)
  const dump = await wilds(page).catch(() => null)
  expect(dump).toBeNull() // the Wilds dump is gone with the chunk scene
})

test('connected: walk chunk to chunk, harvest, clear a camp, chest, POI, reload', async ({ page, context }) => {
  const id = newUser()
  allow(id)
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
  // A fixed world: in a random one the node, camp, chest and POI can sit
  // where something else owns the prompt (or there may be no POI at all).
  // Its first camp, node and POI have open ground beside them.
  const worldId = (await serverState(page)).body.worldId as string
  sql(`UPDATE worlds SET seed='wilds-screens-0' WHERE id='${worldId}' AND id NOT IN (SELECT world_id FROM region_epochs);`)
  expect((await (await page.request.get('/api/wilds/region/inner-1', CONTRACT)).json()).epoch.worldSeed).toBe('wilds-screens-0')

  // In by the dev warp (the Commons exit is built in parallel).
  await warp(page, 'wilds', 2, 22)
  const entryChunk = await waitForWilds(page)
  expect(entryChunk).toBe(chunkAreaId(1, 1))
  let dump = await wilds(page)
  expect(dump.guest).toBe(false)
  expect(dump.epochId).not.toBe('')

  // Walk chunk to chunk through the real exit gap: south into (1,2), then
  // east into (2,2). Exits sit 3 tiles wide, centered on each edge.
  await warp(page, entryChunk, 12, 21)
  await holdUntil(page, 'ArrowDown', async () => (await wilds(page)).chunk.cx === 1 && (await wilds(page)).chunk.cy === 2)
  const south = await waitForWilds(page)
  expect(south).toBe(chunkAreaId(1, 2))
  dump = await wilds(page)
  expect(dump.chunk).toEqual({ cx: 1, cy: 2 })
  await warp(page, south, 21, 12)
  await holdUntil(page, 'ArrowRight', async () => (await wilds(page)).chunk.cx === 2 && (await wilds(page)).chunk.cy === 2)
  const east = await waitForWilds(page)
  expect(east).toBe(chunkAreaId(2, 2))

  // Harvest a node: loot lands, the balance shows, the node is depleted.
  dump = await wilds(page)
  const node = dump.entities.find((e) => e.kind === 'node')
  await warpToEntity(page, dump, () => node)
  await act(page, /chop|cut|gather|pry/i, /harvested/i)
  let after = await wilds(page)
  expect(materialSum(after.materials)).toBeGreaterThan(0)
  const nodeAfter = after.entities.find((e) => e.id === node!.id)!
  expect(nodeAfter.state).toBe('harvested')
  expect(nodeAfter.claimable).toBe(false)

  // The inventory's Supplies tab carries the balance.
  await page.keyboard.press('i')
  const panel = page.getByRole('dialog', { name: 'Inventory' })
  await panel.getByRole('tab', { name: /Supplies/ }).click()
  const qty = await panel.getByTestId(`material-${node!.material}`).textContent()
  expect(Number(qty)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')

  // Clear a camp and claim it.
  dump = await wilds(page)
  const camp = dump.entities.find((e) => e.kind === 'camp')
  if (!camp) throw new Error('no camp generated in the reached chunks')
  await warpToEntity(page, dump, () => camp)
  // The camp's mix spawns around it; strike everything down.
  await page.evaluate(() => (window as unknown as { __fsDevStrike: (n: number) => void }).__fsDevStrike(999))
  await expect.poll(async () => (await wilds(page)).entities.find((e) => e.id === camp.id)!.claimable).toBe(true)
  // Stand where the camp (not a neighbouring node) owns the prompt.
  const around = await wilds(page)
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([ox, oy]) => [ox, oy, Math.min(...around.entities.filter((e) => e.claimable && e.id !== camp.id && e.chunk.cx === camp.chunk.cx && e.chunk.cy === camp.chunk.cy).map((e) => Math.hypot(e.tx - camp.tx - ox, e.ty - camp.ty - oy)), 99)])
    .sort((a, b) => (b[2] as number) - (a[2] as number))[0]
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [(camp.tx + (spot[0] as number)) * TILE + 8, (camp.ty + (spot[1] as number)) * TILE + 8])
  await act(page, /Claim the camp/i, /camp is yours/i)
  after = await wilds(page)
  expect(after.entities.find((e) => e.id === camp.id)!.state).toBe('cleared')

  // A chest pays once per player.
  dump = await wilds(page)
  const chest = dump.entities.find((e) => e.kind === 'chest')
  if (chest) {
    await warpToEntity(page, dump, () => chest)
    await act(page, /Open the chest/i, /lid groans|amber dust|oilcloth/i)
    after = await wilds(page)
    expect(after.claims).toContain(chest.id)
    // Gone for good: no chest prompt the second time (a gathering spot
    // nearby may offer its own).
    await frames(page, 20)
    expect(await page.locator('.prompt').allTextContents()).not.toContainEqual(expect.stringMatching(/Open the chest/i))
  }

  // A POI discovery: the text, and who charted it first.
  dump = await wilds(page)
  const poi = dump.entities.find((e) => e.kind === 'poi')
  if (poi) {
    await warpToEntity(page, dump, () => poi)
    await expect(page.locator('.prompt')).toContainText(/Study the /i)
    await page.keyboard.press('e')
    const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
    await expect(dialogue).toBeVisible()
    // The text reads one line at a time: step to the "Charted by" line.
    await untilLine(page, /Charted by/)
    await expectLine(page, /Charted by/)
    await expect.poll(async () => (await wilds(page)).claims).toContain(poi.id)
    await expect.poll(async () => (await wilds(page)).discoveries.some((d) => d.entityId === poi.id)).toBe(true)
  }

  // Reload: the position persists, region-wide, in the right chunk.
  dump = await wilds(page)
  const beforeChunk = areaOfChunk(chunkOf(dump))
  const beforePosition = dump.position
  await page.reload()
  await page.getByTestId('continue-world').click()
  await waitForWorld(page, 'wilds')
  const reloadedChunk = await waitForWilds(page)
  expect(reloadedChunk).toBe(beforeChunk)
  const reloaded = await wilds(page)
  expect(Math.abs(reloaded.position.x - beforePosition.x)).toBeLessThanOrEqual(17)
  expect(Math.abs(reloaded.position.y - beforePosition.y)).toBeLessThanOrEqual(17)

  // Defeat in the Wilds leaves a lantern (reported before recovery).
  const hurtAt = reloaded.position
  await page.evaluate((n) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(n), 999)
  // Defeat wakes the hero in the village; walk back in and find the lantern.
  await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'village', undefined, { timeout: 20_000 })
  await warp(page, 'wilds', 2, 22)
  await waitForWilds(page)
  await expect.poll(async () => (await wilds(page)).lanterns.some((l) => l.own && !l.lit)).toBe(true)
  const lantern = (await wilds(page)).lanterns.find((l) => l.own)!
  expect(lantern.x).toBe(Math.floor(hurtAt.x / 16))
  expect(lantern.y).toBe(Math.floor(hurtAt.y / 16))
})

test('connected: server persistence keeps the claim across a second visit', { tag: '@smoke' }, async ({ page, context }) => {
  const id = newUser()
  allow(id)
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
  await warp(page, 'wilds', 2, 22)
  await waitForWilds(page)
  let dump = await wilds(page)
  const node = dump.entities.find((e) => e.kind === 'node')
  await warpToEntity(page, dump, () => node)
  await act(page, /chop|cut|gather|pry/i, /harvested/i)
  const before = await wilds(page)

  // Reload and come back: the node is still depleted on the server's clock.
  await page.reload()
  await page.getByTestId('continue-world').click()
  await waitForWorld(page, 'wilds' as never)
  await warp(page, areaOfChunk(node!.chunk), node!.tx + 1, node!.ty)
  await waitForWilds(page)
  const after = await wilds(page)
  expect(after.entities.find((e) => e.id === node!.id)!.state).toBe('harvested')
  expect(after.claims.length).toBe(before.claims.length)
})
