import { anchor } from '../src/lib/location.ts'
import type { FsHooks } from '../src/game/dev-hooks.ts'
import { expect, type Page } from '@playwright/test'

/**
 * Playtest helpers. Movement and interaction go through real keyboard input;
 * the dev hooks are only used to skip long walks (__fsDevWarp), long fights
 * (__fsDevStrike for curated ones, __fsDevFightFall for a generated camp's
 * server room) and the warden encounter (__fsDevSpeakNaming), and the
 * read-only hooks for assertions and for waiting.
 *
 * Wait on game state, never on the clock: under parallel workers a frame
 * can take far longer than usual, so a fixed pause is either too short
 * (flaky) or too long (slow). `settled`, `waitForLive`, `readDialogue` and
 * `holdUntil` cover the usual cases; see docs/testing.md.
 */

type AreaId = 'outdoors' | 'woodland' | 'ruin' | (string & {})
/** An exit of the current area, in tiles. */
export type ExitView = ReturnType<FsHooks['__fsWorld']>['exits'][number]
/**
 * How long a test waits for something that follows a server answer (a toast
 * after an operation, a claim showing in the homes view, the link online).
 * On GitHub's software-rendered smoke runner the first answers of a session
 * take 3–5 s (a sync: ~1 s to open the Menu, ~1.3 s for the outbox's opening
 * mark and report, ~0.5 s for the report barrier, ~0.6 s for the request,
 * ~1 s to show the toast), right at Playwright's 5 s default. Only positive
 * waits use it, so it costs time only when a test fails.
 */
export const SERVER_ANSWER_MS = 15_000

/** Per page and per text: the newest toast an expectToast already matched. */
const toastsMatched = new WeakMap<Page, Map<string, number>>()

/**
 * A toast saying `text` has been shown: on screen now, or shown and faded
 * already (toasts last ~4 s of wall time; a busy test can look too late).
 * Each call matches a newer toast than the last call with the same text, so
 * asserting the same toast twice needs it shown twice. For "after this
 * action" precision, take toastCount before and use toastAfter.
 */
export async function expectToast(page: Page, text: RegExp | string, opts: { timeout?: number } = {}): Promise<string> {
  const key = String(text)
  const seen = toastsMatched.get(page) ?? new Map<string, number>()
  toastsMatched.set(page, seen)
  let hit: { n: number; text: string } | undefined
  await expect
    .poll(
      async () => {
        const t = await page.evaluate(() => window.__fsToasts?.() ?? { count: 0, seen: [] })
        hit = t.seen.find((x) => x.n > (seen.get(key) ?? 0) && (typeof text === 'string' ? x.text.includes(text) : text.test(x.text)))
        return !!hit
      },
      { message: `a toast saying ${text}`, timeout: opts.timeout ?? SERVER_ANSWER_MS }
    )
    .toBe(true)
  seen.set(key, hit!.n)
  return hit!.text
}

/** The area title cards shown so far, in order (dev hook; a card lasts ~2.6 s of wall time). */
async function areaCards(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__fsBanners!().shown.filter((b) => b.kind === 'area').map((b) => b.title)
  )
}

/**
 * The area title card for `title` has been shown and no other card since; one
 * still on screen names it. (Instead of expecting `.area .title` on screen,
 * which a busy test can check after the card has gone.)
 */
export async function expectAreaCard(page: Page, title: string): Promise<void> {
  await expect.poll(async () => (await areaCards(page)).at(-1), { message: `the area card says ${title}` }).toBe(title)
  const cards = await areaCards(page)
  const since = cards.slice(cards.lastIndexOf(title))
  expect(since, 'no other card after it').toEqual(since.map(() => title))
  const onScreen = await page.evaluate(() => document.querySelector('.area .title')?.textContent?.trim() ?? null)
  if (onScreen !== null) expect(onScreen).toBe(title)
}

/** window.__fsToasts(): every toast shown since the page loaded (dev builds). */
/** How many toasts have been shown so far (a mark for toastAfter). */
export async function toastCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__fsToasts?.().count ?? 0)
}

/**
 * The text of the first toast after toast number `since` (matching `text`,
 * when given), even if it has already faded: toasts last ~4 s of wall time,
 * which a busy test can miss.
 */
