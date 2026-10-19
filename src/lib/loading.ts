/**
 * Entering the world, as the loading screen tells it (src/ui/LoadingScreen.svelte):
 * which stage a load is in, how far the art stages are, and whether a stage
 * is slow (8 s: a gentle line) or stuck (30 s without moving on, or a
 * failure: Retry and the way back to the title). Every stage change is also
 * timed (./load-timings.ts).
 *
 * Pure: the clock and timers are given, so node tests drive it.
 */
import type { LoadTimings } from './load-timings.ts'

/** The stages, in order. */
export const LOAD_STAGES = ['connect', 'land', 'fetch', 'decode', 'build', 'arrive', 'paint'] as const
export type LoadStage = (typeof LOAD_STAGES)[number]

/** Entering from the title, arriving after a world move, or starting again after a Retry. */
export type LoadKind = 'enter' | 'move' | 'retry'

/** One stage this long: "taking longer than usual". */
export const SLOW_MS = 8_000
/** A stage this long without moving on (or its progress moving): stuck. */
export const STUCK_MS = 30_000

export interface LoadView {
  kind: LoadKind
  stage: LoadStage
  /** 0–1 on the art stages that count (fetch, build); null elsewhere. */
  progress: number | null
  slow: boolean
  stuck: boolean
  failed: boolean
}

export interface LoadClock {
  /** Run `fn` after `ms`; returns its cancel. */
  after(ms: number, fn: () => void): () => void
}

export class Loading {
  private v: LoadView | null = null
  private cancelSlow: (() => void) | null = null
  private cancelStuck: (() => void) | null = null
  private readonly clock: LoadClock
  private readonly changed: (view: LoadView | null) => void
  private readonly timings: LoadTimings | null

  constructor(opts: { clock: LoadClock; changed: (view: LoadView | null) => void; timings?: LoadTimings | null }) {
    this.clock = opts.clock
    this.changed = opts.changed
    this.timings = opts.timings ?? null
  }

  get view(): LoadView | null {
    return this.v
  }

  get active(): boolean {
    return this.v !== null
  }

  /** A load starts at `stage` (a load already running ends as retried or cancelled). */
  begin(kind: LoadKind, stage: LoadStage): void {
    this.timings?.start(kind)
    this.v = { kind, stage, progress: null, slow: false, stuck: false, failed: false }
    this.timings?.stage(stage)
    this.arm(true)
    this.emit()
  }

  /** The load moves on (the same stage again, or none running, does nothing). */
  stage(stage: LoadStage): void {
    const v = this.v
    if (!v || v.stage === stage) return
    this.v = { ...v, stage, progress: null, slow: false, stuck: false, failed: false }
    this.timings?.stage(stage)
    this.arm(true)
    this.emit()
  }

  /** How far this stage is (0–1). Moving on clears "stuck" and restarts its clock. */
  progress(p: number): void {
    const v = this.v
    if (!v) return
    const next = Math.max(0, Math.min(1, p))
    if (v.progress !== null && next <= v.progress) return
    this.v = { ...v, progress: next, stuck: v.failed }
    this.arm(false)
    this.emit()
  }

  /** A fact for the timings (the art density, the art's cache). */
  note(key: string, value: string): void {
    this.timings?.note(key, value)
  }

  /** This stage failed: Retry or back. */
  fail(): void {
    const v = this.v
    if (!v || v.failed) return
    this.disarm()
    this.v = { ...v, failed: true, stuck: true }
    this.timings?.note('failed at', v.stage)
    this.emit()
  }

  /** The world is drawn. */
  done(): void {
    this.end('shown')
  }

  /** The load ends without the world: a Retry starts another, or the title, or a gate took the screen. */
  cancel(outcome: 'retry' | 'title' | 'cancelled' | 'failed' = 'cancelled'): void {
    this.end(outcome)
  }

  private end(outcome: 'shown' | 'retry' | 'title' | 'cancelled' | 'failed'): void {
    if (!this.v) return
    this.disarm()
    this.v = null
    this.timings?.finish(outcome)
    this.emit()
  }

  /** The stuck clock always restarts; the slow one only on a new stage (progress isn't a new stage). */
  private arm(stage: boolean): void {
    if (stage) {
      this.cancelSlow?.()
      this.cancelSlow = this.clock.after(SLOW_MS, () => this.mark({ slow: true }))
    }
    this.cancelStuck?.()
    this.cancelStuck = this.clock.after(STUCK_MS, () => this.mark({ stuck: true, slow: true }))
  }

  private disarm(): void {
    this.cancelSlow?.()
    this.cancelStuck?.()
    this.cancelSlow = this.cancelStuck = null
  }

  private mark(change: Partial<LoadView>): void {
    if (!this.v) return
    this.v = { ...this.v, ...change }
    this.emit()
  }

  private emit(): void {
    this.changed(this.v)
  }
}
