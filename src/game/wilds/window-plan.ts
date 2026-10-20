/**
 * The open map's moving window, as pure rules (docs/design/open-map.md 2.5):
 * which chunks the scene keeps attached around the hero, which it fetches,
 * which it paints as drift, when a chunk can be painted, and where a hero
 * standing in something solid steps to. The scene runtime is ./window.ts.
 */
import { CHUNK_PX, CHUNK_TILES, chunkKey } from './coords.ts'
import type { ChunkRect } from './store.ts'

export interface WindowPlan {
  center: { cx: number; cy: number }
  /** The 3×3 around the hero on the grid: ground, collision, props, entities, sites. */
  attach: string[]
  /** The 3×3's chunks past the world border: painted as the drift, solid. */
  drift: string[]
  /** The 5×5 on the grid: fetched and decoded (bodies and the near read). */
  fetch: string[]
  /** The fetched ring outside the 3×3: only their landmarks are drawn (seen from a chunk away). */
  ring: string[]
}

/** The window around chunk (cx, cy); `inside` is the grid (the border and the fixed footprints). */
export function planWindow(cx: number, cy: number, inside: (cx: number, cy: number) => boolean): WindowPlan {
  const attach: string[] = []
  const drift: string[] = []
  const fetch: string[] = []
  const ring: string[] = []
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx
      const y = cy + dy
      const near = Math.abs(dx) <= 1 && Math.abs(dy) <= 1
      const key = chunkKey(x, y)
      if (!inside(x, y)) {
        if (near) drift.push(key)
        continue
      }
      fetch.push(key)
      if (near) attach.push(key)
      else ring.push(key)
    }
  return { center: { cx, cy }, attach, drift, fetch, ring }
}

/**
 * A chunk can be painted once every neighbour on the grid is known
 * (the painter reads two tiles past each edge), so its image joins theirs.
 * Neighbours past the border are always known: they read as the drift.
 */
export function paintable(cx: number, cy: number, inside: (cx: number, cy: number) => boolean, known: (cx: number, cy: number) => boolean): boolean {
  if (!known(cx, cy)) return false
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      if (inside(cx + dx, cy + dy) && !known(cx + dx, cy + dy)) return false
    }
  return true
}

/**
 * The open tile nearest (tx, ty), by walking steps over open tiles from the
 * nearest open one (decision 10: the turning moves you to open ground, never
 * home). Null when nothing open lies within `radius` tiles.
 */
export function nearestOpen(tx: number, ty: number, open: (tx: number, ty: number) => boolean, radius = 24): { tx: number; ty: number } | null {
  if (open(tx, ty)) return { tx, ty }
  // Rings outward, the nearest (by distance, then a fixed order) first.
  for (let r = 1; r <= radius; r++) {
    let best: { tx: number; ty: number; d: number } | null = null
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        if (!open(tx + dx, ty + dy)) continue
        const d = dx * dx + dy * dy
        if (!best || d < best.d) best = { tx: tx + dx, ty: ty + dy, d }
      }
    if (best) return { tx: best.tx, ty: best.ty }
  }
  return null
}

/** Which of the 3×3 the hero's chunk changes to: null while still in `center`. */
export function crossed(center: { cx: number; cy: number } | null, at: { cx: number; cy: number }): boolean {
  return !center || center.cx !== at.cx || center.cy !== at.cy
}

/** Pixels past a chunk rectangle's edge (0 inside it). */
export function rectDistance(f: ChunkRect, wx: number, wy: number): number {
  const x0 = f.minCx * CHUNK_PX
  const y0 = f.minCy * CHUNK_PX
  const x1 = (f.maxCx + 1) * CHUNK_PX
  const y1 = (f.maxCy + 1) * CHUNK_PX
  const dx = Math.max(x0 - wx, wx - x1, 0)
  const dy = Math.max(y0 - wy, wy - y1, 0)
  return Math.max(dx, dy)
}

/** Which sides of a drift chunk face the grid (an inside chunk across that edge). */
export function veilEdges(cx: number, cy: number, inside: (cx: number, cy: number) => boolean): ('north' | 'south' | 'east' | 'west')[] {
  const out: ('north' | 'south' | 'east' | 'west')[] = []
  if (inside(cx, cy - 1)) out.push('north')
  if (inside(cx, cy + 1)) out.push('south')
  if (inside(cx + 1, cy)) out.push('east')
  if (inside(cx - 1, cy)) out.push('west')
  return out
}

/**
 * The chunks beside the hero's that are walled off: every one of the eight
 * around (cx, cy) that isn't walkable (attached, so drawn and its collision
 * in). The drift and land not yet loaded are solid (decision 3): without a
 * wall, a hero who outwalks the loading would step onto land not drawn yet.
 * The hero's own chunk is never walled, so nothing can trap them; the
 * turning moves them (world-turning.ts).
 */
export function walledChunks(cx: number, cy: number, walkable: (cx: number, cy: number) => boolean): string[] {
  const out: string[] = []
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && !walkable(cx + dx, cy + dy)) out.push(chunkKey(cx + dx, cy + dy))
    }
  return out
}

/**
 * Tiles past a chunk edge the hero can walk before the row left behind
 * goes. Crossing an edge attaches the row ahead at once, but the row that
 * left the 3×3 stays until the hero is this far into the new chunk, so
 * stepping back and forth over one edge builds and drops nothing.
 */
export const SLACK_TILES = 8

/**
 * Whether chunk (cx, cy) stays attached with the hero on tile (tx, ty): it
 * is in the 3×3 around the hero's chunk, or out of it by less than `slack`
 * tiles (Chebyshev, from the hero to the chunk's nearest tile).
 */
export function keepAttached(cx: number, cy: number, tx: number, ty: number, slack: number): boolean {
  const x0 = cx * CHUNK_TILES
  const y0 = cy * CHUNK_TILES
  const dx = Math.max(x0 - tx, tx - (x0 + CHUNK_TILES - 1), 0)
  const dy = Math.max(y0 - ty, ty - (y0 + CHUNK_TILES - 1), 0)
  return Math.max(dx, dy) <= CHUNK_TILES + slack
}
