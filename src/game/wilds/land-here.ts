/**
 * The land underfoot, for the HUD's chip (lamps.md 1.1). The window asks
 * each frame, but only a new chunk, a store change (its version) or a land
 * change (the store's landRevision) looks anything up, and the HUD hears of
 * it (EV.landHere) only when the chip's words change.
 *
 * Stepping into a chunk asks for its status (`read`), at most once in
 * ASK_AGAIN_MS per chunk and wick, as the near read is reused. A read that
 * failed is asked again while you stand there, waiting longer each time (up
 * to RETRY_MAX_MS). One of your operations that changed the land makes every
 * answer old: the chunk underfoot is asked again (once any read for it still
 * out has come back), and others as you step in. A new view (a world move,
 * the turning) starts the asking over; leaving the Wilds clears the chip.
 */
import { bus, EV } from '../events.ts'
import { landChip, sameChip, type LandChip } from '../../lib/wilds/land-chip.ts'
import { chunkKey } from './coords.ts'
import type { WildsView } from './store.ts'

export const ASK_AGAIN_MS = 10_000
/** The first wait after a failed read; it doubles with each failure, up to RETRY_MAX_MS. */
export const RETRY_MS = 2_000
export const RETRY_MAX_MS = 30_000

/** One chunk's status read (`cx,cy|wick`). */
interface Ask {
  at: number
  /** Out, not answered yet: no second read for the chunk meanwhile. */
  pending: boolean
  /** Failures in a row, and when to try again after the last. */
  failed: number
  retryAt: number
  /** A land change since it was asked: its answer may be out of date. */
  old: boolean
}

/** The status read: false (or a rejection) when no answer came; nothing when there is nothing to ask. */
export type LandRead = (cx: number, cy: number) => Promise<boolean> | void

export class LandHere {
  private cx = NaN
  private cy = NaN
  private version = -1
  private landRev = 0
  /** The view the asks were made for (undefined: none yet). */
  private view: WildsView | null | undefined = undefined
  private chip: LandChip | null = null
  private asked = new Map<string, Ask>()
  /** Nothing to look up before this time while nothing else changes (0: look on the next frame). */
  private wake = 0
  private readonly read: LandRead
  private readonly now: () => number

  constructor(read: LandRead, now: () => number = Date.now) {
    this.read = read
    this.now = now
  }

  update(cx: number, cy: number, view: WildsView | null, landRev = 0): void {
    const version = view?.version ?? -1
    const stepped = cx !== this.cx || cy !== this.cy
    const now = this.now()
    if (!stepped && version === this.version && view === this.view && landRev === this.landRev && now < this.wake) return
    // Another world's or another wick's view: nothing asked of the old one counts.
    if (view !== this.view) {
      this.view = view
      this.asked.clear()
    }
    if (landRev !== this.landRev) {
      this.landRev = landRev
      for (const a of this.asked.values()) a.old = true
    }
    this.cx = cx
    this.cy = cy
    this.version = version
    this.wake = Infinity
    const key = chunkKey(cx, cy)
    this.show(landChip(view?.land.get(key)))
    if (!view) return
    // The turning starts the land over: a new wick asks afresh.
    const ask = `${key}|${view.wick.id}`
    const a = this.asked.get(ask)
    if (a && !this.due(a, stepped, now)) {
      if (a.failed > 0 && !a.pending) this.wake = a.retryAt
      return
    }
    if (this.asked.size > 64) this.asked.clear()
    const next: Ask = { at: now, pending: true, failed: a?.failed ?? 0, retryAt: 0, old: false }
    this.asked.set(ask, next)
    const r = this.read(cx, cy)
    if (r && typeof r.then === 'function') r.then((ok) => this.answered(next, ok), () => this.answered(next, false))
    else next.pending = false
  }

  /** Ask again now? Not while a read is out; after a land change, once a failure's wait is over, or on stepping back in once the last ask is old. */
  private due(a: Ask, stepped: boolean, now: number): boolean {
    if (a.pending) return false
    if (a.old) return true
    if (a.failed > 0 && now >= a.retryAt) return true
    return stepped && now - a.at >= ASK_AGAIN_MS
  }

  private answered(a: Ask, ok: boolean): void {
    a.pending = false
    if (ok) a.failed = 0
    else {
      a.failed += 1
      a.retryAt = this.now() + Math.min(RETRY_MS * 2 ** (a.failed - 1), RETRY_MAX_MS)
    }
    // Look again next frame: a failure waits its turn, and a land change made while it was out asks now.
    this.wake = 0
  }

  clear(): void {
    this.cx = this.cy = NaN
    this.version = -1
    this.view = undefined
    this.wake = 0
    this.asked.clear()
    this.show(null)
  }

  private show(next: LandChip | null): void {
    if (sameChip(next, this.chip)) return
    this.chip = next
    bus.emit(EV.landHere, { chip: next })
  }
}
