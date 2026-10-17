/**
 * Ways home (roadmap 0.13; docs/design/lamps.md §1.4): a homing turncap
 * takes you back to Hearthwick's north arch; a lamp-ash pouch takes you to
 * open ground beside the lamp you bound it to (a camp's way-lamp or a
 * communal lamp). Each needs a short pause, standing still and out of a
 * fight, and is used up only when the travel works. The server checks it
 * all and moves you (api/ways_home.go); this holds the pause and the words.
 */
import type { WaysHomeBinding } from './gen/glimway/v1/lamps_pb.js'
import { itemDef } from './items.ts'
import { MAP_LAMPS } from '../content/map-lamps.ts'

export type WayHome = 'turncap' | 'pouch'

/** The item each way home uses, and its use's type in content. */
const USE: Record<WayHome, string> = { turncap: 'travel-home', pouch: 'travel-lamp' }
export const WAY_ITEM: Record<WayHome, string> = { turncap: 'homing-turncap', pouch: 'lamp-ash-pouch' }

/** Which way home an item is, if it's one. */
export function wayOf(item: string): WayHome | null {
  for (const way of ['turncap', 'pouch'] as const) if (WAY_ITEM[way] === item) return way
  return null
}

/** How long the pause is (ms), from the item's use in content. */
export function pauseMs(way: WayHome): number {
  const use = itemDef(WAY_ITEM[way])?.use?.find((e) => e.type === USE[way])
  return Math.max(1, use?.seconds ?? 3) * 1000
}

/** How far the hero may drift (px) before the pause lets go: a nudge, never a step. */
export const STILL_PX = 4

export type PauseState = 'holding' | 'moved' | 'fight' | 'done'

/**
 * The pause before travel: started where the hero stands, it lets go if
 * they move or a fight finds them, and is done once its time has passed.
 * Pure, so the scene feeds it the clock and the hero.
 */
export class WayPause {
  readonly startedAt: number
  readonly ms: number
  private readonly from: { x: number; y: number }
  private ended: PauseState | null = null

  constructor(now: number, at: { x: number; y: number }, ms: number) {
    this.startedAt = now
    this.ms = ms
    this.from = { x: at.x, y: at.y }
  }

  /** 0..1 of the way through. */
  progress(now: number): number {
    return Math.max(0, Math.min(1, (now - this.startedAt) / this.ms))
  }

  /** Where the pause stands now. Once it has ended it stays ended. */
  tick(now: number, at: { x: number; y: number }, threatened: boolean): PauseState {
    if (this.ended) return this.ended
    if (Math.hypot(at.x - this.from.x, at.y - this.from.y) > STILL_PX) return (this.ended = 'moved')
    if (threatened) return (this.ended = 'fight')
    if (now - this.startedAt >= this.ms) return (this.ended = 'done')
    return 'holding'
  }

  /** Let go of it from outside (the scene ended, a panel took the screen). */
  cancel(): void {
    this.ended ??= 'moved'
  }
}

/** A bound lamp's name: its naming's short name, or what the map calls its kind. */
export function boundLampName(b: Pick<WaysHomeBinding, 'lampName' | 'kind'>): string {
  if (b.lampName) return b.lampName
  return MAP_LAMPS.names[b.kind === 'camp' ? 'way-lamp' : 'common-lamp'] ?? 'Common lamp'
}

/** "the way-lamp", but a naming keeps its own words. */
function spoken(b: Pick<WaysHomeBinding, 'lampName' | 'kind'>): string {
  return b.lampName ? b.lampName : `the ${boundLampName(b).toLowerCase()}`
}

export const WAYS_HOME_LINES = {
  start: { turncap: 'The turncap leans for home. Hold still…', pouch: 'The ash warms in your hand. Hold still…' } as Record<WayHome, string>,
  moved: 'You moved, and the pull let go. You still have it.',
  fight: 'Not in a fight. Get clear first.',
  arrived: { turncap: 'Back at the north arch. The turncap’s spent.' } as Record<'turncap', string>,
  arrivedBeside: (b: Pick<WaysHomeBinding, 'lampName' | 'kind'>) => `Beside ${spoken(b)}. The ash is spent.`,
  bound: (b: Pick<WaysHomeBinding, 'lampName' | 'kind'>) => `Your pouch is bound to ${spoken(b)}.`,
  bind: 'Bind it to the lamp here',
  unbound: 'Not bound to a lamp yet. Stand by one and bind it.',
  boundTo: (b: Pick<WaysHomeBinding, 'lampName' | 'kind' | 'state'>) => {
    const name = boundLampName(b)
    switch (b.state) {
      case 'lit':
        return `Bound to ${b.lampName ? name : name.toLowerCase()}.`
      case 'unlit':
        return 'Bound to a lamp that’s gone dark.'
      case 'packed':
        return 'Bound to a lamp packed away at Pell’s.'
      case 'elsewhere':
        return 'Bound to a lamp in another world.'
      default:
        return 'Bound to a lamp that’s gone.'
    }
  }
}

/** Whether a binding could take you there now, as far as the client knows. */
export function bindingLit(b: Pick<WaysHomeBinding, 'state'> | null | undefined): boolean {
  return b?.state === 'lit'
}
