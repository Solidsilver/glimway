/**
 * The state every panel keeps the same way.
 *
 * - `actionRunner()`: one action at a time, which one is running (for its
 *   button's "Making…"), and the line it leaves in the panel head.
 * - `busVersion(bus, …events)`: a counter the bus bumps, for `$derived`s that
 *   read the game's (non-reactive) models: read `.value` in the derived and
 *   it re-runs on each event. Call it while a component initialises; it
 *   listens until the component goes.
 * - `latestRead(load)`: one server view a panel shows, read again on change:
 *   the newest answer wins, and only a failure out of reach is retried.
 */
import type { Bus } from '../game/events'
import type { EventMap, EventName } from '../game/event-names'

export type PanelMessage = { text: string; kind: 'ok' | 'error' }

/** How an action ends: done, or refused with words for the player (a `Result`, an `ActResult`…). */
export type Outcome = { ok: true } | { ok: false; text: string }
type Done<R> = Extract<R, { ok: true }>
type Refused<R> = Extract<R, { ok: false }>

/** The words for a success: a line, a line made from the answer, or null for none. */
export type OkText<R> = string | null | ((done: R) => string | null)

export class ActionRunner {
  /** The running action's id, or null. */
  busy = $state<string | null>(null)
  message = $state<PanelMessage | null>(null)

  /**
   * Run `fn` unless another action is running: the message clears, `busy`
   * holds `id` until it answers, then the message says how it went (a
   * refusal in its own words, or `refused`'s). Gives the answer, or null
   * when it didn't run.
   */
  async run<R extends Outcome>(id: string, fn: () => Promise<R>, ok: OkText<Done<R>>, refused?: (r: Refused<R>) => string): Promise<R | null> {
    if (this.busy) return null
    this.busy = id
    this.message = null
    let r: R
    try {
      r = await fn()
    } finally {
      this.busy = null
    }
    if (r.ok) {
      const text = typeof ok === 'function' ? ok(r as Done<R>) : ok
      if (text !== null) this.message = { text, kind: 'ok' }
    } else {
      const no = r as Refused<R>
      this.message = { text: refused ? refused(no) : no.text, kind: 'error' }
    }
    return r
  }

  say(text: string, kind: PanelMessage['kind'] = 'ok'): void {
    this.message = { text, kind }
  }

  clear(): void {
    this.message = null
  }
}

export function actionRunner(): ActionRunner {
  return new ActionRunner()
}

/** A read's answer: its value, or the code it failed with (a `HomeRead`, a `Result`…). */
export type ReadAnswer<T> = { ok: true; value: T } | { ok: false; code: string }

/**
 * The failures worth asking again: the server out of reach or the link not
 * yet online, or the server failing on its side. A refusal (the homestead
 * is gone, the lot isn't yours) answers the same each time, so it stays.
 */
const RETRY_CODES: ReadonlySet<string> = new Set(['offline', 'network', 'unavailable', 'internal'])

export function retryableRead(code: string): boolean {
  return RETRY_CODES.has(code)
}

export class LatestRead<T> {
  /** What the panel shows: the newest read's, once there is one. */
  value = $state<T | null>(null)
  /** Why nothing is shown yet: the failed read's code, or null while still loading. */
  error = $state<string | null>(null)
  private seq = 0
  private stopped = false
  private readonly load: () => Promise<ReadAnswer<T>>
  private readonly retryMs: number

  constructor(load: () => Promise<ReadAnswer<T>>, retryMs = 500) {
    this.load = load
    this.retryMs = retryMs
  }

  /**
   * Ask again. Several reads may be out at once (an answer's change events
   * each ask): once something is shown only the newest answer replaces it,
   * so an older one landing last can't put back what was taken. Before
   * that any good answer is shown: right after a panel opens its reads
   * queue behind the page's others, and every answer is older than the
   * newest ask (the shelf stall, CI 2026-10-18). A failure out of reach is
   * asked again after `retryMs` while it is still the newest; a refusal isn't.
   */
  read = async (): Promise<void> => {
    if (this.stopped) return
    const mine = ++this.seq
    const r = await this.load()
    if (this.stopped) return
    if (r.ok) {
      if (mine === this.seq || this.value === null) {
        this.value = r.value
        this.error = null
      }
      return
    }
    if (mine !== this.seq) return
    if (this.value === null) this.error = r.code
    if (!retryableRead(r.code)) return
    setTimeout(() => {
      if (mine === this.seq) void this.read()
    }, this.retryMs)
  }

  /** Show a value the panel already has (an action's answer) as the newest: reads already out are older. */
  adopt(value: T): void {
    this.seq++
    this.value = value
    this.error = null
  }

  /** The panel is gone: nothing more is asked or shown. */
  stop(): void {
    this.stopped = true
  }
}

/** The newest read of one server view, for a panel (see `LatestRead`). Call `stop` when the panel goes. */
export function latestRead<T>(load: () => Promise<ReadAnswer<T>>, retryMs?: number): LatestRead<T> {
  return new LatestRead(load, retryMs)
}


/** The bus as a counter needs it: the game's typed bus (src/game/events.ts `bus`). */
export type BusLike = Pick<Bus<EventMap>, 'on' | 'off'>

export function busVersion(bus: BusLike, ...events: EventName[]): { readonly value: number } {
  let value = $state(0)
  $effect(() => {
    const bump = () => {
      value += 1
    }
    for (const e of events) bus.on(e, bump)
    return () => {
      for (const e of events) bus.off(e, bump)
    }
  })
  return {
    get value() {
      return value
    }
  }
}