export async function toastAfter(page: Page, since: number, text?: RegExp | string, timeout?: number): Promise<string> {
  let found = ''
  await expect
    .poll(async () => {
      const t = await page.evaluate(() => window.__fsToasts?.() ?? { count: 0, seen: [] })
      const hit = t.seen.find((x) => x.n > since && (text === undefined || (typeof text === 'string' ? x.text.includes(text) : text.test(x.text))))
      found = hit?.text ?? ''
      return !!hit
    }, { message: `a toast${text ? ` saying ${text}` : ''} after #${since}`, timeout: timeout ?? SERVER_ANSWER_MS })
    .toBe(true)
  return found
}

/** window.__fsFrame(): how settled the current area is (dev builds). */
type FrameView = NonNullable<ReturnType<FsHooks['__fsFrame']>>

/** window.__fsDialogue(): the conversation panel (dev builds). */
export type DialogueView = NonNullable<ReturnType<FsHooks['__fsDialogue']>>

/** Read-only Wilds dump (src/game/wilds/entities.ts, WildsEntities.debug): the open map's attached chunks. */
export type WildsDump = NonNullable<ReturnType<FsHooks['__fsWilds']>>

/** window.__fsWildsWindow(): the open map's window (src/game/wilds/window.ts). */
export type WildsWindowView = NonNullable<ReturnType<FsHooks['__fsWildsWindow']>>

/** An entity's or a site's world tile (chunk-local tile plus its chunk's origin). */
export function worldTileOf(e: { tx: number; ty: number; chunk?: { cx: number; cy: number }; cx?: number; cy?: number }): { tx: number; ty: number } {
  const cx = e.chunk?.cx ?? e.cx ?? 0
  const cy = e.chunk?.cy ?? e.cy ?? 0
  return { tx: cx * 24 + e.tx, ty: cy * 24 + e.ty }
}

/** window.__fsWarden!(): the stone warden in the current area. */
export type WardenView = NonNullable<ReturnType<FsHooks['__fsWarden']>>

/**
 * The area's scene is built and settled: not mid-transition, its fade-in done
 * and a few frames drawn, so held keys and E reach the new scene. (Replaces
 * the old fixed 700 ms pause.) `match` narrows the area id.
 */
export async function settled(page: Page, match: { area?: string; prefix?: string } = {}): Promise<string> {
  const handle = await page.waitForFunction(({ area, prefix }) => {
    const f = window.__fsFrame?.()
    if (!f || f.transitioning || f.fading || f.frames < 3) return null
    const id = String(f.areaId)
    if (area !== undefined && id !== area) return null
    if (prefix !== undefined && !id.startsWith(prefix)) return null
    return id
  }, match)
  return (await handle.jsonValue()) as string
}

export async function waitForArea(page: Page, area: AreaId): Promise<void> {
  // The Commons is fixed ground on the open map (location-seam.md 3): waiting for it is waiting for the open map.
  if (area === 'outdoors' || area === 'hearthwick' || area.startsWith('hearthwick:')) await waitForWilds(page)
  else await settled(page, { area: String(area) })
}

/**
 * The open map is up: the scene settled in `wilds`, the Wilds read, and the
 * hero's chunk attached by the window. Returns the hero's chunk (`cx,cy`).
 */
export async function waitForWilds(page: Page): Promise<string> {
  await settled(page, { area: 'outdoors' })
  const handle = await page.waitForFunction(() => {
    const h = window
    const d = h.__fsWilds?.()
    const w = h.__fsWildsWindow?.()
    if (!d || !w) return null
    const here = `${d.chunk.cx},${d.chunk.cy}`
    if (!d.wickEpoch) return null
    return (w.attached.includes(here) || w.fixed.includes(here)) ? here : null
  })
  return (await handle.jsonValue()) as string
}

/**
 * Readiness, named (review 2026-10-11, game F4). Three separate states a
 * test waits for before it acts, each meaning one thing:
 *
 * - **scene settled** — `settled(page)` / `waitForArea` / `waitForWilds`: the
 *   area's scene is built, its fade done, frames drawn (on the open map, the
 *   hero's chunk attached too);
 * - **target chunk whole** — `chunkWhole(page, tile)`: the open map's chunk
 *   holding that tile is attached *and built whole* (its scenery, gathering
 *   pieces and things registered: no unfinished build). Attaching starts a
 *   sliced build, so a settled scene can still be missing the target's
 *   interaction points; `windowWhole(page)` is the whole 3×3;
 * - **input live** — `waitForLive(page)`: no dialogue or panel, not mid-transition.
 *
 * And the target itself is the game's, never a copy of its rules:
 * `targetAt(page, feet)` asks the scene which point the hero's feet there
 * would get (rank, reach, the tool in hand), `expectTarget` waits for the
 * elected one, `standFor` finds a standing spot that elects it, and
 * `pressOn` presses E on it once all three states hold.
 */

