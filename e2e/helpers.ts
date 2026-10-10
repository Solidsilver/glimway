import { expect, type Page } from '@playwright/test'

/**
 * Playtest helpers. Movement and interaction go through real keyboard input;
 * the dev hooks are only used to skip long walks (__fsDevWarp), long fights
 * (__fsDevStrike) and the warden encounter (__fsDevSpeakNaming), and the
 * read-only hooks for assertions and for waiting.
 *
 * Wait on game state, never on the clock: under parallel workers a frame
 * can take far longer than usual, so a fixed pause is either too short
 * (flaky) or too long (slow). `settled`, `waitForLive`, `readDialogue` and
 * `holdUntil` cover the usual cases; see docs/testing.md.
 */

type AreaId = 'village' | 'woodland' | 'ruin' | (string & {})
/** An exit of the current area, in tiles. */
export type ExitView = { tx: number; ty: number; tw: number; th: number; to: string }
type Hooks = {
  __fsPlayer?: () => { x: number; y: number }
  __fsWorld?: () => { areaId: AreaId; widthPx: number; heightPx: number; bounds: { x: number; y: number; w: number; h: number }; exits: ExitView[] }
  __fsSafety?: () => { areaId: AreaId; transitioning: boolean }
  __fsDevWarp?: (area: AreaId, tx: number, ty: number) => void
  __fsDevStrike?: (n: number, type?: string) => void
  __fsDevSpeakNaming?: (force?: boolean) => boolean
  __fsWarden?: () => WardenView
  __fsWilds?: () => WildsDump | null
  __fsFrame?: () => FrameView
  __fsDialogue?: () => DialogueView
  __fsToasts?: () => ToastsView
}

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
        const t = await page.evaluate(() => (window as unknown as Hooks).__fsToasts?.() ?? { count: 0, seen: [] })
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
    (window as unknown as { __fsBanners: () => { shown: { kind: string; title: string }[] } }).__fsBanners().shown.filter((b) => b.kind === 'area').map((b) => b.title)
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
type ToastsView = { count: number; seen: { n: number; text: string; kind: string }[] }

/** How many toasts have been shown so far (a mark for toastAfter). */
export async function toastCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as Hooks).__fsToasts?.().count ?? 0)
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
      const t = await page.evaluate(() => (window as unknown as Hooks).__fsToasts?.() ?? { count: 0, seen: [] })
      const hit = t.seen.find((x) => x.n > since && (text === undefined || (typeof text === 'string' ? x.text.includes(text) : text.test(x.text))))
      found = hit?.text ?? ''
      return !!hit
    }, { message: `a toast${text ? ` saying ${text}` : ''} after #${since}`, timeout: timeout ?? SERVER_ANSWER_MS })
    .toBe(true)
  return found
}

/** window.__fsFrame(): how settled the current area is (dev builds). */
type FrameView = {
  areaId: AreaId
  /** Frames drawn since this area's scene was built. */
  frames: number
  /** Frames drawn since the game started (survives scene restarts). */
  loop: number
  /** The camera fade (in or out) is running. */
  fading: boolean
  transitioning: boolean
  cinematic: boolean
  /** World input (keys, E) would act right now. */
  live: boolean
}

/** window.__fsDialogue(): the conversation panel (dev builds). */
export type DialogueView = {
  open: boolean
  speaker: string
  line: number
  lines: number
  /** Every line of this (or the last) conversation, replies included. */
  said: string[]
  typing: boolean
  /** Replies come after the last line's typing ends. */
  pending: boolean
  /** The replies on screen now (null when none are offered). */
  choices: { text: string; disabled: boolean }[] | null
  /** Conversations opened since the page loaded, and the latest ones' text. */
  opened: number
  seen: { speaker: string; text: string }[]
}

/** Read-only Wilds dump (src/game/wilds/entities.ts, WildsEntities.debug). */
export type WildsDump = {
  epochId: string
  /** `inner-1` (the Tangle) or `outer-1` (the Whitequiet). */
  region: string
  season: string
  endsAt: number | null
  /** Story sites in this chunk: Echo camps and given-back finds. */
  sites: Array<{ id: string; kind: string; tx: number; ty: number; echo: string | null; settled: boolean; find: string | null }>
  chunk: { cx: number; cy: number }
  position: { x: number; y: number }
  entities: Array<{
    id: string
    kind: string
    chunk: { cx: number; cy: number }
    tx: number
    ty: number
    regionPx: { x: number; y: number }
    state: string
    cycle: number
    availableIn: number
    claimable: boolean
    material: string
    tier: number
    poi: string
    enemies: string[]
  }>
  lanterns: Array<{ id: string; ownerId: string; own: boolean; lit: boolean; x: number; y: number }>
  materials: Record<string, number>
  claims: string[]
  discoveries: Array<{ entityId: string; poiId: string; by: string }>
}

/** window.__fsWarden(): the stone warden in the current area. */
export type WardenView = {
  state: 'absent' | 'dormant' | 'active' | 'settled'
  x: number
  y: number
  texture: string
  visible: boolean
  phase: string | null
  opening: boolean
  speakings: number
  needed: number
}

/**
 * The area's scene is built and settled: not mid-transition, its fade-in done
 * and a few frames drawn, so held keys and E reach the new scene. (Replaces
 * the old fixed 700 ms pause.) `match` narrows the area id.
 */
