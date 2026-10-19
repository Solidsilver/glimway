import type { APIResponse, Request, Route } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { accountOf, moveServerClock, pinWorld, reenter, serverState, sql, wickSlack } from './connected'
import { diagnose, expectToast, parkCreatures, player, settled, waitForArea, waitForWilds, warp, wilds, windowWhole, worldTileOf, type WildsDump } from './helpers'
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
/** Within two tiles of `place`, in its area. */
const near = (at: Partial<Place> | null | undefined, place: Place) => !!at && at.area === place.area && Math.hypot((at.x ?? NaN) - place.x, (at.y ?? NaN) - place.y) < 2 * 16
/** A place report (POST /api/report), as sent. */
const reportOf = (r: Request) => (r.url().endsWith('/api/report') && r.method() === 'POST' ? (r.postDataJSON() as { seq: number; place?: Place }) : null)
/** The client's request timeout (src/lib/api/client.ts): a held read gives up after it. */
const CLIENT_TIMEOUT_MS = 15_000

/**
 * A step that gives up after `seconds` and says where the game stood:
 * arriving and reloading wait on `settled`, which has no timeout of its own,
 * so a stall would otherwise spend the test's whole budget unnamed (CI,
 * 2026-10-19).
 */
async function step<T>(page: Page, title: string, seconds: number, body: () => Promise<T>): Promise<T> {
  try {
    return await test.step(title, body, { timeout: seconds * 1000 })
  } catch (e) {
    const safety = await page.evaluate(() => (window as unknown as Safety).__fsSafety()).catch(() => null)
    const toasts = await page.evaluate(() => window.__fsToasts?.().seen.slice(-4).map((t) => t.text)).catch(() => null)
    throw new Error(`${title}: ${String(e).slice(0, 400)}\nsafety ${JSON.stringify(safety)}\ntoasts ${JSON.stringify(toasts)}\n${await diagnose(page)}`)
  }
}

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
  await windowWhole(page)
  // The world's enemies aim at a hero near their camps, and a way home
  // refuses in a fight: stand on the open ground furthest from every camp
  // in the window (as wilds-outer.spec.ts does).
  const camps = (await wilds(page)).entities.filter((e) => e.kind === 'camp').map(worldTileOf)
  const quiet = await page.evaluate((camps) => {
    const solid = (window as unknown as { __fsTileSolid(tx: number, ty: number): boolean }).__fsTileSolid
    let best: { tx: number; ty: number; gap: number } | null = null
    const margin = Math.ceil(200 / 16)
    for (let ty = -5 * 24 + margin; ty < -3 * 24 - margin; ty++)
      for (let tx = -24 + margin; tx < 2 * 24 - margin; tx++) {
        if (solid(tx, ty)) continue
        const gap = Math.min(Infinity, ...camps.map((c) => Math.hypot(tx - c.tx, ty - c.ty)))
        if (!best || gap > best.gap) best = { tx, ty, gap }
      }
    return best
  }, camps)
  expect(quiet, 'open ground in the Whitequiet').not.toBeNull()
  await warp(page, 'outdoors', quiet!.tx, quiet!.ty)
  await waitForWilds(page)
  await parkCreatures(page)
  const dump = await wilds(page)
  expect(dump.chunk.cy, 'in the Whitequiet').toBeGreaterThanOrEqual(-5)
  expect(dump.chunk.cy, 'in the Whitequiet').toBeLessThanOrEqual(-3)
  return { id, before: dump }
}

/** The fight-quiet a way home waits for after an enemy last aimed at you (api/ways_home.go fightQuiet), with a margin. */
const FIGHT_QUIET_MS = 9_000

/**
 * Use the turncap, and hold its answer until the Turning holds play: the
 * world moves the hero as it is asked (the request reaches it at once), and
 * the page hears of it only once the land is turning. `rewrite` may change
 * the answer the page gets (the place the world chose). The Turning's land
 * read is held too, so play stays held until the page has adopted the
 * destination: a report names it while the hero still stands at the
 * departure point. Then the land comes in. Returns that place.
 */
