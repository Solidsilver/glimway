/**
 * Height lab (dev only): real surface levels, as data and rules. Pure, no
 * Phaser, so node tests walk it.
 *
 * Everything is in screen-space tiles (the 3/4 view the game draws): a
 * cliff's face takes up tiles on the ground in front of it, ROWS_PER_LEVEL
 * rows a level, so nothing walkable ever hides behind higher land.
 *
 * A tile says how high each of its four edges is (in levels; NaN: no way
 * across that edge). You can cross from one tile to the next when the two
 * edges you cross meet at the same height. That one rule gives cliffs
 * (heights differ), ramps and winding trails (a tile whose edges differ),
 * and faces (every edge closed). A layer is one such grid; the surface is
 * one, a cave is another sharing the same x/y. A portal on an edge says the
 * tile across it is on another layer: the cave mouth.
 */

/** Rows of cliff face a level of height takes (16 px each: a level is 48 px). */
export const ROWS_PER_LEVEL = 3

export const TILE_PX = 16

/** Directions: north, east, south, west. */
export type Dir = 0 | 1 | 2 | 3
export const N: Dir = 0
export const E: Dir = 1
export const S: Dir = 2
export const W: Dir = 3
export const DX = [0, 1, 0, -1] as const
export const DY = [-1, 0, 1, 0] as const
export const opposite = (d: Dir): Dir => ((d + 2) & 3) as Dir

/** What a tile is, for drawing (walking reads only the edges). */
export const KIND = {
  /** Nothing here (a cave layer outside its rock). */
  none: 0,
  flat: 1,
  /** A ramp or trail: edges at different heights. */
  slope: 2,
  /** Cliff face: closed. */
  face: 3,
  /** The dark opening of a cave mouth in a face: closed on the surface, open on the cave's layer. */
  mouth: 4,
  water: 5,
  /** Cave rock (inside the hill): closed. */
  rock: 6,
  /** A tree or boulder stands here: closed. */
  prop: 7
} as const
export type Kind = (typeof KIND)[keyof typeof KIND]

export interface Layer {
  name: 'surface' | 'cave'
  w: number
  h: number
  kind: Uint8Array
  /** Edge heights, 4 a tile (n, e, s, w), in levels; NaN: closed. */
  edge: Float32Array
  /** Ground palette index (./area.ts GROUNDS). */
  ground: Uint8Array
  /** Daylight reaching the tile, 0–1 (1 everywhere on the surface). */
  sky: Float32Array
  /** How much of someone standing here the surface sees, 0–1 (1 on the surface; in a cave, only the mouth's arch). */
  seen: Float32Array
  /** Face tiles: the face's top level, its row from the top, and how many rows it has. */
  faceTop: Float32Array
  faceRow: Int8Array
  faceRows: Int8Array
}

export interface Stack {
  w: number
  h: number
  layers: Layer[]
  /** Portal edges: key (portalKey) → the layer across that edge. */
  portals: Map<number, number>
}

export function newLayer(name: Layer['name'], w: number, h: number): Layer {
  const n = w * h
  return {
    name,
    w,
    h,
    kind: new Uint8Array(n),
    edge: new Float32Array(n * 4).fill(Number.NaN),
    ground: new Uint8Array(n),
    sky: new Float32Array(n).fill(name === 'surface' ? 1 : 0),
    seen: new Float32Array(n).fill(name === 'surface' ? 1 : 0),
    faceTop: new Float32Array(n),
    faceRow: new Int8Array(n).fill(-1),
    faceRows: new Int8Array(n)
  }
}

export const portalKey = (stack: Stack, layer: number, tx: number, ty: number, d: Dir): number => ((layer * stack.h + ty) * stack.w + tx) * 4 + d

export function inside(l: { w: number; h: number }, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < l.w && ty < l.h
}

export function edgeAt(l: Layer, tx: number, ty: number, d: Dir): number {
  return inside(l, tx, ty) ? l.edge[(ty * l.w + tx) * 4 + d]! : Number.NaN
}