export async function settled(page: Page, match: { area?: string; prefix?: string } = {}): Promise<string> {
  const handle = await page.waitForFunction(({ area, prefix }) => {
    const f = (window as unknown as Hooks).__fsFrame?.()
    if (!f || f.transitioning || f.fading || f.frames < 3) return null
    const id = String(f.areaId)
    if (area !== undefined && id !== area) return null
    if (prefix !== undefined && !id.startsWith(prefix)) return null
    return id
  }, match)
  return (await handle.jsonValue()) as string
}

export async function waitForArea(page: Page, area: AreaId): Promise<void> {
  const wilds = typeof area === 'string' && (area === 'wilds' || area.startsWith('chunk:inner-1'))
  await settled(page, wilds ? { prefix: 'chunk:inner-1' } : { area: String(area) })
}

/** The Wilds chunk scene that is live now (its chunk area id); `region` narrows it. */
export async function waitForWilds(page: Page, region = 'inner-1'): Promise<string> {
  return settled(page, { prefix: `chunk:${region}` })
}

/** The frame state now (null before the world is up). */
async function frame(page: Page): Promise<FrameView | null> {
  return page.evaluate(() => (window as unknown as Hooks).__fsFrame?.() ?? null)
}

/**
 * World input is live: no dialogue or panel, not mid-transition, and past the
 * short grace after a conversation closes (an E inside it is ignored).
 */
export async function waitForLive(page: Page, timeout?: number): Promise<void> {
  await page.waitForFunction(() => (window as unknown as Hooks).__fsFrame?.()?.live === true, undefined, { timeout })
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
 * waitGame.
 */
export async function steady<T>(page: Page, read: () => Promise<T>, opts: { frames: number; seconds: number; message?: string }): Promise<T> {
  let last = ''
  let same = 0
  const out = await waitGame(
    page,
    async () => {
      const v = await read()
      const k = JSON.stringify(v)
      same = k === last ? same + 1 : 0
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
      type Wait = { loop: number; t: number; f: (a: unknown) => unknown }
      const w = window as unknown as { __fsWaits?: Record<string, Wait>; __fsFrame?: () => { loop: number } }
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
  const dump = await page.evaluate(() => (window as unknown as Hooks).__fsWilds?.() ?? null)
  if (!dump) throw new Error('no Wilds dump — the scene is not a Wilds chunk')
  return dump
}

export async function warp(page: Page, area: AreaId, tx: number, ty: number): Promise<void> {
  // The warp starts the transition at once (a refused warp leaves us here).
  await page.evaluate(([a, x, y]) => (window as unknown as Hooks).__fsDevWarp!(a, x, y), [area, tx, ty] as const)
  await waitForArea(page, area)
}

export async function player(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => (window as unknown as Hooks).__fsPlayer!())
}

export async function world(page: Page) {
  return page.evaluate(() => (window as unknown as Hooks).__fsWorld!())
}

/**
 * The current area's exit into `to` (Wilds chunks take their exits from the
 * served chunk, so specs ask rather than assume where a gap is).
 */
export async function exitTo(page: Page, to: AreaId): Promise<ExitView> {
  const found = (await world(page)).exits.find((e) => e.to === to)
  if (!found) throw new Error(`no exit to ${to} from ${(await world(page)).areaId}`)
  return found
}

/** Dev strike on every enemy, or only those of one type ('wisp' | 'beetle' | 'guardian'). */
export async function strikeAll(page: Page, n: number, type?: string): Promise<void> {
  await page.evaluate(([d, t]) => (window as unknown as Hooks).__fsDevStrike!(d as number, t as string | undefined), [n, type] as const)
}

export async function warden(page: Page): Promise<WardenView> {
  return page.evaluate(() => (window as unknown as Hooks).__fsWarden!())
}

/**
 * Skip the warden encounter: wait for it to wake, then speak the naming
 * (dev lever, ignoring the opening and reach) until it settles.
 */
export async function settleWarden(page: Page): Promise<void> {
  await expect.poll(async () => (await warden(page)).state).toBe('active')
  const needed = (await warden(page)).needed
  for (let i = 0; i < needed; i++) {
    await page.evaluate(() => (window as unknown as Hooks).__fsDevSpeakNaming!(true))
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
    type W = {
      __fsWarden: () => { x: number; y: number; opening: boolean; phase: string | null }
      __fsWorld: () => { solid: boolean[][]; widthPx: number; heightPx: number }
      __fsDevPlace: (x: number, y: number) => void
    }
    const w = window as unknown as W
    const until = performance.now() + 20_000
    const tick = () => {
      const g = w.__fsWarden()
      if (open ? !g.opening : g.phase !== 'chase') {
        if (performance.now() > until) reject(new Error(`the warden never got there: ${JSON.stringify({ ...g, hero: (window as unknown as { __fsPlayer: () => unknown }).__fsPlayer() })}`))
        else requestAnimationFrame(tick)
        return
      }
      const { solid, widthPx, heightPx } = w.__fsWorld()
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
          w.__fsDevPlace(x, y)
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
  return page.evaluate(() => (window as unknown as Hooks).__fsDialogue!())
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
        const d = (window as unknown as Hooks).__fsDialogue!()
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
        const d = (window as unknown as Hooks).__fsDialogue!()
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
        const d = (window as unknown as Hooks).__fsDialogue!()
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
