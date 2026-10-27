/**
 * Height terrain's field, shared by the height lab and the game (the lab's
 * finite slopes area, and the game's per-chunk bakes on a window of the
 * streamed surfaces): per tile its four corner heights (levels, at 1/256),
 * kind and ground; the bilinear height and gradient at a point; the true ¾
 * lift's columns (what's drawn where, and what's hidden); partial
 * see-through; and slope speed.
 *
 * Coordinates are field tiles and field px (16 a tile) from the field's own
 * origin: the lab's area is one field from 0; a game bake builds a field
 * over its chunk and a halo and works in that field's coordinates.
 */

export const TILE_PX = 16

/**
 * The walking limit, in levels a tile: one level over four tiles (12 px of
 * rise in 16). It stays under 1/3, the slope at which ground facing away
 * from you would vanish in the true ¾ lift, so nothing walkable ever hides
 * behind a hill.
 */
export const MAX_WALK_SLOPE = 0.25

/** Heights are kept at the wire's edge precision. */
export const Q = 256

/** Levels run 0–15 (the contract shared with the generator). */
export const MAX_LEVEL = 15

/** The view kind that marks a cliff face (the lab's KIND.face). */
export const VIEW_FACE = 3

/** The ground: per tile its corners, kind and ground. */
export interface Field {
  w: number
  h: number
  /** Four a tile: nw, ne, se, sw (levels, at 1/256). */
  corner: Float32Array
  /** The lab's kinds (./height-lab/levels.ts KIND): flat or slope (walkable), steep, crag, prop. */
  kind: Uint8Array
  ground: Uint8Array
  /** Slope per tile, levels a tile: the steepest corner of its bilinear patch (steepest). */
  slope: Float32Array
}

/** What's drawn per view tile in the flat (top-down) look: cliff faces, with their top level, row and rows. */
export interface FaceView {
  w: number
  h: number
  kind: Uint8Array
  faceTop: Float32Array
  faceRow: Int8Array
  faceRows: Int8Array
}

/** A field as drawn: flat (top-down) or lifted k rows a level, with a margin `pad` rows on top. */
export interface TerrainView {
  lift: boolean
  /** Rows a level the view draws ground further north (lift px / TILE_PX: 0 or 3). */
  k: number
  field: Field
  /** Lifted: rows the view is moved down by, so the highest ground still fits (0 flat). */
  pad: number
  /** Tall ground compressed above a knee (none: k rows a level all the way up). */
  curve?: LiftCurve
  /** The flat look's faces (unused lifted). */
  view: FaceView
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))

/**
 * The walking rule's measure (shared with the generator): the bilinear
 * patch's squared gradient at the steepest of its four corners, in quantized
 * units (1/256 level a tile), so the check is integers and no square root:
 * a tile is walkable only if every corner's gx² + gy² ≤ MAX_WALK_Q².
 */
export function steepest(c: Float32Array, o: number): number {
  const nw = Math.round(c[o]! * Q)
  const ne = Math.round(c[o + 1]! * Q)
  const se = Math.round(c[o + 2]! * Q)
  const sw = Math.round(c[o + 3]! * Q)
  let most = 0
  // At each corner: gx along its row (north or south edge), gy along its column (west or east edge).
  for (const [gx, gy] of [[ne - nw, sw - nw], [ne - nw, se - ne], [se - sw, se - ne], [se - sw, sw - nw]] as const) most = Math.max(most, gx * gx + gy * gy)
  return most
}

/** MAX_WALK_SLOPE in quantized units (64: a rise of 64/256 level a tile). */
export const MAX_WALK_Q = Math.round(MAX_WALK_SLOPE * Q)

/** A field tile's height at (fx, fy) across it (bilinear between its corners). */
export function fieldZ(f: Field, tx: number, ty: number, fx: number, fy: number): number {
  const i = (ty * f.w + tx) * 4
  const c = f.corner
  const n = c[i]! + (c[i + 1]! - c[i]!) * fx
  const s = c[i + 3]! + (c[i + 2]! - c[i + 3]!) * fx
  return n + (s - n) * fy
}

/** The slope's gradient (levels a tile, east and south: it points uphill) at field point (x, y) px: its tile's bilinear patch there. */
export function fieldGradient(f: Field, x: number, y: number): [number, number] {
  const tx = Math.min(f.w - 1, Math.max(0, Math.floor(x / TILE_PX)))
  const ty = Math.min(f.h - 1, Math.max(0, Math.floor(y / TILE_PX)))
  const fx = Math.min(1, Math.max(0, x / TILE_PX - tx))
  const fy = Math.min(1, Math.max(0, y / TILE_PX - ty))
  const c = f.corner
  const i = (ty * f.w + tx) * 4
  return [(c[i + 1]! - c[i]!) * (1 - fy) + (c[i + 2]! - c[i + 3]!) * fy, (c[i + 3]! - c[i]!) * (1 - fx) + (c[i + 2]! - c[i + 1]!) * fx]
}

