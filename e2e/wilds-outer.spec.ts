import { expect, test, type Page } from './fixtures'
import { moveServerClock, reenter, seedStory, serverState, wickSlack } from './connected'
import { player, warp, waitForWilds, wilds, worldTileOf, type WildsDump, waitForLive, readDialogue, toastAfter, expectToast, parkCreatures, windowWhole } from './helpers'
import { freshPlayer } from './home-helpers'
import { ECHOES } from '../src/content/echoes.ts'
import { SEASON_SHIFT_NOTICE } from '../src/content/expansion-writing.ts'

/**
 * The Whitequiet on the open map (the 3×3 north of the Tangle, cx -1..1,
 * cy -5..-3): an Echo settled, the Turning in place (the world server's
 * clock moved past the wick's end, see moveServerClock: the land changes
 * under you, nobody is sent home), and a found text the Turning gives back.
 * SCREENS=1 saves images to .agent/screens/.
 */

const S = 24
/** The Whitequiet's middle chunk (0, -4): its window holds all nine chunks. */
const MIDDLE = { tx: 12, ty: -4 * S + 12 }

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

/** Into the Whitequiet's middle: its 3×3 is the window. */
async function whitequiet(page: Page): Promise<WildsDump> {
  await warp(page, 'wilds', MIDDLE.tx, MIDDLE.ty)
  await waitForWilds(page)
  const dump = await wilds(page)
  expect(dump.chunk).toEqual({ cx: 0, cy: -4 })
  return dump
}

/** Read a conversation through to its end. */
async function readThrough(page: Page): Promise<void> {
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  await readDialogue(page)
  await expect(dialogue).toBeHidden()
}