/** window.__fsTarget(): a point the action button can be used on (src/game/entities/interactables.ts). */
export type TargetRead = ReturnType<FsHooks['__fsTarget']>
export type TargetView = NonNullable<TargetRead['target']>

/** The open map's chunk size, in tiles. */
const CHUNK = 24

/** The open map chunk key (`cx,cy`) of a world tile. */
export function chunkKeyOf(at: { tx: number; ty: number }): string {
  return `${Math.floor(at.tx / CHUNK)},${Math.floor(at.ty / CHUNK)}`
}

/**
 * What a stalled step needs said: the hero (position, body, what blocks it),
 * the target and what is in reach, the dev walk's next waypoints, the
 * window's build state and the Wilds epoch (to replay the geometry).
 */
export async function diagnose(page: Page): Promise<string> {
  const d = await page.evaluate(() => {
    const w = window
    const p = w.__fsPlayer?.() ?? null
    const win = w.__fsWildsWindow?.() ?? null
    const wilds = w.__fsWilds?.() ?? null
    const t = w.__fsTarget?.() ?? null
    return {
      area: w.__fsFrame?.()?.areaId ?? null,
      live: w.__fsFrame?.()?.live ?? null,
      hero: p,
      target: t?.target?.id ?? null,
      near: t?.near.map((n) => `${n.id}@${n.d}${n.usable ? '' : '(unusable)'}`) ?? [],
      walk: w.__fsDevWalkLeft?.()?.slice(0, 3) ?? null,
      creatures: (w.__fsEnemies?.() ?? []).filter((e) => e.state !== 'dead').length,
      window: win ? { center: win.center, ready: win.ready, building: win.building, attached: win.attached.length } : null,
      epoch: wilds ? { id: wilds.epochId, season: wilds.season, chunk: wilds.chunk } : null
    }
  }).catch((e: unknown) => ({ error: String(e) }))
  return JSON.stringify(d)
}

/**
 * Target chunk whole: the open map chunk holding world tile `at` is attached
 * and built whole (no unfinished build there). Fails naming the window's state.
 */
export async function chunkWhole(page: Page, at: { tx: number; ty: number }, timeout = 20_000): Promise<void> {
  const key = chunkKeyOf(at)
  await page
    .waitForFunction((k) => {
      const w = window.__fsWildsWindow?.()
      return !!w && w.attached.includes(k) && !w.building.includes(k)
    }, key, { timeout })
    .catch(async () => {
      throw new Error(`chunk ${key} never attached and built whole: ${await diagnose(page)}`)
    })
}

/**
 * The whole window whole: every chunk of the 3×3 around the hero (inside the
 * frontier) attached and built. Centred on the hero's chunk first: a placed
 * hero is recentred on a later frame, and until then `ready` speaks for the
 * old window (review 2026-10-11).
 */
export async function windowWhole(page: Page, timeout = 20_000): Promise<void> {
  await page
    .waitForFunction(
      (chunkPx) => {
        const h = window
        const w = h.__fsWildsWindow?.()
        const p = h.__fsPlayer?.()
        if (!w?.center || !p) return false
        return w.center.cx === Math.floor(p.x / chunkPx) && w.center.cy === Math.floor(p.y / chunkPx) && w.ready === true
      },
      CHUNK * 16,
      { timeout }
    )
    .catch(async () => {
      throw new Error(`the window never came whole: ${await diagnose(page)}`)
    })
}

/** The action button's target now (as this frame chose it), and what is in reach of the hero. */
export async function targetNow(page: Page): Promise<TargetRead> {
  return page.evaluate(() => window.__fsTarget!())
}

/** The target the hero's feet at `at` (world px) would get, by the game's own rule: rank, reach, the tool in hand. */
export async function targetAt(page: Page, at: { x: number; y: number }): Promise<TargetRead> {
  return page.evaluate(([x, y]) => window.__fsTarget!(x, y), [at.x, at.y] as const)
}

