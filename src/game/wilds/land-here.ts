/**
 * The land underfoot, for the HUD's chip (lamps.md 1.1). The window asks
 * each frame, but only a new chunk or a store change (its version) looks
 * anything up, and the HUD hears of it (EV.landHere) only when the chip's
 * words change. Stepping into a chunk asks for its status (`read`), at most
 * once in ASK_AGAIN_MS per chunk and wick, as the near read is reused;
 * leaving the Wilds clears the chip.
 */
import { bus, EV } from '../events.ts'
import { landChip, sameChip, type LandChip } from '../../lib/wilds/land-chip.ts'
import { chunkKey } from './coords.ts'
import type { WildsView } from './store.ts'

export const ASK_AGAIN_MS = 10_000

export class LandHere {
  private cx = NaN
  private cy = NaN
  private version = -1
  private chip: LandChip | null = null
  /** When each chunk's status was last asked for (`cx,cy|wick`). */
  private asked = new Map<string, number>()
  private readonly read: (cx: number, cy: number) => void
  private readonly now: () => number

  constructor(read: (cx: number, cy: number) => void, now: () => number = Date.now) {
    this.read = read
    this.now = now
  }

  update(cx: number, cy: number, view: WildsView | null): void {
    const version = view?.version ?? -1
    if (cx === this.cx && cy === this.cy && version === this.version) return
    const stepped = cx !== this.cx || cy !== this.cy
    this.cx = cx
    this.cy = cy
    this.version = version
    const key = chunkKey(cx, cy)
    this.show(landChip(view?.land.get(key)))
    if (!view) return
    // The turning starts the land over: a new wick asks afresh.
    const ask = `${key}|${view.wick.id}`
    const at = this.asked.get(ask)
    const now = this.now()
    // A store change asks only for a chunk (or wick) not asked yet; stepping back in, once the last answer is old.
    if (at !== undefined && (!stepped || now - at < ASK_AGAIN_MS)) return
    if (this.asked.size > 64) this.asked.clear()
    this.asked.set(ask, now)
    this.read(cx, cy)
  }

  clear(): void {
    this.cx = this.cy = NaN
    this.version = -1
    this.asked.clear()
    this.show(null)
  }

  private show(next: LandChip | null): void {
    if (sameChip(next, this.chip)) return
    this.chip = next
    bus.emit(EV.landHere, { chip: next })
  }
}