export function setFlat(l: Layer, tx: number, ty: number, z: number, kind: Kind = KIND.flat): void {
  const i = ty * l.w + tx
  l.kind[i] = kind
  l.edge.fill(z, i * 4, i * 4 + 4)
}

export function setClosed(l: Layer, tx: number, ty: number, kind: Kind): void {
  const i = ty * l.w + tx
  l.kind[i] = kind
  l.edge.fill(Number.NaN, i * 4, i * 4 + 4)
}

export function walkable(l: Layer, tx: number, ty: number): boolean {
  if (!inside(l, tx, ty)) return false
  const i = (ty * l.w + tx) * 4
  for (let d = 0; d < 4; d++) if (!Number.isNaN(l.edge[i + d]!)) return true
  return false
}

const EPS = 0.01

/**
 * Whether you can step from a tile across its edge `d`, and onto which
 * layer: the layer index, or -1 when the way is shut (an edge closed on
 * either side, or the heights don't meet).
 */
export function step(stack: Stack, layer: number, tx: number, ty: number, d: Dir): number {
  const here = stack.layers[layer]!
  const a = edgeAt(here, tx, ty, d)
  if (Number.isNaN(a)) return -1
  const to = stack.portals.get(portalKey(stack, layer, tx, ty, d)) ?? layer
  const b = edgeAt(stack.layers[to]!, tx + DX[d], ty + DY[d], opposite(d))
  return !Number.isNaN(b) && Math.abs(a - b) < EPS ? to : -1
}

/**
 * The height of the ground at a point in a tile (fx, fy: 0–1 across it):
 * its open edges' heights, each weighted by how near the point is (inverse
 * distance), so a ramp rises smoothly and a turning trail bends. NaN on a
 * closed tile.
 */
export function zIn(l: Layer, tx: number, ty: number, fx: number, fy: number): number {
  if (!inside(l, tx, ty)) return Number.NaN
  const i = (ty * l.w + tx) * 4
  const dist = [fy, 1 - fx, 1 - fy, fx]
  let sum = 0
  let wsum = 0
  for (let d = 0; d < 4; d++) {
    const h = l.edge[i + d]!
    if (Number.isNaN(h)) continue
    const dd = dist[d]!
    if (dd < 1e-4) return h
    const w = 1 / dd
    sum += h * w
    wsum += w
  }
  return wsum ? sum / wsum : Number.NaN
}

/** Someone on the levels: feet at (x, y) in world px, on a layer, with a foot box (half width, height). */
export interface Walker {
  x: number
  y: number
  layer: number
  hw: number
  fh: number
}

const tileOf = (px: number) => Math.floor(px / TILE_PX)

/** The tile a walker stands on: the middle of their foot box. */
export function standTile(w: { x: number; y: number; fh: number }): [number, number] {
  return [tileOf(w.x), tileOf(w.y - w.fh / 2)]
}

export function zAt(stack: Stack, w: Walker): number {
  const [tx, ty] = standTile(w)
  const fx = w.x / TILE_PX - tx
  const fy = (w.y - w.fh / 2) / TILE_PX - ty
  return zIn(stack.layers[w.layer]!, tx, ty, fx, fy)
}

/** Which way a neighbouring tile lies (-1: not a side neighbour). */
function dirTo(ax: number, ay: number, bx: number, by: number): Dir | -1 {
  for (let d = 0; d < 4; d++) if (ax + DX[d] === bx && ay + DY[d] === by) return d as Dir
  return -1
}

/**
 * Does the foot box fit at (x, y), coming from the walker's tile? The
 * layer it would stand on, or -1. The middle of the box may move one tile
 * at a time (a step); every other tile the box touches must be reachable
 * from the middle's tile in one step (a corner: through either side).
 */
