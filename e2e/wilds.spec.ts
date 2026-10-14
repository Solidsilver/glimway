import { expect, test, type Page } from './fixtures'
import type { BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, pinWorld, reenter, routeHabitica, sql, waitForWorld } from './connected'
import { chunkWhole, diagnose, fallCamp, holdUntil, parkCreatures, pressOn, spotsAround, standFor, warp, waitForWilds, wilds, windowWhole, worldTileOf, type WildsDump, frames, untilLine, expectToast, expectLine, SERVER_ANSWER_MS } from './helpers'

/**
 * The Tangle on the open map: the Commons gate both ways, claims against the
 * real Go server, position persistence across reloads, and the fallen-hero
 * lantern. Positions are world pixels; the dev warp takes world tiles.
 */

const TILE = 16

/** The feet spots on the open tiles around a world tile (tile centres), the eight neighbours, then two out. */
/** Set the hero down on open ground beside a world tile (no scene change), and wait for the window around it to be whole. */
async function goBeside(page: Page, at: { tx: number; ty: number }): Promise<void> {
  const spot = (await spotsAround(page, at))[0]
  if (!spot) throw new Error(`no open ground beside ${at.tx},${at.ty}: ${await diagnose(page)}`)
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [spot.x, spot.y] as const)
  await windowWhole(page)
}

/**
 * Go to an entity and stand where the game elects exactly its claim: beside
 * it, its chunk whole, the creatures set aside, then a standing spot whose
 * target is `wilds:<id>` (src/game/wilds/sites.ts wildsPoint), by the game's
 * own rule (not a guess at which neighbour is nearer).
 */
async function standAtEntity(page: Page, target: WildsDump['entities'][number] | undefined, what = 'the entity'): Promise<WildsDump['entities'][number]> {
  if (!target) throw new Error(`no ${what} in the attached chunks: ${await diagnose(page)}`)
  const at = worldTileOf(target)
  await goBeside(page, at)
  await chunkWhole(page, at)
  await parkCreatures(page)
  const why: string[] = []
  const stood = await standFor(page, `wilds:${target.id}`, await spotsAround(page, at), why)
  if (!stood) throw new Error(`no spot elects ${what} ${target.id} at ${at.tx},${at.ty}: ${why.join(' ')}`)
  const found = (await wilds(page)).entities.find((e) => e.id === target.id)
  if (!found) throw new Error(`entity ${target.id} vanished after the move: ${await diagnose(page)}`)
  return found
}

/** Press E on exactly this entity's claim (its chunk whole, input live), then wait for a toast carrying the text. */
async function act(page: Page, entity: WildsDump['entities'][number], toast: RegExp): Promise<void> {
  await pressOn(page, `wilds:${entity.id}`, worldTileOf(entity))
  await expectToast(page, toast)
}

const materialSum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)

/** Sign in on a fresh world; its creatures are set aside so a camp by the gate can't knock the hero about. */
async function connectedWorld(page: Page, context: BrowserContext): Promise<void> {
  const id = newUser()
  allow(id)
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
}

// The exit check and the once-a-second position sample can run in the same
// frame; the sample used to store the Commons spot as a Wilds position
// (about one crossing in 60). Sampling every frame makes the crossing frame
// always sample, so this fails every time without the fix (bugs #2).
test('connected: the Commons arch leads into the Tangle (the gate on chunk 0,0)', async ({ page, context }) => {
  await connectedWorld(page, context)
  await warp(page, 'commons', 23, 2)
  await page.evaluate(() => (window as unknown as { __fsDevSampleEveryFrame: (on: boolean) => void }).__fsDevSampleEveryFrame(true))
  const inWilds = () => page.evaluate(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'outdoors')
  await holdUntil(page, 'ArrowUp', inWilds)
  await waitForWilds(page)
  const dump = await wilds(page)
  expect(dump.chunk).toEqual({ cx: 0, cy: 0 })
  // Just inside the gate, world tile (2, 22): the same in every epoch.
  expect(dump.position).toEqual({ x: 2 * TILE + 8, y: 22 * TILE + 8 })
})

test('connected: the Tangle leads back to the Commons arch', async ({ page, context }) => {
  await connectedWorld(page, context)
  await warp(page, 'outdoors', 2, 22)
  await waitForWilds(page)
  await parkCreatures(page)
  expect((await wilds(page)).chunk).toEqual({ cx: 0, cy: 0 })
  // South through the gate (world tiles 1–3 on row 23): the Commons, at the north arch.
  const backInCommons = () =>
    page.evaluate(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'commons')
  await holdUntil(page, 'ArrowDown', backInCommons)
  const hero = await page.evaluate(() => (window as unknown as { __fsPlayer: () => { x: number; y: number } }).__fsPlayer!())
  expect(hero.x).toBe((23 + 0.5) * TILE)
  expect(hero.y).toBe((2 + 0.5) * TILE)
  const dump = await wilds(page).catch(() => null)
  expect(dump).toBeNull() // the Wilds dump is gone with the open map
})