/** Wait out a Turning: it starts (the scene holds), then the new wick is in, in place. */
async function waitTurning(page: Page, from: string | null): Promise<WildsDump> {
  await page.waitForFunction(() => (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety().transitioning === true, undefined, { timeout: 10_000 })
  await page.waitForFunction(
    (season) => {
      const s = (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety()
      const w = (window as unknown as { __fsWilds: () => { season: string } | null }).__fsWilds()
      return !s.transitioning && !!w && (season === null || w.season !== season)
    },
    from,
    { timeout: 30_000 }
  )
  await waitForWilds(page)
  return wilds(page)
}

test('in the Whitequiet, an Echo settled, the land turns in place and gives a text back', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page)
  // A late story: the road is lit (the late finds and the twins' Echoes are due).
  await seedStory(id, { quest: 'complete', marks: ['paper:will-of-elias-fenn'] })
  await reenter(page)

  let dump = await whitequiet(page)
  expect(dump.epochId, 'the wick’s epoch').toBe(dump.wickEpoch)
  expect(dump.season).toMatch(/^t:\d+:\d+$/)
  expect(dump.entities.length).toBeGreaterThan(0)
  await expect(page.locator('.hud')).toContainText('The Whitequiet')
  await shot(page, '41-outer-entry-desktop')

  // An Echo: walk up to its camp, light the owed lamp, read the moment out.
  // The world's assignment is the server's (its story rules), read with the
  // Whitequiet in the window.
  const planned = dump.sites.find((st) => st.kind === 'echo' && st.echo && !st.settled)!
  expect(planned).toBeDefined()
  const def = ECHOES.find((e) => e.member === planned.echo)!
  const camp = worldTileOf(planned)
  await warp(page, 'wilds', camp.tx, camp.ty + 1)
  await waitForWilds(page)
  dump = await wilds(page)
  expect(dump.sites.find((st) => st.id === planned.id)).toMatchObject({ kind: 'echo', echo: def.member, settled: false })
  await expect(page.locator('.prompt')).toContainText(/owed lamp|Strike the light/)
  await shot(page, '42-outer-echo-desktop')
  await page.keyboard.press('e')
  await shot(page, '43-outer-echo-settling-desktop')
  await readThrough(page)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain(`echo:${def.member}`)
  if (def.paper) await expect.poll(async () => (await serverState(page)).body.state.flags).toContain(`paper:${def.paper}`)
  // The camp shows settled once the client has taken the server's answer.
  await expect.poll(async () => (await wilds(page)).sites.find((st) => st.id === planned.id)!.settled).toBe(true)
  await shot(page, '44-outer-echo-settled-desktop')

  // The Turning: move the calendar to just before the wick's end.
  const before = await wilds(page)
  const end = Number(before.season.split(':')[2])
  // The world's clock passes the end (the server serves the next wick), and
  // this page's comes up to it a moment later.
  await moveServerClock(page, end + 1)
  await page.evaluate((n) => (window as unknown as { __fsDevCalendar: (n: number) => void }).__fsDevCalendar(n), end - 2)
  await page.waitForFunction(() => (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety().transitioning === true, undefined, { timeout: 10_000 })
  if (process.env.SCREENS) await page.waitForTimeout(1200)
  await shot(page, '45-outer-turning-desktop')
  const standing = await player(page)
  const after = await waitTurning(page, before.season)
  expect(after.season).toBe(`t:${end}:${end + 7 * 86400}`)
  expect(after.wickEpoch).not.toBe(before.wickEpoch)
  // Still here (or on the nearest open tile): never sent home.
  const now = await player(page)
  expect(Math.hypot(now.x - standing.x, now.y - standing.y)).toBeLessThan(10 * 16)
  await toastAfter(page, 0, SEASON_SHIFT_NOTICE)
  // Seeing the Turning with the road lit: the weir survey is given back.
  await expect.poll(async () => (await serverState(page)).body.state.flags, { timeout: 10_000 }).toContain('wilds:turned')
  await expect.poll(async () => (await serverState(page)).body.state.flags, { timeout: 10_000 }).toContain('paper:weir-effect-survey-draft')
  await shot(page, '46-outer-turned-desktop')

  // And by the crossing, the deep drift gives back Nan Greer's journal.
  await whitequiet(page)
  await expect.poll(async () => (await wilds(page)).sites.find((s) => s.kind === 'given')?.find).toBe('nan-greer-trail-journal')
  const given = worldTileOf((await wilds(page)).sites.find((s) => s.kind === 'given')!)
  await warp(page, 'wilds', given.tx, given.ty + 1)
  await waitForWilds(page)
  await expect(page.locator('.prompt')).toContainText('Pick up the bundle')
  await page.keyboard.press('e')
  await expectToast(page, /Found: .*Nan Greer/)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('paper:nan-greer-trail-journal')
  await shot(page, '47-outer-given-back-desktop')

  // Back in Hearthwick, the notice board's old notices, now you've seen a Turning.
  await warp(page, 'village', 15, 10)
  await expect(page.locator('.prompt')).toContainText('Read the notice board')
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(page.getByRole('dialog', { name: 'Notice Board' })).toBeVisible()
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('paper:notices-from-the-board')
})

test('a place in the Whitequiet reloads there, and a turned wick leaves you where you were', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  // A day of this wick ahead (moved past a turning if one is near): a real turning during the
  // reload below would move you to the nearest open tile of the new land. The test turns the wick itself, later.
  await wickSlack(page)
  await whitequiet(page)
  // The place is the server's now: reload, and Continue puts you back there.
  await warp(page, 'wilds', 12, -5 * S + 21)
  await waitForWilds(page)
  // This checks saved places, not combat. Parking protects setup, but a
  // reload makes a fresh scene: stand on open ground away from every camp
  // in the whole surrounding window, so no pre-park knockback races reload.
  await parkCreatures(page)
  await windowWhole(page)
  const camps = (await wilds(page)).entities.filter(e => e.kind === 'camp').map(worldTileOf)
  const quiet = await page.evaluate(camps => {
    const solid = (window as unknown as { __fsTileSolid(tx: number, ty: number): boolean }).__fsTileSolid
    const spots = []
    // Search the loaded Whitequiet, with a 200 px margin inside the window
    // so an unseen camp beyond its edge cannot threaten the chosen place.
    const margin = Math.ceil(200 / 16)
    for (let ty = -5 * 24; ty < -3 * 24 - margin; ty++) for (let tx = -24 + margin; tx < 2 * 24 - margin; tx++) {
      if (solid(tx, ty)) continue
      const gap = Math.min(...camps.map(c => Math.hypot(tx - c.tx, ty - c.ty)))
      spots.push({ tx, ty, gap })
    }
    return spots.sort((a, b) => b.gap - a.gap)[0]
  }, camps)
  expect(quiet, 'open ground away from the camps').toBeDefined()
  expect(quiet.gap, 'the saved place is at least 200 px from every nearby camp').toBeGreaterThanOrEqual(200 / 16)
  await warp(page, 'wilds', quiet.tx, quiet.ty)
  await waitForWilds(page)
  await parkCreatures(page)
  let previous = await player(page)
  let stableSamples = 0
  await expect.poll(async () => {
    const current = await player(page)
    stableSamples = Math.hypot(current.x - previous.x, current.y - previous.y) < 0.5 ? stableSamples + 1 : 0
    previous = current
    return stableSamples >= 3
  }, { timeout: 10_000, intervals: [100], message: 'the hero has settled after entering the Wilds' }).toBe(true)
  const here = await player(page)
  // Confirm this settled place, rather than accepting a report from while the
  // hero was still moving after arrival. The reload below starts from server state.
  let latestSaved: { area: string; position: { x: number; y: number } } | undefined
  try {
    await expect.poll(async () => {
      const st = (await serverState(page)).body.state as { area: string; position: { x: number; y: number } }
      latestSaved = st
      return st.area === 'wilds' && Math.hypot(st.position.x - here.x, st.position.y - here.y) <= 1
    }, { timeout: 20_000 }).toBe(true)
  } catch (error) {
    console.error('saved-position debug', { here, latestSaved })
    throw error
  }
  await page.evaluate(() => (window as unknown as { __fsDevSaveSoon: () => void }).__fsDevSaveSoon())
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsDevSaved: () => { pending: boolean } }).__fsDevSaved().pending)).toBe(false)
  await reenter(page, 'wilds')
  await waitForWilds(page)
  await parkCreatures(page)
  const back = await player(page)
  expect(Math.abs(back.x - here.x), `reload x: ${JSON.stringify({ here, back, latestSaved })}`).toBeLessThanOrEqual(17)
  expect(Math.abs(back.y - here.y), `reload y: ${JSON.stringify({ here, back, latestSaved })}`).toBeLessThanOrEqual(17)

  // The wick ends while you're away: the world's clock moves past it. You
  // come back where you stood (or the nearest open tile), told it has turned.
  const end = Number((await wilds(page)).season.split(':')[2])
  const recordedWick = (await serverState(page)).body.state.wickEpoch
  // Actually leave before the clock moves. Keeping the scene active during
  // reenter's save barrier can witness/report a live Turning before reload.
  await page.goto('/')
  await expect(page.getByTestId('continue-world')).toBeVisible()
  await moveServerClock(page, end + 1)
  expect((await serverState(page)).body.state.wickEpoch, 'the saved place still names the wick visited before leaving').toBe(recordedWick)
  await page.reload()
  await page.getByTestId('continue-world').click()
  await waitForWilds(page)
  await parkCreatures(page)
  const again = await player(page)
  expect(Math.hypot(again.x - here.x, again.y - here.y)).toBeLessThan(10 * 16)
  await expectToast(page, /turned since you were last here/)
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('wilds:turned')
})

