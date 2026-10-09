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
import manifest from '../../assets/generated/crafts-pass/manifest.json' with { type: 'json' }
import { TILE } from './tile.ts'
import { HOMESTEAD_DATA, stableFootprint } from './homestead.ts'

/** The footprint is the homestead rules' one (content/homestead.json: 4 × 3, plus 2 × 3 a stall). */
export { stableFootprint }

export const STABLE_MIN_STALLS = 1
export const STABLE_MAX_STALLS = HOMESTEAD_DATA.stable.maxStalls

/** A stable frame's canvas in world px, from the pass's manifest (its texels at `density` per tile). */
function frameSize(name: string): { w: number; h: number } {
  const m = manifest as { density: number; frames: Record<string, { canvasSize: { w: number; h: number } }> }
  const c = m.frames[name]?.canvasSize
  if (!c) throw new Error(`crafts pass: no frame ${name}`)
  return { w: (c.w * TILE) / m.density, h: (c.h * TILE) / m.density }
}

/** The art's height (5 tiles: the roof rises 2 above the 3-tile footprint). */
export const STABLE_ART_HEIGHT = frameSize('stable-west-back').h
/** The west end (4 tiles). */
export const STABLE_WEST_WIDTH = frameSize('stable-west-back').w
/** One bay (2 tiles). */
export const STABLE_BAY_WIDTH = frameSize('stable-bay-back').w
/** The east gable (half a tile). */
export const STABLE_GABLE_WIDTH = frameSize('stable-east-gable').w

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

/** How far in front of a bay you stand to use it, px below the footprint's bottom edge. */
export const STALL_FRONT_DROP = 6
/**
 * A stall's reach (its prompt and its click): with the point STALL_FRONT_DROP
 * below the bay, this keeps the hero strictly inside the server's walk-up
 * check, two tiles from the bay's tiles (`nearStall`, crafts.md 3.3).
 */
export const STALL_REACH = 24

/** Where to stand to use a bay (its front, just south of the footprint), px from (bx, by), the footprint's bottom-left. */
export function bayFront(bx: number, by: number, count: number, stall: number): { x: number; y: number } {
  const bay = stableLayout(count).bays.find((b) => b.stall === stall)
  return { x: bx + (bay ? bay.x + bay.w / 2 : 0), y: by + STALL_FRONT_DROP }
}
