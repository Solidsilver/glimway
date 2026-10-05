import { expect, test, type Page } from './fixtures'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, waitForWorld } from './connected'
import { beginNewJourney, hold, warp, waitForWilds, wilds, type WildsDump } from './helpers'
import { chunkAreaId } from '../src/game/wilds/regions.ts'

/**
 * The Tangle (the generated Wilds, region inner-1): chunk-to-chunk walking,
 * claims against the real Go server, position persistence across reloads,
 * and the fallen-hero lantern. Entering is by the dev warp until the Commons
 * exit lands (another worktree builds it).
 */
test.use({ server: true })

const TILE = 16

const chunkOf = (dump: WildsDump) => dump.chunk
const areaOfChunk = (c: { cx: number; cy: number }) => chunkAreaId(c.cx, c.cy)

/** Warp next to an entity (its surroundings are kept clear by the generator). */
async function warpToEntity(page: Page, dump: WildsDump, pick: (d: WildsDump) => WildsDump['entities'][number] | undefined): Promise<WildsDump['entities'][number]> {
  const target = pick(dump)
  if (!target) throw new Error('no such entity in the Tangle')
  await warp(page, areaOfChunk(target.chunk), target.tx + 1, target.ty)
  const after = await wilds(page)
  const found = after.entities.find((e) => e.id === target.id)
  if (!found) throw new Error(`entity ${target.id} vanished after the warp`)
  return found
}

/** Press E at a prompt, then wait for a toast carrying the text. */
async function act(page: Page, prompt: RegExp, toast: RegExp): Promise<void> {
  await expect(page.locator('.prompt')).toContainText(prompt)
  await page.keyboard.press('e')
  await expect(page.locator('.toast', { hasText: toast }).first()).toBeVisible()
}

const materialSum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)

test('guest: the Tangle is explorable with local claims', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'wilds', 2, 22)
  const chunk = await waitForWilds(page)
  expect(chunk).toBe(chunkAreaId(1, 1))

  const dump = await wilds(page)
  expect(dump.guest).toBe(true)
  expect(dump.entities.length).toBeGreaterThan(0)
  expect(dump.epochId).toBe('')

  // Harvest the nearest node; materials appear locally.
  const node = dump.entities.find((e) => e.kind === 'node')
  await warpToEntity(page, dump, () => node)
  await act(page, /harvest|chop|cut|gather|pry/i, /harvested/i)
  const after = await wilds(page)
  expect(materialSum(after.materials)).toBeGreaterThan(0)
  expect(after.entities.find((e) => e.id === node!.id)!.state).toBe('harvested')
})

test('connected: walk chunk to chunk, harvest, clear a camp, chest, POI, reload', async ({ page, context }) => {
  const id = newUser()
  allow(id)
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)

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
  await hold(page, 'ArrowDown', 900)
  const south = await waitForWilds(page)
  expect(south).toBe(chunkAreaId(1, 2))
  dump = await wilds(page)
  expect(dump.chunk).toEqual({ cx: 1, cy: 2 })
  await warp(page, south, 21, 12)
  await hold(page, 'ArrowRight', 900)
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

  // The character panel carries the balance.
  await page.keyboard.press('c')
  const panel = page.locator('.panel')
  await expect(panel.getByText('Materials')).toBeVisible()
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
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [camp.tx * TILE + 8 + 20, camp.ty * TILE + 8])
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
    // Gone for good: no prompt the second time.
    await page.waitForTimeout(300)
    await expect(page.locator('.prompt')).toHaveCount(0)
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
    for (let i = 0; i < 12; i++) {
      if ((await dialogue.textContent())?.includes('Charted by')) break
      await page.keyboard.press('e')
      await page.waitForTimeout(200)
    }
    await expect(dialogue).toContainText(/Charted by/)
    after = await wilds(page)
    expect(after.claims).toContain(poi.id)
    expect(after.discoveries.some((d) => d.entityId === poi.id)).toBe(true)
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
  await page.waitForFunction(() => window.__fsSafety?.()?.areaId === 'village', undefined, { timeout: 20_000 })
  await warp(page, 'wilds', 2, 22)
  await waitForWilds(page)
  await expect.poll(async () => (await wilds(page)).lanterns.some((l) => l.own && !l.lit)).toBe(true)
  const lantern = (await wilds(page)).lanterns.find((l) => l.own)!
  expect(lantern.x).toBe(Math.floor(hurtAt.x / 16))
  expect(lantern.y).toBe(Math.floor(hurtAt.y / 16))
})

test('connected: server persistence keeps the claim across a second visit', async ({ page, context }) => {
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
