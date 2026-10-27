/**
 * Walking on height terrain, in field space (slopes-gen-notes.md: collision
 * consumes field tile coordinates and the resolved patch, never screen
 * coordinates). The height lab's foot-box rule (../height-lab/levels.ts
 * fits/move) on the contract's step rule: the middle of the foot box moves
 * one tile at a time across an open edge (both tiles walkable by the
 * four-corner rule, no discontinuity flag, both corner pairs equal); every
 * other tile the box touches must be one open step from the middle's tile
 * (a corner: through either side). Ground that isn't known is closed.
 *
 * Moves are swept in small steps (SWEEP_PX), so a dash or a roll can't skip
 * an edge, with the slope's speed looked up afresh each step.
 */
import { DX, DY } from './surface.ts'
import { slopeFactor } from './field.ts'

export const TILE = 16

/** How the terrain answers the walking rule, by world tile. */
export interface StepRule {
  /** Is the tile known and walkable? */
  walkable(tx: number, ty: number): boolean
  /** Can you step from the tile across its side d (0 N, 1 E, 2 S, 3 W)? */
  canStep(tx: number, ty: number, d: number): boolean
}

/** Someone's feet: (x, y) world px at the bottom middle of a foot box hw each way and fh high. */
export interface Feet {
  x: number
  y: number
  hw: number
  fh: number
}

const tileOf = (px: number) => Math.floor(px / TILE)

/** The tile someone stands on: the middle of their foot box. */
export function standTile(w: Feet): [number, number] {
  return [tileOf(w.x), tileOf(w.y - w.fh / 2)]
}

function dirTo(ax: number, ay: number, bx: number, by: number): number {
  for (let d = 0; d < 4; d++) if (ax + DX[d]! === bx && ay + DY[d]! === by) return d
  return -1
}

/** Does the foot box fit at (x, y), coming from where `w` stands? */
export function fits(rule: StepRule, w: Feet, x: number, y: number): boolean {
  const [cx, cy] = standTile(w)
  const nx = tileOf(x)
  const ny = tileOf(y - w.fh / 2)
  if (nx !== cx || ny !== cy) {
    const d = dirTo(cx, cy, nx, ny)
    if (d < 0 || !rule.canStep(cx, cy, d)) return false
  }
  if (!rule.walkable(nx, ny)) return false
  const x0 = tileOf(x - w.hw)
  const x1 = tileOf(x + w.hw - 0.001)
  const y0 = tileOf(y - w.fh)
  const y1 = tileOf(y - 0.001)
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (tx === nx && ty === ny) continue
      const d = dirTo(nx, ny, tx, ty)
      if (d >= 0) {
        if (!rule.canStep(nx, ny, d)) return false
        continue
      }
      // A corner: through the side tile in x, or the one in y.
      const ex = tx > nx ? 1 : 3
      const sy = ty > ny ? 2 : 0
      const okX = rule.canStep(nx, ny, ex) && rule.canStep(tx, ny, sy)
      const okY = rule.canStep(nx, ny, sy) && rule.canStep(nx, ty, ex)
      if (!okX && !okY) return false
    }
  return true
}

/** Move by (dx, dy), one axis at a time so it slides along what stops it, in steps of at most half a tile. Which axes were blocked. */
export function moveFeet(rule: StepRule, w: Feet, dx: number, dy: number): { bx: boolean; by: boolean } {
  let bx = false
  let by = false
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (TILE / 2)))
  for (let i = 0; i < n; i++) {
    if (dx) {
      if (fits(rule, w, w.x + dx / n, w.y)) w.x += dx / n
      else bx = true
    }
    if (dy) {
      if (fits(rule, w, w.x, w.y + dy / n)) w.y += dy / n
      else by = true
    }
  }
  return { bx, by }
}

/** A sweep's step (px): small, so nothing skips an edge and the slope's speed doesn't jump at tile borders. */
export const SWEEP_PX = 2

/**
 * Carry a motion of (dx, dy) px (what the body was asked to move this step)
 * over the terrain from where `w` stands: swept in SWEEP_PX steps, each
 * scaled by the slope's speed there (`gradient`: levels a tile, east and
 * south, at a world px; uphill and downhill in percent, ./field.ts
 * slopeFactor). Moves `w`; which axes were blocked, and the last factor.
 */
export function sweep(rule: StepRule, w: Feet, dx: number, dy: number, gradient: ((x: number, y: number) => readonly [number, number]) | null, uphill: number, downhill: number): { bx: boolean; by: boolean; k: number } {
  const len = Math.hypot(dx, dy)
  let bx = false
  let by = false
  let k = 1
  if (len < 1e-9) return { bx, by, k }
  const ux = dx / len
  const uy = dy / len
  let left = len
  while (left > 1e-9) {
    const s = Math.min(SWEEP_PX, left)
    left -= s
    if (gradient) {
      const [gx, gy] = gradient(w.x, w.y - w.fh / 2)
      k = slopeFactor(gx, gy, ux, uy, uphill / 100, downhill / 100).k
    }
    const r = moveFeet(rule, w, (bx ? 0 : ux) * s * k, (by ? 0 : uy) * s * k)
    bx ||= r.bx
    by ||= r.by
    if (bx && by) break
  }
  return { bx, by, k }
}

/** The nearest walkable tile to (tx, ty) within `most` rings (null: none). */
export function nearestWalkable(rule: StepRule, tx: number, ty: number, most = 8): [number, number] | null {
  for (let r = 0; r <= most; r++)
    for (let y = ty - r; y <= ty + r; y++)
      for (let x = tx - r; x <= tx + r; x++) {
        if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) !== r) continue
        if (rule.walkable(x, y)) return [x, y]
      }
  return null
}