// ---------------------------------------------------------------- the lifted view

/** Tall ground in the lift: k rows a level up to the knee (a level), `above` rows a level past it. */
export interface LiftCurve {
  knee: number
  above: number
}

/**
 * Rows ground at height z is drawn further north: k a level up to the knee,
 * `above` a level past it. Continuous and never falling (above ≥ 0), so a
 * ramp over the knee stays a ramp. The one lift for bakes, sprites,
 * see-through, shadows and the hero.
 */
export function liftRows(z: number, k: number, curve?: LiftCurve): number {
  if (!curve || z <= curve.knee) return k * z
  return k * curve.knee + curve.above * (z - curve.knee)
}

/** The lift's rows a level at height z (its slope: k below the knee, `above` past it). */
export function liftSlope(z: number, k: number, curve?: LiftCurve): number {
  return !curve || z < curve.knee ? k : curve.above
}

/**
 * One run of a lifted map column (screen rows s0 ≤ s < s1, in tiles):
 * ground of field tile `ty` (its north and south edges at screen rows sN, sS
 * and heights zN, zS along this column), or a face, from its top `zS` down
 * to the land in front (`zBot`).
 */
export interface Span {
  s0: number
  s1: number
  face: boolean
  ty: number
  sN: number
  sS: number
  zN: number
  zS: number
  zBot: number
}

/**
 * A lifted column at field x = tx + fx: from the near (south) edge back,
 * each tile shows where it rises above everything nearer (a horizon);
 * where a tile's near edge stands above the land in front, the gap is its
 * face.
 */
export function liftColumn(f: Field, tx: number, fx: number, pad: number, k: number, curve?: LiftCurve): Span[] {
  const out: Span[] = []
  let horizon = Infinity
  let nearN = 0
  const c = f.corner
  for (let ty = f.h - 1; ty >= 0; ty--) {
    const i = (ty * f.w + tx) * 4
    const zN = c[i]! + (c[i + 1]! - c[i]!) * fx
    const zS = c[i + 3]! + (c[i + 2]! - c[i + 3]!) * fx
    const sN = ty - liftRows(zN, k, curve) + pad
    const sS = ty + 1 - liftRows(zS, k, curve) + pad
    if (horizon !== Infinity && sS < horizon - 1e-4) out.push({ s0: sS, s1: horizon, face: true, ty, sN, sS, zN, zS, zBot: nearN })
    if (sN < sS && sN < horizon) out.push({ s0: sN, s1: Math.min(sS, horizon), face: false, ty, sN, sS, zN, zS, zBot: zN })
    horizon = Math.min(horizon, sN, sS)
    nearN = zN
  }
  return out
}

/** The run a screen row falls in (null: nothing there). */
export function spanAt(col: Span[], s: number): Span | null {
  for (const sp of col) if (s >= sp.s0 && s < sp.s1) return sp
  return null
}

/** A ground run's field row at screen row s (fractional, 0–1 across the tile), and its height there. */
export function spanGround(sp: Span, s: number): { fy: number; z: number } {
  const fy = clamp((s - sp.sN) / (sp.sS - sp.sN), 0, 1)
  return { fy, z: sp.zN + (sp.zS - sp.zN) * fy }
}

/** The margin a lifted map needs on top: the highest ground's lift (k rows a level), and a little. */
export function liftPad(f: Field, k: number, curve?: LiftCurve): number {
  let zmax = 0
  for (const z of f.corner) zmax = Math.max(zmax, z)
  return Math.ceil(liftRows(zmax, k, curve)) + 2
}

/** How much higher the ground drawn at a lifted point may be than the ground under it before it counts as hiding it (levels). */
export const HIDE_ABOVE = 0.25

/**
 * Where someone standing at field point (x, y) px at height z is drawn, and
 * whether they're hidden. No lift: where they stand. Lifted: k rows a
 * level further north (screen y = y − 16 k z + 16 pad; 16 k is the lift strength). The rule for what's
 * hidden: they're hidden when the ground the lift draws at that screen point
 * (the nearest surface, liftColumn) isn't theirs, that is a face
 * or ground more than HIDE_ABOVE levels higher: something nearer and higher
 * stands in front.
 */