/**
 * The game has elected exactly `id` as the target (within `seconds` of game
 * time). Fails naming what it elected instead, what was in reach, and where
 * the hero stood.
 */
export async function expectTarget(page: Page, id: string, seconds = 3): Promise<TargetView> {
  try {
    const t = await waitGame(page, () => targetNow(page), (v) => v.target?.id === id, { seconds, message: `the target is ${id}` })
    return t.target!
  } catch (e) {
    throw new Error(`${String(e).slice(0, 300)}\n${await diagnose(page)}`)
  }
}

/**
 * Open ground around a world tile, as standing spots (feet, world px): the
 * tiles one and two out from it that are not solid, nearest ring first.
 */
export async function spotsAround(page: Page, at: { tx: number; ty: number }): Promise<{ x: number; y: number }[]> {
  return page.evaluate(([x0, y0]) => {
    const solid = window.__fsTileSolid!
    const out: { x: number; y: number }[] = []
    for (const r of [1, 2])
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r && !solid(x0 + dx, y0 + dy)) out.push({ x: (x0 + dx) * 16 + 8, y: (y0 + dy) * 16 + 8 })
    return out
  }, [at.tx, at.ty] as const)
}

/**
 * Stand where the game elects `id`: the first of `spots` (feet, world px)
 * whose target is it, by `targetAt`; the hero is set down there and the
 * election seen to hold. Null (with `why` filled) when none of them works.
 */
export async function standFor(page: Page, id: string, spots: { x: number; y: number }[], why: string[] = []): Promise<{ x: number; y: number } | null> {
  for (const at of spots) {
    const read = await targetAt(page, at)
    if (read.target?.id !== id) {
      why.push(`${at.x},${at.y}→${read.target?.id ?? 'nothing'}`)
      continue
    }
    await page.evaluate(([x, y]) => window.__fsDevPlace!(x, y), [at.x, at.y] as const)
    const ok = await waitGame(page, async () => ({ p: await player(page), t: await targetNow(page) }), (v) => Math.hypot(v.p.x - at.x, v.p.y - at.y) <= 2 && v.t.target?.id === id, { seconds: 1 })
      .then(() => true, () => false)
    if (ok) return at
    why.push(`${at.x},${at.y}: placed, but ${await diagnose(page)}`)
  }
  return null
}

/**
 * Press E on exactly `id`: its chunk whole (on the open map, with `tile`),
 * world input live, and `id` elected; then the press.
 */
export async function pressOn(page: Page, id: string, tile?: { tx: number; ty: number }): Promise<void> {
  if (tile) await chunkWhole(page, tile)
  await waitForLive(page)
  await expectTarget(page, id)
  await page.keyboard.press('e')
}

/** Set the area's creatures aside (frozen, off the map). Creatures of chunks attached later come back: park again after a move. */
export async function parkCreatures(page: Page): Promise<void> {
  await page.evaluate(() => window.__fsDevParkCreatures?.())
}

/** The frame state now (null before the world is up). */
async function frame(page: Page): Promise<FrameView | null> {
  return page.evaluate(() => window.__fsFrame?.() ?? null)
}

/**
 * World input is live: no dialogue or panel, not mid-transition, and past the
 * short grace after a conversation closes (an E inside it is ignored).
 */
export async function waitForLive(page: Page, timeout?: number): Promise<void> {
  await page.waitForFunction(() => window.__fsFrame?.()?.live === true, undefined, { timeout })
}

/**
 * Wait for game behaviour that has a time window ("the slime lunges within
 * two seconds"), measured in game time: a busy machine draws fewer frames per
 * second and the game clock slows with it (each frame advances it at most
 * 50 ms), so a wall-clock timeout would fail a game that is only slow. The
 * window is `seconds` × 60 frames (and at least `seconds` of wall time);
 * `wallCap` bounds it in wall time. Returns the last value read.
 */
export async function waitGame<T>(
  page: Page,
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  opts: { seconds: number; message?: string; wallCap?: number }
): Promise<T> {
  const loop = async () => (await frame(page))?.loop ?? 0
  const start = await loop()
  const t0 = Date.now()
  const cap = opts.wallCap ?? 60_000
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    const late = (await loop()) - start > opts.seconds * 60 && Date.now() - t0 > opts.seconds * 1000
    if (late || Date.now() - t0 > cap) {
      throw new Error(`${opts.message ?? 'condition'}: not met within ${opts.seconds}s of game time (${Date.now() - t0} ms wall); last: ${JSON.stringify(v)}`)
    }
    await frames(page, 1)
  }
}

