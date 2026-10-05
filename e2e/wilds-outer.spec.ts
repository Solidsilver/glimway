import { expect, test, type Page } from './fixtures'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, waitForWorld } from './connected'
import { beginNewJourney, holdUntil, savedFlags, seedSave, warp, waitForWilds, wilds, type WildsDump } from './helpers'
import { chunkAreaId } from '../src/game/wilds/regions.ts'
import { chunkTerrain, type Epoch } from '../src/lib/wilds/index.ts'
import { siteChunks } from '../src/lib/wilds/outer.ts'
import { echoAssignments } from '../src/lib/wilds/stories.ts'
import { SEASON_SHIFT_NOTICE } from '../src/content/expansion-writing.ts'

/**
 * The outer Wilds (region outer-1, "the Whitequiet"): over the Tangle
 * crossing, an Echo settled, the Turning (the dev calendar moves a guest past
 * the wick's end; a connected claim refused with `epoch-ended`), and a found
 * text the Turning gives back. SCREENS=1 saves images to .agent/screens/.
 */

const OUTER = 'outer-1'

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

const areaNow = (page: Page) => page.evaluate(() => String((window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId))

/** From the Tangle's far side, walk north over the crossing into the outer Wilds. */
async function crossOver(page: Page): Promise<string> {
  await warp(page, chunkAreaId(1, 0), 12, 2)
  await waitForWilds(page)
  await holdUntil(page, 'ArrowUp', async () => (await areaNow(page)).startsWith(`chunk:${OUTER}`))
  return waitForWilds(page, OUTER)
}

/** The guest's outer epoch, as the page has it. */
async function outerEpoch(page: Page): Promise<Epoch> {
  const d = await wilds(page)
  return { worldSeed: 'fingersnap-guest', regionId: OUTER, generatorVersion: 1, season: d.season }
}

/** Read a conversation through to its end. */
async function readThrough(page: Page): Promise<void> {
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  for (let i = 0; i < 12 && (await dialogue.isVisible()); i++) {
    await page.keyboard.press('e')
    await page.waitForTimeout(250)
  }
  await expect(dialogue).toBeHidden()
}

/** Wait out a Turning: it starts (transitioning), then settles at the entrance. */
async function waitTurning(page: Page, from: string): Promise<WildsDump> {
  await page.waitForFunction(() => (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety().transitioning === true, undefined, { timeout: 10_000 })
  await page.waitForFunction(
    (season) => {
      const s = (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety()
      const w = (window as unknown as { __fsWilds: () => { season: string } | null }).__fsWilds()
      return !s.transitioning && !!w && (season === null || w.season !== season)
    },
    from,
    { timeout: 20_000 }
  )
  await page.waitForTimeout(700)
  return wilds(page)
}

test('guest: over the crossing, an Echo settled, the Wilds turn and give a text back', async ({ page }) => {
  test.setTimeout(150_000)
  await beginNewJourney(page)
  // A late-story save: the road is lit (the late finds and the twins' Echoes are due).
  await seedSave(page, ['paper:will-of-elias-fenn'], 'complete')

  // Over the crossing: the Tangle's far side opens onto the Whitequiet's entry.
  await warp(page, chunkAreaId(1, 0), 12, 2)
  await waitForWilds(page)
  await shot(page, '40-outer-crossing-desktop')
  const entry = await crossOver(page)
  expect(entry).toBe(chunkAreaId(1, 1, OUTER))
  let dump = await wilds(page)
  expect(dump.region).toBe(OUTER)
  expect(dump.guest).toBe(true)
  expect(dump.season).toMatch(/^t:\d+:\d+$/)
  expect(dump.entities.length).toBeGreaterThan(0)
  await expect(page.locator('.hud')).toContainText('The Whitequiet')
  await shot(page, '41-outer-entry-desktop')

  // An Echo: walk up to its camp, light the owed lamp, read the moment out.
  const epoch = await outerEpoch(page)
  const sites = siteChunks(epoch)
  const assigned = echoAssignments(epoch, sites, true)
  const echoSite = sites.find((s) => s.kind === 'echo')!
  const def = assigned.get(echoSite.id)!
  const placed = chunkTerrain(epoch, echoSite.cx, echoSite.cy).sites.find((s) => s.id === echoSite.id)!
  await warp(page, chunkAreaId(echoSite.cx, echoSite.cy, OUTER), placed.tx, placed.ty + 1)
  dump = await wilds(page)
  expect(dump.sites.find((s) => s.id === echoSite.id)).toMatchObject({ kind: 'echo', echo: def.member, settled: false })
  await expect(page.locator('.prompt')).toContainText(/owed lamp|Strike the light/)
  await shot(page, '42-outer-echo-desktop')
  await page.keyboard.press('e')
  await shot(page, '43-outer-echo-settling-desktop')
  await readThrough(page)
  await expect.poll(() => savedFlags(page)).toContain(`echo:${def.member}`)
  if (def.paper) await expect.poll(() => savedFlags(page)).toContain(`paper:${def.paper}`)
  expect((await wilds(page)).sites.find((s) => s.id === echoSite.id)!.settled).toBe(true)
  await shot(page, '44-outer-echo-settled-desktop')

  // The Turning: move the calendar to just before the wick's end.
  const before = await wilds(page)
  const end = Number(before.season.split(':')[2])
  await page.evaluate((n) => (window as unknown as { __fsDevCalendar: (n: number) => void }).__fsDevCalendar(n), end - 2)
  await page.waitForFunction(() => (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety().transitioning === true, undefined, { timeout: 10_000 })
  await page.waitForTimeout(1200)
  await shot(page, '45-outer-turning-desktop')
  const after = await waitTurning(page, before.season)
  expect(after.region).toBe(OUTER)
  expect(after.season).toBe(`t:${end}:${end + 7 * 86400}`)
  expect(await areaNow(page)).toBe(chunkAreaId(1, 1, OUTER))
  await expect(page.locator('.toast', { hasText: SEASON_SHIFT_NOTICE }).first()).toBeVisible()
  // Seeing the Turning with the road lit: the weir survey is given back.
  await expect.poll(() => savedFlags(page), { timeout: 10_000 }).toContain('wilds:turned')
  await expect.poll(() => savedFlags(page), { timeout: 10_000 }).toContain('paper:weir-effect-survey-draft')
  await shot(page, '46-outer-turned-desktop')

  // And by the crossing, the deep drift gives back Nan Greer's journal.
  const given = after.sites.find((s) => s.kind === 'given')
  expect(given?.find).toBe('nan-greer-trail-journal')
  await warp(page, chunkAreaId(1, 1, OUTER), given!.tx, given!.ty + 1)
  await expect(page.locator('.prompt')).toContainText('Pick up the bundle')
  await page.keyboard.press('e')
  await expect(page.locator('.toast', { hasText: /Found: .*Nan Greer/ }).first()).toBeVisible()
  await expect.poll(() => savedFlags(page)).toContain('paper:nan-greer-trail-journal')
  await shot(page, '47-outer-given-back-desktop')

  // Home over the crossing: the outer entry's south-west gap leads back to the Tangle.
  await warp(page, chunkAreaId(1, 1, OUTER), 2, 22)
  await holdUntil(page, 'ArrowDown', async () => (await areaNow(page)).startsWith('chunk:inner-1'))
  expect(await waitForWilds(page)).toBe(chunkAreaId(1, 0))
  expect((await wilds(page)).region).toBe('inner-1')

  // Back in Hearthwick, the notice board's old notices, now you've seen a Turning.
  await warp(page, 'village', 15, 10)
  await expect(page.locator('.prompt')).toContainText('Read the notice board')
  await page.waitForTimeout(200)
  await page.keyboard.press('e')
  await expect(page.getByRole('dialog', { name: 'Notice Board' })).toBeVisible()
  await expect.poll(() => savedFlags(page)).toContain('paper:notices-from-the-board')
})

test('guest: a save in the outer Wilds reloads there, and a turned wick brings you to the entrance', async ({ page }) => {
  test.setTimeout(90_000)
  await beginNewJourney(page)
  await crossOver(page)
  // Step off the entrance, let the position save, and reload.
  await warp(page, chunkAreaId(1, 0, OUTER), 12, 21)
  await page.waitForTimeout(2200)
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  expect(await waitForWilds(page, OUTER)).toBe(chunkAreaId(1, 0, OUTER))
  expect((await wilds(page)).region).toBe(OUTER)

  // The save was made in a wick that has since ended: the land you left is
  // gone, so you come to at the region's entrance, told it has turned.
  await page.waitForTimeout(1500)
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('fingersnap')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const store = () => db.transaction('saves', 'readwrite').objectStore('saves')
    const rec = await new Promise<{ state: { outerSeason?: string } }>((resolve) => {
      const req = store().get('current')
      req.onsuccess = () => resolve(req.result)
    })
    rec.state.outerSeason = 't:1:2'
    await new Promise((resolve) => {
      const req = store().put(rec)
      req.onsuccess = resolve
    })
    db.close()
  })
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  expect(await waitForWilds(page, OUTER)).toBe(chunkAreaId(1, 1, OUTER))
  await expect(page.locator('.toast', { hasText: /turned since you were last here/ }).first()).toBeVisible()
  await expect.poll(() => savedFlags(page)).toContain('wilds:turned')
})

test.describe('connected', () => {
  test.use({ server: true })

  test('the server’s outer region: claims, then a refused claim turns the Wilds', async ({ page, context }) => {
    test.setTimeout(150_000)
    const id = newUser()
    allow(id)
    await routeHabitica(context)
    await openTitleGuide(page)
    await pasteAndConnect(page, id)
    await waitForWorld(page)

    await crossOver(page)
    let dump = await wilds(page)
    expect(dump.region).toBe(OUTER)
    expect(dump.guest).toBe(false)
    expect(dump.epochId).not.toBe('')
    expect(dump.endsAt).toBeGreaterThan(Date.now() / 1000)
    expect(dump.season).toMatch(/^t:\d+:\d+$/)

    // A claim against the outer region's epoch: harvest a node in this chunk.
    const node = dump.entities.find((e) => e.kind === 'node' && e.chunk.cx === 1 && e.chunk.cy === 1) ?? dump.entities.find((e) => e.kind === 'node')!
    const others = dump.entities.filter((e) => e.id !== node.id && e.chunk.cx === node.chunk.cx && e.chunk.cy === node.chunk.cy)
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(
      (a, b) =>
        Math.min(...others.map((e) => Math.hypot(e.tx - node.tx - b[0], e.ty - node.ty - b[1])), 99) -
        Math.min(...others.map((e) => Math.hypot(e.tx - node.tx - a[0], e.ty - node.ty - a[1])), 99)
    )
    await warp(page, chunkAreaId(node.chunk.cx, node.chunk.cy, OUTER), node.tx + offsets[0][0], node.ty + offsets[0][1])
    await expect(page.locator('.prompt')).toContainText(/chop|cut|gather|pry/i)
    await page.keyboard.press('e')
    await expect(page.locator('.toast', { hasText: /harvested/i }).first()).toBeVisible()
    dump = await wilds(page)
    expect(dump.entities.find((e) => e.id === node.id)!.state).toBe('harvested')
    await shot(page, '48-outer-connected-harvest-desktop')

    // The wick ends under us: the server refuses the next claim with
    // epoch-ended (simulated here), and the Turning brings us to the entrance.
    await page.route('**/api/wilds/claim', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'epoch-ended' } }) })
    )
    const next = dump.entities.find((e) => e.kind !== 'camp' && e.claimable && e.id !== node.id && e.chunk.cx === node.chunk.cx && e.chunk.cy === node.chunk.cy)
      ?? dump.entities.find((e) => e.kind !== 'camp' && e.claimable && e.id !== node.id)!
    await warp(page, chunkAreaId(next.chunk.cx, next.chunk.cy, OUTER), next.tx + 1, next.ty)
    await expect(page.locator('.prompt')).not.toBeEmpty()
    await page.keyboard.press('e')
    await waitTurning(page, null as unknown as string)
    expect(await areaNow(page)).toBe(chunkAreaId(1, 1, OUTER))
    await expect(page.locator('.toast', { hasText: SEASON_SHIFT_NOTICE }).first()).toBeVisible()
    await page.unroute('**/api/wilds/claim')
    expect((await wilds(page)).guest).toBe(false)
  })
})