test.describe('in a world', () => {
  test('the Whitequiet’s claims, then a refused claim turns the land in place', async ({ page }) => {
    test.setTimeout(150_000)
    await freshPlayer(page)

    let dump = await whitequiet(page)
    expect(dump.epochId, 'the server’s epoch').toBe(dump.wickEpoch)
    expect(dump.endsAt).toBeGreaterThan(Date.now() / 1000)
    expect(dump.season).toMatch(/^t:\d+:\d+$/)

    // A claim against the wick's epoch: harvest a node in the Whitequiet.
    const node = dump.entities.find((e) => e.kind === 'node' && e.chunk.cx === 0 && e.chunk.cy === -4) ?? dump.entities.find((e) => e.kind === 'node')!
    const at = worldTileOf(node)
    const others = dump.entities.filter((e) => e.id !== node.id).map(worldTileOf)
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(
      (a, b) =>
        Math.min(...others.map((e) => Math.hypot(e.tx - at.tx - b[0], e.ty - at.ty - b[1])), 99) -
        Math.min(...others.map((e) => Math.hypot(e.tx - at.tx - a[0], e.ty - at.ty - a[1])), 99)
    )
    await warp(page, 'wilds', at.tx + offsets[0][0], at.ty + offsets[0][1])
    await waitForWilds(page)
    await expect(page.locator('.prompt')).toContainText(/chop|cut|gather|pry/i)
    await page.keyboard.press('e')
    await expectToast(page, /harvested/i)
    dump = await wilds(page)
    expect(dump.entities.find((e) => e.id === node.id)!.state).toBe('harvested')
    await shot(page, '48-outer-connected-harvest-desktop')

    // The wick ends under us: the world's clock passes its end, the server
    // refuses the next claim with epoch-ended, and the land turns in place.
    // Stand at the next claim first (a warp after the clock moves would read
    // the new wick on the way in and say it turned while you were away).
    const next = dump.entities.find((e) => e.kind !== 'camp' && e.claimable && e.id !== node.id && e.chunk.cx === node.chunk.cx && e.chunk.cy === node.chunk.cy)
      ?? dump.entities.find((e) => e.kind !== 'camp' && e.claimable && e.id !== node.id)!
    await warp(page, 'wilds', worldTileOf(next).tx + 1, worldTileOf(next).ty)
    await waitForWilds(page)
    await expect(page.locator('.prompt')).not.toBeEmpty()
    await moveServerClock(page, Number(dump.season.split(':')[2]) + 1)
    await page.keyboard.press('e')
    await waitTurning(page, null)
    expect(await page.evaluate(() => (window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId)).toBe('wilds')
    await expectToast(page, SEASON_SHIFT_NOTICE)
    expect((await wilds(page)).epochId, 'the server’s epoch').toBeTruthy()
  })
})