/**
 * Waits until `read` gives the same value for `n` frames in a row (compared
 * as JSON): "it has stopped", without betting on two samples landing after
 * the last coasting frame. Returns that value. `seconds` is game time, as in
 * waitGame. With `ready`, only ready samples count toward stability.
 */
export async function steady<T>(page: Page, read: () => Promise<T>, opts: { frames: number; seconds: number; message?: string; ready?: (v: T) => boolean }): Promise<T> {
  let last = ''
  let same = 0
  const out = await waitGame(
    page,
    async () => {
      const v = await read()
      const k = JSON.stringify(v)
      same = k === last && (opts.ready?.(v) ?? true) ? same + 1 : 0
      last = k
      return { v, same }
    },
    (s) => s.same >= opts.frames,
    { seconds: opts.seconds, message: opts.message ?? 'a steady value' }
  )
  return out.v
}

/**
 * Like waitGame, but checked inside the page on every frame, so a short-lived
 * state (a slime's wind-up) can't slip between two polls. `predicate` runs
 * in the page (no outer variables; pass them in `arg`) and returns a truthy
 * value when done. `seconds` is game time, as in waitGame.
 */
export async function waitFrames<A, T>(
  page: Page,
  predicate: (arg: A) => T,
  arg: A,
  opts: { seconds: number; message?: string; wallCap?: number }
): Promise<NonNullable<T>> {
  const token = Math.random().toString(36).slice(2)
  const handle = await page.waitForFunction(
    ({ src, arg, seconds, token }) => {
      const w = window
      const waits = (w.__fsWaits ??= {})
      const loop = w.__fsFrame?.()?.loop ?? 0
      const st = (waits[token] ??= { loop, t: performance.now(), f: (0, eval)(`(${src})`) as (a: unknown) => unknown })
      const v = st.f(arg)
      if (v) {
        delete waits[token]
        return { v }
      }
      if (loop - st.loop > seconds * 60 && performance.now() - st.t > seconds * 1000) {
        delete waits[token]
        return { late: true }
      }
      return null
    },
    { src: predicate.toString(), arg, seconds: opts.seconds, token },
    { polling: 'raf', timeout: opts.wallCap ?? 60_000 }
  )
  const out = (await handle.jsonValue()) as { v?: T; late?: boolean }
  if (out.late) throw new Error(`${opts.message ?? 'condition'}: not met within ${opts.seconds}s of game time`)
  return out.v as NonNullable<T>
}

/** Let `n` more frames be drawn (game time, not wall time). */
export async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => new Promise<void>((resolve) => {
    let left = count
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  }), n)
}

/**
 * Every running, finite DOM animation (Svelte transitions, CSS fades) has
 * finished, then two frames are drawn: for a screenshot, instead of a fixed
 * pause. Endless animations (pulses, spinners) are left alone. DOM only:
 * Phaser tweens on the canvas aren't Web Animations, so wait for those
 * through the game's hooks (e.g. `bubbleAlpha` in `__fsRemote()`).
 */
export async function animationsDone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)))
  })
  await frames(page, 2)
}

/** The read-only Wilds dump (null outside the Wilds). */
export async function wilds(page: Page): Promise<WildsDump> {
  const dump = await page.evaluate(() => window.__fsWilds?.() ?? null)
  if (!dump) throw new Error('no Wilds dump — the scene is not the open map')
  return dump
}

/** The open map's window (null outside the Wilds). */
export async function wildsWindow(page: Page): Promise<WildsWindowView | null> {
  return page.evaluate(() => window.__fsWildsWindow?.() ?? null)
}

/**
 * Warp to a tile: the open map's (`outdoors`) are world tiles, signed; every
 * other area's its own. `commons` takes Commons tiles (as content names
 * them) and lands on the open map at the same spot (`commonsTile`).
 */
