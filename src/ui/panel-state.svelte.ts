/**
 * The state every panel keeps the same way.
 *
 * - `actionRunner()`: one action at a time, which one is running (for its
 *   button's "Making…"), and the line it leaves in the panel head.
 * - `busVersion(bus, …events)`: a counter the bus bumps, for `$derived`s that
 *   read the game's (non-reactive) models: read `.value` in the derived and
 *   it re-runs on each event. Call it while a component initialises; it
 *   listens until the component goes.
 */
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

/** The bus as a counter needs it (src/game/events.ts `bus`). */
export interface BusLike {
  on(event: string, fn: () => void): unknown
  off(event: string, fn: () => void): unknown
}

export function busVersion(bus: BusLike, ...events: string[]): { readonly value: number } {
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