export function fits(stack: Stack, w: Walker, x: number, y: number): number {
  const [cx, cy] = standTile(w)
  const nx = tileOf(x)
  const ny = tileOf(y - w.fh / 2)
  let layer = w.layer
  if (nx !== cx || ny !== cy) {
    const d = dirTo(cx, cy, nx, ny)
    if (d < 0) return -1
    layer = step(stack, layer, cx, cy, d as Dir)
    if (layer < 0) return -1
  }
  if (!walkable(stack.layers[layer]!, nx, ny)) return -1
  const x0 = tileOf(x - w.hw)
  const x1 = tileOf(x + w.hw - 0.001)
  const y0 = tileOf(y - w.fh)
  const y1 = tileOf(y - 0.001)
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (tx === nx && ty === ny) continue
      const d = dirTo(nx, ny, tx, ty)
      if (d >= 0) {
        if (step(stack, layer, nx, ny, d as Dir) < 0) return -1
        continue
      }
      // A corner: through the side tile in x, or the one in y.
      const viaX = step(stack, layer, nx, ny, tx > nx ? E : W)
      const viaY = step(stack, layer, nx, ny, ty > ny ? S : N)
      const okX = viaX >= 0 && step(stack, viaX, tx, ny, ty > ny ? S : N) >= 0
      const okY = viaY >= 0 && step(stack, viaY, nx, ty, tx > nx ? E : W) >= 0
      if (!okX && !okY) return -1
    }
  return layer
}

/**
 * Move a walker by (dx, dy), one axis at a time so it slides along what
 * stops it; in steps of at most half a tile. What it was blocked by, per axis.
 */
export function move(stack: Stack, w: Walker, dx: number, dy: number): { bx: boolean; by: boolean } {
  let bx = false
  let by = false
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (TILE_PX / 2)))
  for (let i = 0; i < n; i++) {
    if (dx) {
      const l = fits(stack, w, w.x + dx / n, w.y)
      if (l >= 0) {
        w.x += dx / n
        w.layer = l
      } else bx = true
    }
    if (dy) {
      const l = fits(stack, w, w.x, w.y + dy / n)
      if (l >= 0) {
        w.y += dy / n
        w.layer = l
      } else by = true
    }
  }
  return { bx, by }
}

export interface Node {
  layer: number
  tx: number
  ty: number
}

/** Shortest walk between two tiles by steps (breadth first; null: no way). */
export function findPath(stack: Stack, from: Node, to: Node, limit = 20000): Node[] | null {
  const size = stack.w * stack.h
  const key = (n: Node) => n.layer * size + n.ty * stack.w + n.tx
  const prev = new Map<number, number>()
  const start = key(from)
  const goal = key(to)
  prev.set(start, -1)
  const queue = [start]
  for (let qi = 0; qi < queue.length && qi < limit; qi++) {
    const k = queue[qi]!
    if (k === goal) break
    const layer = Math.floor(k / size)
    const tx = (k % size) % stack.w
    const ty = Math.floor((k % size) / stack.w)
    for (let d = 0; d < 4; d++) {
      const l = step(stack, layer, tx, ty, d as Dir)
      if (l < 0) continue
      const nk = key({ layer: l, tx: tx + DX[d], ty: ty + DY[d] })
      if (prev.has(nk)) continue
      prev.set(nk, k)
      queue.push(nk)
    }
  }
  if (!prev.has(goal)) return null
  const out: Node[] = []
  for (let k = goal; k !== -1; k = prev.get(k)!) out.push({ layer: Math.floor(k / size), tx: (k % size) % stack.w, ty: Math.floor((k % size) / stack.w) })
  return out.reverse()
}

/** A layer's value at a world point, bilinear between tile middles (sky, seen). */
export function sample(l: Layer, field: Float32Array, x: number, y: number): number {
  const gx = x / TILE_PX - 0.5
  const gy = y / TILE_PX - 0.5
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0
  const at = (tx: number, ty: number) => {
    const cx = Math.min(l.w - 1, Math.max(0, tx))
    const cy = Math.min(l.h - 1, Math.max(0, ty))
    return field[cy * l.w + cx]!
  }
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
  return top * (1 - fy) + bottom * fy
}