export async function warp(page: Page, area: AreaId, tx?: number, ty?: number): Promise<void> {
  const named = anchor(area)
  if (named) {
    tx = Math.floor(named.x / 16); ty = Math.floor(named.y / 16); area = named.space
  }
  if (tx === undefined || ty === undefined) throw new Error(`warp needs an anchor or tile: ${area}`)
  await waitForLive(page)
  // The warp starts the transition at once (a refused warp leaves us here).
  await page.evaluate(([a, x, y]) => window.__fsDevWarp!(a, x, y), [area, tx, ty] as const)
  await waitForArea(page, area)
}

/** Is the hero on Hearthwick (the open map, on its footprint: world tiles x -24..47, y 24..119)? */
export async function inCommons(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const s = window.__fsSafety?.()
    if (!s || s.areaId !== 'outdoors' || !s.position) return false
    const tx = Math.floor(s.position.x / 16)
    const ty = Math.floor(s.position.y / 16)
    return tx >= -24 && tx < 48 && ty >= 24 && ty < 120
  })
}

export async function player(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => window.__fsPlayer!())
}

export async function world(page: Page) {
  return page.evaluate(() => window.__fsWorld!())
}

/** The current area's exit into `to` (specs ask rather than assume where it is). */
export async function exitTo(page: Page, to: AreaId): Promise<ExitView> {
  const found = (await world(page)).exits.find((e) => e.to === to)
  if (!found) throw new Error(`no exit to ${to} from ${(await world(page)).areaId}`)
  return found
}

/**
 * Finish a generated camp's fight for this page's account and wait for the
 * server's word that it may claim it. The camp's own room clears it on a
 * `-tags dev` server (__fsDevFightFall, /api/dev/fight-fall): deaths and a
 * stored fall with this account as a witness; then the near read names the
 * camp claimable (campClaimable). The room must be awake and covered by this
 * page's socket, so a `not-here` is asked again until it is. Only a fixture
 * for specs about claims and screens: the shared-fights gate
 * (fights-shared.spec.ts) fights with real swings. Curated fights keep
 * strikeAll.
 */
export async function fallCamp(page: Page, campId: string): Promise<void> {
  const until = Date.now() + SERVER_ANSWER_MS
  let last = ''
  for (;;) {
    const res = await page.evaluate((id) => window.__fsDevFightFall!(id), campId)
    if (res.ok) break
    last = `${res.status} ${res.code}`
    if (res.code !== 'not-here' || Date.now() > until) throw new Error(`the dev fight-fall of ${campId} was refused: ${last}`)
    await page.waitForTimeout(250)
  }
  await expect
    .poll(async () => (await wilds(page)).entities.find((e) => e.id === campId)?.claimable, { message: `${campId} claimable from the near read`, timeout: SERVER_ANSWER_MS })
    .toBe(true)
}

/** Dev strike on every enemy, or only those of one type ('wisp' | 'beetle' | 'guardian'). Local (curated) enemies only: a server camp's room decides its own. */
export async function strikeAll(page: Page, n: number, type?: Parameters<FsHooks['__fsDevStrike']>[1]): Promise<void> {
  await page.evaluate(([d, t]) => window.__fsDevStrike!(d, t), [n, type] as const)
}

export async function warden(page: Page): Promise<WardenView> {
  return page.evaluate(() => window.__fsWarden!())
}

/**
 * Skip the warden encounter: wait for it to wake, then speak the naming
 * (dev lever, ignoring the opening and reach) until it settles.
 */
export async function settleWarden(page: Page): Promise<void> {
  await expect.poll(async () => (await warden(page)).state).toBe('active')
  const needed = (await warden(page)).needed
  for (let i = 0; i < needed; i++) {
    await page.evaluate(() => window.__fsDevSpeakNaming!(true))
  }
  await expect.poll(async () => (await warden(page)).state).toBe('settled')
}

/**
 * Set the hero down `dist` px beside the warden on an open side (in-page, so
 * it lands inside the same frame the warden is read). With `whenOpen`, wait
 * for the warden to stand open after a lunge first.
 */
