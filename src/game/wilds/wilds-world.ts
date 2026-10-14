/**
 * The open map as the scene's area (docs/design/open-map.md 2.5): `wilds`,
 * one area with no fixed grid. Everything curated is empty; the ground,
 * collision, scenery, workable pieces, entities and sites arrive per chunk
 * as the window attaches them (./window.ts). What's left here: the Commons
 * gate as the one exit, the frontier as the bounds, and the ground lookups.
 */
import { TILE } from '../../lib/tile.ts'
import type { WorldData } from '../worlds.ts'
import { CHUNK_PX, OUTDOORS_AREA, gateArrival, gateTiles, wildsReturnTile } from './coords.ts'
import { groundAt, solidAt, standAt } from './ground-view.ts'
import { wildsFrontier } from './store.ts'
import { loadWilds } from '../../lib/wilds/data.ts'

/** How far past the frontier the camera may look (the drift and its glimpse), in px. */
export const DRIFT_VIEW_PX = 12 * TILE

/** The frontier in world px: the near read's rectangle, else the content's (before a read). */
export function frontierBounds(): { x: number; y: number; w: number; h: number } {
  const f = wildsFrontier() ?? contentFrontier()
  return { x: f.minCx * CHUNK_PX, y: f.minCy * CHUNK_PX, w: (f.maxCx - f.minCx + 1) * CHUNK_PX, h: (f.maxCy - f.minCy + 1) * CHUNK_PX }
}

/** The 0.8 frontier from content (within `reach` of a footprint, no further south than `southLimit`). */
function contentFrontier(): { minCx: number; minCy: number; maxCx: number; maxCy: number } {
  const w = loadWilds()
  const reach = w.frontier.reach
  const xs = w.places.flatMap((p) => [p.cx - reach, p.cx + p.width - 1 + reach])
  const ys = w.places.flatMap((p) => [p.cy - reach, p.cy + p.height - 1 + reach])
  return { minCx: Math.min(...xs), minCy: Math.min(...ys), maxCx: Math.max(...xs), maxCy: Math.min(Math.max(...ys), w.frontier.southLimit) }
}

export function buildWildsWorld(): WorldData {
  const bounds = frontierBounds()
  const gate = gateTiles()
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
    npcs: [],
    enemies: [],
    exits: [{ ...gate, to: 'commons', entry: wildsReturnTile(), label: null, side: 'south' }],
    props: [],
    discoverySpots: [],
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    glimSpots: [],
    spawn: gateArrival(),
    scenery: [],
    gathering: [],
    open: {
      bounds,
      view: { x: bounds.x - DRIFT_VIEW_PX, y: bounds.y - DRIFT_VIEW_PX, w: bounds.w + 2 * DRIFT_VIEW_PX, h: bounds.h + DRIFT_VIEW_PX },
      groundAt,
      solidAt,
      standAt,
    },
  }
}
