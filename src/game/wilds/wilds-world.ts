/**
 * The open map as the scene's area (docs/design/open-map.md 2.5): `outdoors`,
 * one area with no fixed grid. Everything curated is empty; the ground,
 * collision, scenery, workable pieces, entities, sites, and the fixed
 * footprints' pieces and ways out (the Commons: location-seam.md 4) arrive
 * per chunk as the window attaches them (./window.ts). What's left here: the
 * grid (the frontier and the fixed footprints) as the bounds, and the ground
 * lookups across both.
 */
import { TILE } from '../../lib/tile.ts'
import type { WorldData } from '../worlds.ts'
import { CHUNK_PX, CHUNK_TILES, OUTDOORS_AREA } from './coords.ts'
import { groundAt, solidAt } from './ground-view.ts'
import { wildsFrontier } from './store.ts'
import { frontierRect } from '../../lib/wilds/coords.ts'
import { PLACES, fixedChunks } from '../../lib/places.ts'
import { anchorTile, fixedGroundAt, fixedPlaceOf, fixedSolidAt, fixedStand, footprintAt } from './fixed.ts'
import { nearestOpen } from './window-plan.ts'

/** How far past the frontier the camera may look (the drift and its glimpse), in px. */
export const DRIFT_VIEW_PX = 12 * TILE

/** The frontier in world px: the near read's rectangle, else the content's (before a read). */
export function frontierBounds(): { x: number; y: number; w: number; h: number } {
  const f = wildsFrontier() ?? contentFrontier()
  return { x: f.minCx * CHUNK_PX, y: f.minCy * CHUNK_PX, w: (f.maxCx - f.minCx + 1) * CHUNK_PX, h: (f.maxCy - f.minCy + 1) * CHUNK_PX }
}

/** The 0.8 frontier from content (within `reach` of a footprint, no further south than `southLimit`). */
function contentFrontier(): { minCx: number; minCy: number; maxCx: number; maxCy: number } {
  return frontierRect()
}

/** The grid in world px: the frontier and every fixed footprint (the Commons south of the gate). */
export function gridBounds(): { x: number; y: number; w: number; h: number } {
  const f = frontierBounds()
  let x0 = f.x
  let y0 = f.y
  let x1 = f.x + f.w
  let y1 = f.y + f.h
  for (const p of PLACES.fixed) {
    const c = fixedChunks(p)
    x0 = Math.min(x0, c.x0 * CHUNK_PX)
    y0 = Math.min(y0, c.y0 * CHUNK_PX)
    x1 = Math.max(x1, (c.x1 + 1) * CHUNK_PX)
    y1 = Math.max(y1, (c.y1 + 1) * CHUNK_PX)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const onFixed = (tx: number, ty: number) => fixedPlaceOf(Math.floor(tx / CHUNK_TILES), Math.floor(ty / CHUNK_TILES)) !== null

/** Fixed ground not delivered yet: keep the arrival and hold play until its chunk attaches. */
export function waitingFixedAt(x: number, y: number): boolean {
  const cx = Math.floor(x / (CHUNK_TILES * TILE))
  const cy = Math.floor(y / (CHUNK_TILES * TILE))
  return !!fixedPlaceOf(cx, cy) && !footprintAt(cx, cy)
}

/** The ground at a world tile: a fixed footprint's, else the generated land's (null where nothing is known). */
export function outdoorGroundAt(tx: number, ty: number): number | null {
  return onFixed(tx, ty) ? fixedGroundAt(tx, ty) : groundAt(tx, ty)
}

/** Is a world tile solid? (Off the grid, and where nothing is loaded yet, it is.) */
export function outdoorSolidAt(tx: number, ty: number): boolean {
  return onFixed(tx, ty) ? fixedSolidAt(tx, ty) : solidAt(tx, ty)
}

/**
 * Where a hero at world pixel (x, y) can stand: there, if its tile is open;
 * else the middle of the nearest open tile (the land may have turned). On a
 * fixed footprint, only ground its arrivals reach (a save can name an open
 * pocket walled in by the woods). Null when nothing near is open or loaded.
 */
export function outdoorStandAt(x: number, y: number): { x: number; y: number } | null {
  const tx = Math.floor(x / TILE)
  const ty = Math.floor(y / TILE)
  if (onFixed(tx, ty)) {
    // Boot's bounded wait can expire before the chunks arrive. Missing
    // ground is not evidence that the saved spot is blocked.
    if (waitingFixedAt(x, y)) return { x, y }
    const t = fixedStand(tx, ty)
    if (!t) return null
    return t.tx === tx && t.ty === ty ? { x, y } : { x: t.tx * TILE + TILE / 2, y: t.ty * TILE + TILE / 2 }
  }
  if (!outdoorSolidAt(tx, ty)) return { x, y }
  const t = nearestOpen(tx, ty, (a, b) => !outdoorSolidAt(a, b))
  return t ? { x: t.tx * TILE + TILE / 2, y: t.ty * TILE + TILE / 2 } : null
}

export function buildWildsWorld(): WorldData {
  const bounds = gridBounds()
  return {
    areaId: OUTDOORS_AREA,
    width: 0,
    height: 0,
    widthPx: bounds.w,
    heightPx: bounds.h,
    ground: [],
    solid: [],
    trees: [],
    bushes: [],
    rocks: [],
    // The Commons' residents attach with their fixed chunks.
    npcs: [],
    enemies: [],
    exits: [],
    props: [],
    discoverySpots: [],
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    glimSpots: [],
    // Nowhere else to stand: just inside the Commons' north arch.
    spawn: anchorTile('hearthwick:arch'),
    scenery: [],
    gathering: [],
    open: {
      bounds,
      view: { x: bounds.x - DRIFT_VIEW_PX, y: bounds.y - DRIFT_VIEW_PX, w: bounds.w + 2 * DRIFT_VIEW_PX, h: bounds.h + 2 * DRIFT_VIEW_PX },
      groundAt: outdoorGroundAt,
      solidAt: outdoorSolidAt,
      standAt: outdoorStandAt,
    },
  }
}