export async function stepToWarden(page: Page, dist: number, whenOpen: boolean): Promise<void> {
  await page.evaluate(([d, open]) => new Promise<void>((resolve, reject) => {
    const w = window
    const until = performance.now() + 20_000
    const tick = () => {
      const g = w.__fsWarden!()
      if (open ? !g.opening : g.phase !== 'chase') {
        if (performance.now() > until) reject(new Error(`the warden never got there: ${JSON.stringify({ ...g, hero: window.__fsPlayer!() })}`))
        else requestAnimationFrame(tick)
        return
      }
      const { solid, widthPx, heightPx } = w.__fsWorld!()
      const walkable = (x: number, y: number) =>
        x > 12 && x < widthPx - 12 && y > 16 && y < heightPx - 4 && !solid[Math.floor(y / 16)]?.[Math.floor(x / 16)]
      const free = (x: number, y: number) => [[-5, -3], [5, -3], [-5, 0], [5, 0]].every(([ox, oy]) => walkable(x + ox, y + oy))
      // Nothing solid between the warden and the spot, so it can come at you.
      const clear = (x: number, y: number) => {
        for (let t = 0; t <= 1; t += 0.1) if (!walkable(g.x + (x - g.x) * t, g.y - 2 + (y - g.y) * t)) return false
        return true
      }
      // Prefer stepping toward the middle of the map, away from walls.
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]
        .sort((a, b) => Math.hypot(g.x + a[0] * d - widthPx / 2, g.y + a[1] * d - heightPx / 2) - Math.hypot(g.x + b[0] * d - widthPx / 2, g.y + b[1] * d - heightPx / 2))
      for (const [dx, dy] of dirs) {
        const x = g.x + dx * d
        const y = g.y + dy * d
        if (free(x, y) && clear(x, y)) {
          w.__fsDevPlace!(x, y)
          resolve()
          return
        }
      }
      reject(new Error('no open ground beside the warden'))
    }
    tick()
  }), [dist, whenOpen] as const)
}

/**
 * Hold a key for a while (real keydown/keyup, so Phaser sees it held).
 * Prefer holdUntil: how far a fixed hold walks depends on the frame rate.
 */
export async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
}

/**
 * Hold a key until a check passes: walks must survive a loaded machine, where
 * a fixed-duration hold may only cross half a tile. The check runs between
 * frames; the key lifts as soon as it passes. `ms` is game time (see
 * waitGame), so a slow machine is given the frames it needs.
 */
export async function holdUntil(page: Page, key: string, check: () => Promise<boolean>, ms = 25_000): Promise<void> {
  await page.keyboard.down(key)
  try {
    await waitGame(page, check, (v) => v, { seconds: ms / 1000, message: `holdUntil: ${key} never got there`, wallCap: 120_000 })
  } finally {
    await page.keyboard.up(key)
  }
}

/**
 * The lantern road's stage as the server holds it for this browser's session (the
 * journey lives in the world, not on the device). Read the way the client
 * reads it: the contract header, and the parser's projection.
 */
export async function expectStage(page: Page, stage: string): Promise<void> {
  const { parseState } = await import('../src/lib/api/parse.ts')
  const { CONTRACT } = await import('./connected.ts')
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/state', CONTRACT)
      if (!res.ok()) return undefined
      const quests = parseState(await res.json())?.state?.quests
      return quests ? (quests['lantern-road'] ?? 'new') : undefined
    }, { timeout: 10_000, message: `the server's quest stage is ${stage}` })
    .toBe(stage)
}

export async function dialogueState(page: Page): Promise<DialogueView> {
  return page.evaluate(() => window.__fsDialogue!())
}

/**
 * Finish typing the last line before its replies. E would do it too, but if
 * the typing ends on its own just before the key lands, E picks the focused
 * reply instead; a click on the line only ever finishes typing. (Waiting the
 * typing out is no good either: under load a line can take half a minute.)
 */
async function finishLine(page: Page): Promise<void> {
  await page.locator('.dialogue .line').dispatchEvent('click')
}

/**
 * Read the open conversation to its end, one press per change of state: E
 * finishes or advances a line, and replies are picked when they show (`pick`
 * names one; otherwise the first, by its number key). The last line before
 * the replies is finished with a click (see finishLine), not E.
 * Returns once the panel has closed.
 */