async function turncapDuringTurning(page: Page, before: WildsDump, rewrite?: (place: Place) => Place): Promise<Place> {
  let route!: Route
  let res!: APIResponse
  for (let attempt = 1; ; attempt++) {
    let asked!: (r: Route) => void
    const held = new Promise<Route>((resolve) => (asked = resolve))
    await page.route('**/api/ways-home', (r) => (r.request().method() === 'POST' ? asked(r) : r.continue()))
    await parkCreatures(page)
    await page.evaluate(() => (window as unknown as { __fsEmit: (e: string, p: unknown) => void }).__fsEmit('game:ways-home', { way: 'turncap' }))
    // The pause (three seconds, standing still) passes, and the way home is
    // asked for. A pause that lets go asks nothing, and says why in a toast.
    route = await step(page, `the turncap is asked for (attempt ${attempt})`, 15, () => held)
    res = await route.fetch()
    const text = res.ok() ? '' : await res.text()
    if (res.ok() || !text.includes('"in-a-fight"') || attempt >= 4) {
      expect(res.ok(), `the world answered the turncap: ${res.status()} ${text}`).toBe(true)
      break
    }
    // An enemy aimed at the hero lately (the server's clock, not the game's): the page hears the refusal, keeps its turncap, and asks again once it is quiet.
    await route.fulfill({ response: res })
    await page.unroute('**/api/ways-home')
    await page.waitForTimeout(FIGHT_QUIET_MS)
  }
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
  // The land read the Turning waits for (src/game/scenes/world-turning.ts): held, play stays held.
  const land: Route[] = []
  let landAsked!: () => void
  const asked = new Promise<void>((resolve) => (landAsked = resolve))
  await page.route('**/api/wilds/near/**', (r) => { land.push(r); landAsked() })
  await Promise.race([asked, new Promise((_, fail) => setTimeout(() => fail(new Error('the Turning never read the new land')), 15_000))])
  const departure = await player(page)
  // The next report names the destination (one goes every 10 s), well before the held read gives up.
  const reported = page.waitForRequest((r) => near(reportOf(r)?.place, place), { timeout: CLIENT_TIMEOUT_MS - 3_000 })
  await route.fulfill({ response: res, json: body })
  await page.unroute('**/api/ways-home')
  await reported
  expect(await transitioning(page), 'the page adopted the destination while the Turning held play').toBe(true)
  const held = await player(page)
  expect(Math.hypot(held.x - departure.x, held.y - departure.y), `the hero is still held at the departure point: ${JSON.stringify({ held, departure })}`).toBeLessThan(2)
  // Let the land in (a read the page gave up on is gone).
  await step(page, 'the held land reads go on', 15, async () => {
    await page.unroute('**/api/wilds/near/**')
    await Promise.all(land.map((r) => r.continue().catch(() => {})))
  })
  return place
}

/** The hero stands at `place` (in its area), and the world's saved place agrees after a report sent since. */
async function landedAt(page: Page, place: Place): Promise<void> {
  await expect.poll(() => transitioning(page), { timeout: 30_000, message: 'the Turning lets go' }).toBe(false)
  await step(page, `the hero arrives in ${place.area}`, 30, () => waitForArea(page, place.area))
  await expect.poll(async () => {
    const at = await player(page)
    return Math.hypot(at.x - place.x, at.y - place.y)
  }, { timeout: 10_000, message: `the hero stands where the world put them: ${JSON.stringify(place)}` }).toBeLessThan(2 * 16)
  // The departure point never goes back over it: a report sent after landing
  // (a later sequence than any before it) names the destination, and the
  // saved place is still the destination once the world has taken it. The
  // operation's own commit can't pass this alone.
  const sent = new Set<Request>()
  const onRequest = (r: Request) => void (reportOf(r) && sent.add(r))
  page.on('request', onRequest)
  const later = await page.waitForResponse((r) => sent.has(r.request()) && r.ok(), { timeout: 25_000 }).finally(() => page.off('request', onRequest))
  const report = reportOf(later.request())!
  expect(near(report.place, place), `report ${report.seq}, sent after landing, names the destination: ${JSON.stringify(report.place)}`).toBe(true)
  await expect.poll(async () => {
    const st = (await serverState(page)).body.state as { area: string; position: { x: number; y: number } }
    return st.area === place.area && Math.hypot(st.position.x - place.x, st.position.y - place.y) < 2 * 16
  }, { timeout: 20_000, message: 'the saved place is the destination' }).toBe(true)
  await step(page, 'a reload in place', 45, async () => {
    await reenter(page, place.area)
    if (place.area === 'outdoors') await waitForWilds(page)
    else await settled(page, { area: place.area })
  })
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
