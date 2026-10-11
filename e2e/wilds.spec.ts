import { expect, test, type Page } from './fixtures'
import type { BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, waitForWorld } from './connected'
import { holdUntil, warp, waitForWilds, wilds, worldTileOf, type WildsDump, frames, untilLine, expectToast, expectLine } from './helpers'

/**
 * The Tangle on the open map: the Commons gate both ways, claims against the
 * real Go server, position persistence across reloads, and the fallen-hero
 * lantern. Positions are world pixels; the dev warp takes world tiles.
 */

const TILE = 16

/**
 * Warp next to an entity (its surroundings are kept clear by the generator).
 * The tile beside it is chosen so the TARGET is the nearest claimable thing
 * — a second entity one tile over must not win the prompt.
 */
async function warpToEntity(page: Page, dump: WildsDump, pick: (d: WildsDump) => WildsDump['entities'][number] | undefined): Promise<WildsDump['entities'][number]> {
  const target = pick(dump)
  if (!target) throw new Error('no such entity in the attached chunks')
  const at = worldTileOf(target)
  const others = dump.entities.filter((e) => e.id !== target.id && e.claimable).map(worldTileOf)
  const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  const score = ([ox, oy]: number[]) => Math.min(...others.map((e) => Math.hypot(e.tx - at.tx - ox, e.ty - at.ty - oy)), 99)
  const [ox, oy] = candidates.sort((a, b) => score(b) - score(a))[0]
  await warp(page, 'wilds', at.tx + ox, at.ty + oy)
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

/** Sign in on a fresh world; its creatures are set aside so a camp by the gate can't knock the hero about. */
async function connectedWorld(page: Page, context: BrowserContext): Promise<void> {
  const id = newUser()
  allow(id)
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
}

const park = (page: Page) => page.evaluate(() => (window as unknown as { __fsDevParkCreatures?: () => void }).__fsDevParkCreatures?.())

// The exit check and the once-a-second position sample can run in the same
// frame; the sample used to store the Commons spot as a Wilds position
// (about one crossing in 60). Sampling every frame makes the crossing frame
// always sample, so this fails every time without the fix (bugs #2).
test('connected: the Commons arch leads into the Tangle (the gate on chunk 0,0)', async ({ page, context }) => {
  await connectedWorld(page, context)
  await warp(page, 'commons', 23, 2)
  await page.evaluate(() => (window as unknown as { __fsDevSampleEveryFrame: (on: boolean) => void }).__fsDevSampleEveryFrame(true))
  const inWilds = () => page.evaluate(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'wilds')
  await holdUntil(page, 'ArrowUp', inWilds)
  await waitForWilds(page)
  const dump = await wilds(page)
  expect(dump.chunk).toEqual({ cx: 0, cy: 0 })
  // Just inside the gate, world tile (2, 22): the same in every epoch.
  expect(dump.position).toEqual({ x: 2 * TILE + 8, y: 22 * TILE + 8 })
})

test('connected: the Tangle leads back to the Commons arch', async ({ page, context }) => {
  await connectedWorld(page, context)
  await warp(page, 'wilds', 2, 22)
  await waitForWilds(page)
  await park(page)
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
  await warp(page, 'wilds', 12, -12)
  await waitForWilds(page)
  let dump = await wilds(page)
  expect(dump.epochId, 'the server’s epoch').not.toBe('')
  expect(dump.chunks.length).toBe(9)

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
  const campAt = worldTileOf(camp)
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [(campAt.tx + (spot[0] as number)) * TILE + 8, (campAt.ty + (spot[1] as number)) * TILE + 8])
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

  // Reload: the position persists, in world pixels, in the same chunk.
  dump = await wilds(page)
  const beforeChunk = dump.chunk
  const beforePosition = dump.position
  await page.reload()
  await page.getByTestId('continue-world').click()
  await waitForWorld(page, 'wilds')
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
  await warp(page, 'wilds', Math.floor(hurtAt.x / TILE), Math.floor(hurtAt.y / TILE))
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
  await warp(page, 'wilds', 12, -12)
  await waitForWilds(page)
  const dump = await wilds(page)
  const node = dump.entities.find((e) => e.kind === 'node')
  await warpToEntity(page, dump, () => node)
  await act(page, /chop|cut|gather|pry/i, /harvested/i)
  const before = await wilds(page)

  // Reload and come back: the node is still depleted on the server's clock.
  await page.reload()
  await page.getByTestId('continue-world').click()
  await waitForWorld(page, 'wilds' as never)
  await warp(page, 'wilds', worldTileOf(node!).tx + 1, worldTileOf(node!).ty)
  await waitForWilds(page)
  const after = await wilds(page)
  expect(after.entities.find((e) => e.id === node!.id)!.state).toBe('harvested')
  expect(after.claims.length).toBe(before.claims.length)
})