export async function readDialogue(page: Page, opts: { pick?: RegExp; picked?: (text: string) => void } = {}): Promise<void> {
  let picked = false
  for (let i = 0; i < 80; i++) {
    const s = await dialogueState(page)
    if (!s.open) return
    const before = JSON.stringify([s.open, s.line, s.lines, s.typing, !!s.choices])
    if (s.choices) {
      const want = !picked && opts.pick ? s.choices.findIndex((c) => opts.pick!.test(c.text)) : 0
      if (want < 0) throw new Error(`no reply matches ${opts.pick}: ${s.choices.map((c) => c.text).join(' | ')}`)
      picked = true
      opts.picked?.(s.choices[want].text)
      await page.keyboard.press(String(want + 1))
    } else if (s.typing && s.pending && s.line + 1 >= s.lines) {
      await finishLine(page)
    } else {
      await page.keyboard.press('e')
    }
    await page
      .waitForFunction((b) => {
        const d = window.__fsDialogue!()
        return JSON.stringify([d.open, d.line, d.lines, d.typing, !!d.choices]) !== b
      }, before, { timeout: 5000 })
      .catch(() => {}) // a press that didn't land is simply pressed again
  }
  throw new Error('the conversation never closed')
}

/** Press E at an interactable once its prompt shows and world input is live; the conversation opens. */
export async function openTalk(page: Page, prompt: RegExp | string): Promise<void> {
  await expect(page.locator('.prompt')).toContainText(prompt)
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(page.getByRole('dialog', { name: /Conversation with/ })).toBeVisible()
}

/**
 * Talk at the prompt and read the conversation through (first replies picked);
 * returns everything said in the conversations it opened.
 */
export async function talkText(page: Page, prompt: RegExp | string): Promise<string> {
  const from = (await dialogueState(page)).opened
  await openTalk(page, prompt)
  await readDialogue(page)
  await expect(page.getByRole('dialog', { name: /Conversation with/ })).toBeHidden()
  const d = await dialogueState(page)
  return d.seen.filter((_, i) => d.opened - d.seen.length + i >= from).map((x) => x.text).join('\n')
}

/**
 * The open conversation's current line (or its speaker) says `text`. Checks
 * the whole line, not the typed-out part: under load the typewriter can take
 * half a minute over one line.
 */
export async function expectLine(page: Page, text: RegExp | string): Promise<void> {
  await expect
    .poll(
      async () => {
        const d = await dialogueState(page)
        return d.open ? `${d.speaker}\n${d.said[d.line] ?? ''}` : null
      },
      { message: `the conversation's line says ${text}` }
    )
    .toMatch(typeof text === 'string' ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : text)
}

/** Press on through the open conversation until the line on screen matches `line`. */
export async function untilLine(page: Page, line: RegExp): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const s = await dialogueState(page)
    if (!s.open) throw new Error(`the conversation closed before a line matching ${line}`)
    if (line.test(s.said[s.line] ?? '')) return
    if (s.choices || (s.typing && s.pending && s.line + 1 >= s.lines)) throw new Error(`replies came before a line matching ${line}`)
    const before = JSON.stringify([s.line, s.typing])
    await page.keyboard.press('e')
    await page
      .waitForFunction((b) => {
        const d = window.__fsDialogue!()
        return !d.open || JSON.stringify([d.line, d.typing]) !== b
      }, before, { timeout: 5000 })
      .catch(() => {})
  }
  throw new Error(`no line matching ${line}`)
}

/** Press on through the open conversation until its replies are on screen. */
export async function untilChoices(page: Page): Promise<NonNullable<DialogueView['choices']>> {
  for (let i = 0; i < 80; i++) {
    const s = await dialogueState(page)
    if (!s.open) throw new Error('the conversation closed without offering replies')
    if (s.choices) return s.choices
    const before = JSON.stringify([s.line, s.typing])
    if (s.typing && s.pending && s.line + 1 >= s.lines) await finishLine(page)
    else await page.keyboard.press('e')
    await page
      .waitForFunction((b) => {
        const d = window.__fsDialogue!()
        return !d.open || !!d.choices || JSON.stringify([d.line, d.typing]) !== b
      }, before, { timeout: 5000 })
      .catch(() => {})
  }
  throw new Error('no replies were offered')
}

/**
 * Press E at an interactable (its prompt must be showing), then read the
 * conversation through: E finishes/advances lines, and the first reply is
 * picked by number key whenever choices appear.
 */
export async function talkThrough(page: Page, prompt: RegExp): Promise<void> {
  await expect(page.locator('.prompt')).toContainText(prompt)
  await waitForLive(page)
  await page.keyboard.press('e')
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  await readDialogue(page)
  await expect(dialogue).toBeHidden()
}
