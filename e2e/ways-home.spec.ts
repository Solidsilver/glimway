import type { Route } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { accountOf, moveServerClock, pinWorld, reenter, serverState, sql, wickSlack } from './connected'
import { expectToast, parkCreatures, player, settled, waitForArea, waitForWilds, warp, wilds, type WildsDump } from './helpers'
import { freshPlayer, fund } from './home-helpers'
import { WAYS_HOME_LINES } from '../src/lib/ways-home.ts'

/**
 * Ways home (lamps.md 1.4) against a Turning (step-back 2026-10-18, G1, A2):
 * a way home already asked for when the land turns is answered while the
 * Turning holds play. The scene keeps that relocation and takes it as the
 * veil lifts (src/game/scenes/travel-hold.ts), so the hero lands where the
 * world put them, and no position sample writes the departure point back
 * over it. Before the fix the hold dropped the answer, and the hero stayed
 * in the Beyond while the save said town.
 */

const S = 24
const SEED = 'e2e-ways-home'
/** The Whitequiet's middle (chunk 0, -4): land that turns, so the Turning holds play behind its veil. */
const WHITEQUIET = { tx: 12, ty: -4 * S + 12 }
/** A room the second case's relocation names (library.spec.ts stands here). */
const LIBRARY = { area: 'in:village:library', x: 5 * 16 + 8, y: 2 * 16 + 8 }

type Place = { area: string; x: number; y: number }
type Safety = { __fsSafety: () => { transitioning: boolean; areaId: string } }

const transitioning = (page: Page) => page.evaluate(() => (window as unknown as Safety).__fsSafety().transitioning)

/** Into the Whitequiet with a turncap in the pack, the world's clock a day from the wick's end. */
async function inTheBeyond(page: Page): Promise<{ id: string; before: WildsDump }> {
  const id = await freshPlayer(page, 'Wren')
  await wickSlack(page)
  await pinWorld(page, SEED)
  fund(id, { items: { 'homing-turncap': 1 } })
  await reenter(page)
  await warp(page, 'outdoors', WHITEQUIET.tx, WHITEQUIET.ty)
  await waitForWilds(page)
  await parkCreatures(page)
  const dump = await wilds(page)
  expect(dump.chunk, 'in the Whitequiet').toEqual({ cx: 0, cy: -4 })
  return { id, before: dump }
}

/**
 * Use the turncap, and hold its answer until the Turning holds play: the
 * world moves the hero as it is asked (the request reaches it at once), and
 * the page hears of it only once the land is turning. `rewrite` may change
 * the answer the page gets (the place the world chose). Returns that place.
 */
async function turncapDuringTurning(page: Page, before: WildsDump, rewrite?: (place: Place) => Place): Promise<Place> {
  let asked!: (r: Route) => void
  const held = new Promise<Route>((resolve) => (asked = resolve))
  await page.route('**/api/ways-home', (route) => (route.request().method() === 'POST' ? asked(route) : route.continue()))
  await page.evaluate(() => (window as unknown as { __fsEmit: (e: string, p: unknown) => void }).__fsEmit('game:ways-home', { way: 'turncap' }))
  // The pause (three seconds, standing still) passes, and the way home is asked for.
  const route = await held
  const res = await route.fetch()
  expect(res.ok(), `the world answered the turncap: ${res.status()}`).toBe(true)
  const body = await res.json()
  const chose = { area: body.state.place.area, x: body.state.place.x, y: body.state.place.y } as Place
  expect(chose.area).toBe('outdoors')
  const place = rewrite ? rewrite(chose) : chose
  if (rewrite) {
    // Every place the answer names, as the world now holds it.
    const swap = (o: unknown): void => {
      if (!o || typeof o !== 'object') return
      const v = o as Record<string, unknown>
      if (v.area === chose.area && v.x === chose.x && v.y === chose.y) Object.assign(v, place)
      for (const k of Object.keys(v)) swap(v[k])
    }
    swap(body)
  }

  // The Turning: the world's clock past the wick's end, and this page's up to it a moment later.
  const end = Number(before.season.split(':')[2])
  await moveServerClock(page, end + 1)
  await page.evaluate((n) => (window as unknown as { __fsDevCalendar: (n: number) => void }).__fsDevCalendar(n), end - 2)
  await page.waitForFunction(() => (window as unknown as Safety).__fsSafety().transitioning === true, undefined, { timeout: 15_000 })
  await route.fulfill({ response: res, json: body })
  await page.unroute('**/api/ways-home')
  // The veil is up for about two seconds of game time and the land loads after it: the answer lands inside the hold.
  expect(await transitioning(page), 'the answer landed while the Turning held play').toBe(true)
  return place
}

/** The hero stands at `place` (in its area), and the world's saved place agrees after the reports since. */
async function landedAt(page: Page, place: Place): Promise<void> {
  await expect.poll(() => transitioning(page), { timeout: 30_000, message: 'the Turning lets go' }).toBe(false)
  await waitForArea(page, place.area)
  await expect.poll(async () => {
    const at = await player(page)
    return Math.hypot(at.x - place.x, at.y - place.y)
  }, { timeout: 10_000, message: `the hero stands where the world put them: ${JSON.stringify(place)}` }).toBeLessThan(2 * 16)
  // The departure point never goes back over it: the saved place stays the destination through the next report.
  await expect.poll(async () => {
    const st = (await serverState(page)).body.state as { area: string; position: { x: number; y: number } }
    return st.area === place.area && Math.hypot(st.position.x - place.x, st.position.y - place.y) < 2 * 16
  }, { timeout: 20_000, message: 'the saved place is the destination' }).toBe(true)
  await reenter(page, place.area)
  if (place.area === 'outdoors') await waitForWilds(page)
  else await settled(page, { area: place.area })
  const back = await player(page)
  expect(Math.hypot(back.x - place.x, back.y - place.y), `after a reload: ${JSON.stringify({ back, place })}`).toBeLessThan(2 * 16)
}

test('a turncap answered while a Turning holds play lands at the north arch once the veil lifts', async ({ page }) => {
  test.setTimeout(150_000)
  const { before } = await inTheBeyond(page)
  const arch = await turncapDuringTurning(page, before)
  await expectToast(page, WAYS_HOME_LINES.arrived.turncap)
  await landedAt(page, arch)
})

test('a relocation into another area, answered while a Turning holds play, is taken once the veil lifts', async ({ page }) => {
  // No way home names another area yet (both land on the open map), so the
  // answer is rewritten to the library, and the world's place with it: the
  // scene must leave for that area as the hold lets go.
  test.setTimeout(150_000)
  const { id, before } = await inTheBeyond(page)
  const library = await turncapDuringTurning(page, before, () => {
    sql(`UPDATE player_place SET area='${LIBRARY.area}',x=${LIBRARY.x},y=${LIBRARY.y} WHERE account_id='${accountOf(id)}';`)
    return LIBRARY
  })
  await landedAt(page, library)
})
