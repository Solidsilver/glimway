/**
 * Seats (playtest 1): where a seated hero goes on each thing you can sit on,
 * and how the body is cut to sit there.
 *
 * The hero has no sitting art, so sitting is a crop, never a squash: the
 * figure is drawn whole down to its lap and cut there, with the cut laid on
 * the seat's front edge (side-on seats: the seat line). The seat's legs and
 * front stay in view below, the backrest shows behind the shoulders, and the
 * seated hero sorts just in front of the seat it's on (so a backrest is
 * behind them, and anything standing in front still covers them).
 *
 * Every seat here faces down (towards you): benches face the square, and a
 * placed piece turned 90° or 180° shows its front view (the delivered art
 * has no side or back view; src/game/atlas-plan.ts decorationLayout), so
 * nobody sits facing away. The hero and avatar also sit side-on, for a seat
 * that one day has a side view.
 *
 * No Phaser here: the geometry is shared by the hero, the avatar and tests.
 */

export type SeatFacing = 'down' | 'left' | 'right'

export interface SeatPose {
  /** Where the seated hero's centre is (px). */
  x: number
  /** Where the visible body ends: the seat's front edge (side-on: the seat line). */
  y: number
  /** The seated hero's draw depth: just in front of the seat. */
  depth: number
  facing: SeatFacing
}

/** Extra mana a second while seated (a bench in the square, a lit lantern's rest), or standing warm at a hearth. */
export const SEATED_MANA_BONUS = 5

/**
 * Mana a second (local regen; the server bounds what a report may claim):
 * everyone's 5, the seated bonus while seated or standing still at a warm
 * hearth (a room's `kitchen-hearth`: warmth, no seat), and a lit lantern's
 * rest. HP is never this: it's the lantern rest's rule (src/game/entities/hero.ts).
 */
export function manaRegenRate(o: { seated: boolean; warm: boolean; rest: number }): number {
  return 5 + (o.seated || o.warm ? SEATED_MANA_BONUS : 0) + 6 * o.rest
}

/** The village and Commons bench ('patched-bench', 18 px tall, facing the square). */
export const BENCH = {
  /** Seat front edge above the bench's base (the art's seat lip, row 62 of 90). */
  frontEdge: 6
} as const

/** A bench's seat, from the bench's base centre (its prop x and tile bottom). */
export function benchSeat(x: number, baseY: number): SeatPose {
  return { x, y: baseY - BENCH.frontEdge, depth: baseY + 0.5, facing: 'down' }
}

/** Placed furniture you can sit on (src/game/commons-art.ts draws them). */
export const SEAT_ITEMS = ['wooden-stool', 'reading-chair'] as const
export type SeatItem = (typeof SEAT_ITEMS)[number]

/**
 * The Empty Chair is set for the ones the Tangle kept (Amberwake): placed,
 * it's looked at, never sat in.
 */
export const KEPT_EMPTY = 'empty-chair'

export function isSeatItem(itemDef: string): itemDef is SeatItem {
  return (SEAT_ITEMS as readonly string[]).includes(itemDef)
}

/** The opaque part of a seat's art as drawn (world px). */
export interface ArtBox {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Where each seat's front edge is in its art, as a share of the art's height
 * from its top (the delivered Commons-pass pieces: the stool's round top over
 * three legs; the armchair's cushion above its stubby feet).
 */
export const SEAT_EDGE: Readonly<Record<SeatItem, number>> = {
  'wooden-stool': 0.4,
  'reading-chair': 0.75
}

/**
 * A placed seat's pose from the art drawn for it (`art`, whatever pass drew
 * it) and its footprint's bottom (`base`, its draw depth). Null for anything
 * that isn't a seat.
 */
export function decoSeat(itemDef: string, art: ArtBox, base: number): SeatPose | null {
  if (!isSeatItem(itemDef)) return null
  return {
    x: Math.round((art.left + art.right) / 2),
    y: Math.round(art.top + SEAT_EDGE[itemDef] * (art.bottom - art.top)),
    depth: base + 0.5,
    facing: 'down'
  }
}

/**
 * Where to cut each body, in its own art's rows (source px from the top):
 * the seated body is drawn down to this row and no further.
 */
export const SEAT_CUT = {
  /** The demo hero (fingersnap-demo-walk, 137 rows): the tunic's hem. */
  demo: { down: 108, left: 106, right: 106 },
  /** A Habitica avatar (90-row canvas, figure in rows 24-84): just below the belt. */
  habitica: { down: 76, left: 76, right: 76 }
} as const satisfies Record<string, Record<SeatFacing, number>>
