/**
 * The stable as drawn (docs/design/crafts.md 3.2, 9.2): one placed piece
 * whose footprint grows east with its stalls. The crafts pass delivers it
 * in pieces cut from one continuous building at shared post centrelines:
 * the west end (the tack room and stall 1's bay, 4 × 3 tiles), a bay that
 * repeats east (2 × 3 tiles) for each extra stall, and the east gable (the
 * last post's east half and the roof's end, half a tile) standing just past
 * the last bay's east edge, outside the footprint, as it was cut. Each piece has a back layer (walls, hay
 * rack, the bay's back) and a front layer (the half door and posts), so a
 * mount drawn between them stands inside its bay.
 *
 * Pure: world px only, no Phaser (src/game/crafts-art.ts draws it).
 */
import { TILE } from './tile.ts'

export const STABLE_MIN_STALLS = 1
export const STABLE_MAX_STALLS = 6
/** The art's height: 320 texels at 64 per tile, 5 tiles (the roof rises 2 above the 3-tile footprint). */
export const STABLE_ART_HEIGHT = 5 * TILE
/** The west end: 256 texels, 4 tiles. */
export const STABLE_WEST_WIDTH = 4 * TILE
/** One bay: 128 texels, 2 tiles. */
export const STABLE_BAY_WIDTH = 2 * TILE
/** The east gable: 32 texels, half a tile. */
export const STABLE_GABLE_WIDTH = TILE / 2

/** The footprint for a stall count: 4 × 3 with stall 1, plus 2 × 3 for each extra stall. */
export function stableFootprint(stalls: number): [number, number] {
  return [4 + 2 * (clampStalls(stalls) - 1), 3]
}

export function clampStalls(stalls: number): number {
  return Math.max(STABLE_MIN_STALLS, Math.min(STABLE_MAX_STALLS, Math.floor(Number.isFinite(stalls) ? stalls : 1)))
}

/** A piece of the stable's art, placed in world px from the footprint's bottom-left (y grows down: art bottoms sit at y = 0). */
export interface StablePiece {
  /** Crafts-pass frame name. */
  frame: string
  /** Left edge, px east of the footprint's west edge. */
  x: number
  /** Width and height in world px (the art's canvas at 64 texels per tile). */
  w: number
  h: number
}

/** One stall's bay: where its mount stands and which front frame closes it. */
export interface StableBay {
  /** 1 to 6, from the west. */
  stall: number
  /** The bay's left edge and width, px from the footprint's west edge. */
  x: number
  w: number
  /** The bay's front layer, by whether its half door is shut. */
  front: { shut: string; open: string }
}

export interface StableLayout {
  stalls: number
  /** Footprint, tiles. */
  footprint: [number, number]
  /** Back layers, west to east (draw first). */
  back: StablePiece[]
  /** The bays, west to east, for mounts and their half doors. */
  bays: StableBay[]
  /** Pieces drawn with the back layers but never covered by a mount: the gable closing the roof line (x = the footprint's east edge). */
  over: StablePiece[]
}

/**
 * Where every piece of a stable with `stalls` bays goes. Stall 1's bay is
 * the west end's east half; stall n ≥ 2 is the (n−1)th repeated bay. A
 * front layer spans its whole piece (the west end's front holds the tack
 * room's wall as well as stall 1's door), so for stall 1 the front frame
 * covers x 0..64, not just the bay.
 */
export function stableLayout(stalls: number): StableLayout {
  const n = clampStalls(stalls)
  const back: StablePiece[] = [{ frame: 'stable-west-back', x: 0, w: STABLE_WEST_WIDTH, h: STABLE_ART_HEIGHT }]
  const bays: StableBay[] = [{ stall: 1, x: STABLE_WEST_WIDTH - STABLE_BAY_WIDTH, w: STABLE_BAY_WIDTH, front: { shut: 'stable-west-front-shut', open: 'stable-west-front-open' } }]
  for (let i = 2; i <= n; i++) {
    const x = STABLE_WEST_WIDTH + (i - 2) * STABLE_BAY_WIDTH
    back.push({ frame: 'stable-bay-back', x, w: STABLE_BAY_WIDTH, h: STABLE_ART_HEIGHT })
    bays.push({ stall: i, x, w: STABLE_BAY_WIDTH, front: { shut: 'stable-bay-front-shut', open: 'stable-bay-front-open' } })
  }
  const east = STABLE_WEST_WIDTH + (n - 1) * STABLE_BAY_WIDTH
  return {
    stalls: n,
    footprint: stableFootprint(n),
    back,
    bays,
    over: [{ frame: 'stable-east-gable', x: east, w: STABLE_GABLE_WIDTH, h: STABLE_ART_HEIGHT }]
  }
}

/** A bay's front piece: its left edge and width (stall 1's is the whole west end). */
export function bayFrontPiece(bay: StableBay, shut: boolean): StablePiece {
  const frame = shut ? bay.front.shut : bay.front.open
  return bay.stall === 1
    ? { frame, x: 0, w: STABLE_WEST_WIDTH, h: STABLE_ART_HEIGHT }
    : { frame, x: bay.x, w: STABLE_BAY_WIDTH, h: STABLE_ART_HEIGHT }
}