export function display(info: TerrainView, x: number, y: number, z: number): { x: number; y: number; hidden: boolean } {
  if (!info.lift) return { x, y, hidden: false }
  const T = TILE_PX
  const sy = y - T * liftRows(z, info.k, info.curve) + info.pad * T
  const tx = Math.min(info.field.w - 1, Math.max(0, Math.floor(x / T)))
  const col = liftColumn(info.field, tx, x / T - tx, info.pad, info.k, info.curve)
  // Sampled a hair north of the foot: the foot's own row is the boundary with what's in front.
  const sp = spanAt(col, sy / T - 0.02)
  const hidden = !sp || sp.face || spanGround(sp, sy / T - 0.02).z > z + HIDE_ABOVE
  return { x, y: sy, hidden }
}

/** How much nearer (field px) the ground drawn over a sprite pixel must be before it covers it: a hair, so their own ground never does. */
export const COVER_PX = 2

/**
 * Partial see-through: which pixels of a sprite standing at field row
 * `fieldY` (px) are covered by nearer ground in the lift, over a rectangle
 * of screen pixels (w × h): 1 covered, 0 not. A pixel is covered when the
 * ground or face the lift draws there lies south of the sprite (nearer the
 * viewer) and stands more than HIDE_ABOVE above its feet (display's rule
 * for the feet, row by row): with the legs behind a ridge only the legs
 * are; the ground just in front of the toes on a slope never is. No lift:
 * nothing is.
 */
export function coveredPixels(info: TerrainView, fieldY: number, z: number, x0: number, y0: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  if (!info.lift) return out
  const f = info.field
  for (let x = 0; x < w; x++) {
    const wx = x0 + x
    if (wx < 0 || wx >= f.w * TILE_PX) continue
    const col = liftColumn(f, wx >> 4, ((wx & 15) + 0.5) / TILE_PX, info.pad, info.k, info.curve)
    let k = col.length - 1
    for (let y = 0; y < h; y++) {
      const s = (y0 + y + 0.5) / TILE_PX
      while (k >= 0 && col[k]!.s1 <= s) k--
      const sp = k >= 0 && col[k]!.s0 <= s ? col[k]! : null
      if (!sp) continue
      const g = sp.face ? null : spanGround(sp, s)
      const near = g ? (sp.ty + g.fy) * TILE_PX : (sp.ty + 1) * TILE_PX
      const top = g ? g.z : sp.zS
      if (near > fieldY + COVER_PX && top > z + HIDE_ABOVE) out[y * w + x] = 1
    }
  }
  return out
}

/** Covered pixels as runs down each column (x, y0, y1 exclusive), neighbouring columns with the same run merged into one rectangle. */
export function coverRects(mask: Uint8Array, x0: number, y0: number, w: number, h: number): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = []
  let open = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (let x = 0; x < w; x++) {
    const next = new Map<string, { x: number; y: number; w: number; h: number }>()
    let y = 0
    while (y < h) {
      if (!mask[y * w + x]) { y++; continue }
      const a = y
      while (y < h && mask[y * w + x]) y++
      const key = `${a},${y}`
      const r = open.get(key)
      if (r) { r.w++; next.set(key, r) } else { const nr = { x: x0 + x, y: y0 + a, w: 1, h: y - a }; out.push(nr); next.set(key, nr) }
    }
    open = next
  }
  return out
}

// ---------------------------------------------------------------- walking uphill

/** The gentle uphill slowdown at its most: 12% slower straight up the steepest walkable ground (slopes-lab-recommendations.md §6). */
export const UPHILL_CAP = 0.12

/**
 * How fast someone walks with slope gradient (gx, gy) underfoot going
 * (ux, uy): 1 on the flat and across the slope; slower uphill and faster
 * downhill by independently capped linear responses against MAX_WALK_SLOPE.
 * It depends only on the gradient and the direction, so turning hill and
 * walker together changes nothing.
 */
export function slopeFactor(gx: number, gy: number, ux: number, uy: number, uphill = UPHILL_CAP, downhill = 0): { up: number; k: number } {
  const len = Math.hypot(ux, uy)
  const along = len ? (gx * ux + gy * uy) / len : 0
  const up = Math.max(0, along)
  const down = Math.max(0, -along)
  return { up, k: 1 - clamp(uphill, 0, 0.8) * clamp(up / MAX_WALK_SLOPE, 0, 1) + clamp(downhill, 0, 0.2) * clamp(down / MAX_WALK_SLOPE, 0, 1) }
}

/** slopeFactor at field point (x, y) px of a field. */
export function uphillFactor(f: Field, x: number, y: number, ux: number, uy: number, uphill = UPHILL_CAP, downhill = 0): { gx: number; gy: number; up: number; k: number } {
  const [gx, gy] = fieldGradient(f, x, y)
  return { gx, gy, ...slopeFactor(gx, gy, ux, uy, uphill, downhill) }
}