test('connected: harvest, clear a camp, chest, POI, reload in place, the fallen lantern', async ({ page, context }) => {
  await connectedWorld(page, context)
  // In through the gate's tile; the Tangle's middle chunk (0, -1) holds the
  // 3×3 of the Tangle (and the Whitequiet's south row) in its window.
  await warp(page, 'outdoors', 12, -12)
  await waitForWilds(page)
  let dump = await wilds(page)
  expect(dump.epochId, 'the server’s epoch').not.toBe('')
  expect(dump.chunks.length).toBe(9)

  // Harvest a node: loot lands, the balance shows, the node is depleted.
  dump = await wilds(page)
  const node = dump.entities.find((e) => e.kind === 'node')
  await act(page, await standAtEntity(page, node, 'node'), /harvested/i)
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
  await goBeside(page, worldTileOf(camp))
  // The camp's room fights it (a server camp); its fall, with this account as a witness, makes it claimable.
  await fallCamp(page, camp.id)
  // Stand where the camp (not a neighbouring node) owns the prompt.
  await act(page, await standAtEntity(page, camp, 'camp'), /camp is yours/i)
  after = await wilds(page)
  expect(after.entities.find((e) => e.id === camp.id)!.state).toBe('cleared')

  // A chest pays once per player.
  dump = await wilds(page)
  const chest = dump.entities.find((e) => e.kind === 'chest')
  if (chest) {
    await act(page, await standAtEntity(page, chest, 'chest'), /lid groans|amber dust|oilcloth/i)
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
    await standAtEntity(page, poi, 'POI')
    await expect(page.locator('.prompt')).toContainText(/Study the /i)
    await pressOn(page, `wilds:${poi.id}`, worldTileOf(poi))
    const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
    await expect(dialogue).toBeVisible()
    // The text reads one line at a time: step to the "Charted by" line.
    await untilLine(page, /Charted by/)
    await expectLine(page, /Charted by/)
    await expect.poll(async () => (await wilds(page)).claims).toContain(poi.id)
    await expect.poll(async () => (await wilds(page)).discoveries.some((d) => d.entityId === poi.id)).toBe(true)
  }

  // Reload: the position persists, in world pixels, in the same chunk.
  dump = await wilds(page)
  const beforeChunk = dump.chunk
  const beforePosition = dump.position
  // The hero was set down without a scene change: this tab saves the spot, then the world has it.
  await page.evaluate(() => (window as unknown as { __fsDevSaveSoon: () => void }).__fsDevSaveSoon())
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsDevSaved: () => { pending: boolean } }).__fsDevSaved().pending)).toBe(false)
  await reenter(page, 'outdoors')
  await waitForWilds(page)
  const reloaded = await wilds(page)
  expect(reloaded.chunk).toEqual(beforeChunk)
  expect(Math.abs(reloaded.position.x - beforePosition.x)).toBeLessThanOrEqual(17)
  expect(Math.abs(reloaded.position.y - beforePosition.y)).toBeLessThanOrEqual(17)

  // Defeat in the Wilds leaves a lantern (reported before recovery).
  const hurtAt = reloaded.position
  await page.evaluate((n) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(n), 999)
  // Defeat wakes the hero in the village; walk back in and find the lantern.
  await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'village', undefined, { timeout: 20_000 })
  await warp(page, 'outdoors', Math.floor(hurtAt.x / TILE), Math.floor(hurtAt.y / TILE))
  await waitForWilds(page)
  await expect.poll(async () => (await wilds(page)).lanterns.some((l) => l.own && !l.lit)).toBe(true)
  const lantern = (await wilds(page)).lanterns.find((l) => l.own)!
  expect(lantern.x).toBe(Math.floor(hurtAt.x / 16))
  expect(lantern.y).toBe(Math.floor(hurtAt.y / 16))
})

/** The claims spec's world (pinned: the Tangle is still land, the same on every run). */
const CLAIM_SEED = 'e2e-claims'

test('connected: server persistence keeps the claim across a second visit', { tag: '@smoke' }, async ({ page, context }) => {
  await connectedWorld(page, context)
  await pinWorld(page, CLAIM_SEED)
  await warp(page, 'outdoors', 12, -12)
  await windowWhole(page)
  // A fixed node: the pinned Tangle's middle chunk (0, -1), its first node by id.
  const node = (await wilds(page)).entities
    .filter((e) => e.kind === 'node' && e.claimable && e.chunk.cx === 0 && e.chunk.cy === -1)
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0]
  expect(node, `a node in the Tangle's middle chunk (seed ${CLAIM_SEED}): ${await diagnose(page)}`).toBeDefined()
  await act(page, await standAtEntity(page, node, 'node'), /harvested/i)

  // That node, committed: the client's view and the server's own row, before the reload.
  const epoch = (await wilds(page)).stillEpoch
  const committed = () => sql(`SELECT state FROM entity_state WHERE epoch='${epoch}' AND entity_id='${node!.id}';`)
  const stateOf = async () => (await wilds(page)).entities.find((e) => e.id === node!.id)?.state ?? 'not attached'
  await expect.poll(stateOf, { message: `${node!.id} harvested here` }).toBe('harvested')
  await expect.poll(committed, { timeout: SERVER_ANSWER_MS, message: `${node!.id} harvested on the server` }).toBe('harvested')

  // Reload and come back: the node is still depleted on the server's clock.
  await reenter(page, 'outdoors')
  await waitForWilds(page)
  await chunkWhole(page, worldTileOf(node!))
  await expect.poll(stateOf, { timeout: SERVER_ANSWER_MS, message: `${node!.id} still harvested after the reload` }).toBe('harvested')
  expect(committed()).toBe('harvested')
})
