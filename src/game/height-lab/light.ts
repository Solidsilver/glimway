/**
 * Height lab (dev only): light in a cave, as a property of the world. Pure,
 * no Phaser, so node tests read it.
 *
 * The cave is dark wherever no light reaches, the same wherever the hero
 * stands. Light comes from sources placed in the world:
 *  - daylight through each mouth, fading along the floor with the walked
 *    distance from the mouth (so it follows a tunnel round its bends);
 *  - crystals, each a soft round light that rock stops;
 *  - open air: where the cave layer has nothing (in front of a mouth), you
 *    look out at the lit surface;
 *  - the hero's own light, which moves with them (./scene.ts takes it out
 *    of the dark round them each frame).
 * The first three make one still field, baked once into an image of the
 * dark (LIGHT_RES world px a texel). The scene draws that image and erases
 * the hero's light from it.
 */
import { CAVE, DX, DY, KIND, ROWS_PER_LEVEL, SURFACE, TILE_PX, step, type Dir, type Layer, type Stack } from './levels.ts'

/** World px a texel of the dark image. */
export const LIGHT_RES = 4

/** The most the dark hides (a little of the floor always shows in pitch dark). */
export const DARK_MAX = 0.97

/** A crystal's light: its reach in tiles, and how bright it is at its foot. */
export const CRYSTAL_REACH = 5.5
export const CRYSTAL_POWER = 0.95

/** A light source in the cave (tile middles; z: its floor's level). */
export interface Glow {
  tx: number
  ty: number
  z: number
  color: number
}

/**
 * Walked tiles along the cave's floor from the tiles just inside a mouth
 * (0 there; walls take the nearest floor's, and what no floor reaches is
 * FAR), as a field to sample. Sets the cave's `sky` (daylight,
 * gone `skyTiles` in) and `seen` (what the surface sees of someone there:
 * the arch only).
 */
export function daylight(stack: Stack, skyTiles: number): Float32Array {
  const cave = stack.layers[CAVE]!
  const size = stack.w * stack.h
  const dist = new Int32Array(size).fill(-1)
  const queue: number[] = []
  for (const [key, to] of stack.portals) {
    if (to !== CAVE) continue
    const d = key & 3
    const t = key >> 2
    if (Math.floor(t / size) !== SURFACE) continue
    const tx = ((t % size) % stack.w) + DX[d]
    const ty = Math.floor((t % size) / stack.w) + DY[d]
    const i = ty * cave.w + tx
    if (dist[i] === 0) continue
    dist[i] = 0
    queue.push(i)
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!
    const tx = i % cave.w
    const ty = Math.floor(i / cave.w)
    for (let d = 0; d < 4; d++) {
      if (step(stack, CAVE, tx, ty, d as Dir) !== CAVE) continue
      const j = (ty + DY[d]) * cave.w + tx + DX[d]
      if (dist[j]! >= 0) continue
      dist[j] = dist[i]! + 1
      queue.push(j)
    }
  }
  cave.sky.fill(0)
  cave.seen.fill(0)
  for (let i = 0; i < size; i++) {
    if (dist[i]! < 0) continue
    cave.sky[i] = Math.max(0, 1 - dist[i]! / skyTiles)
    cave.seen[i] = dist[i] === 0 ? 1 : dist[i] === 1 ? 0.5 : 0
  }
  // Walls take the most daylight of the floor beside them, so light
  // sampled between tiles doesn't dip at the walls.
  spreadToWalls(cave, cave.sky, dist)
  // The walked distance as a field to sample between tiles: walls take
  // the nearest floor's, and what no floor reaches is far.
  const walk = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    if (dist[i]! >= 0) {
      walk[i] = dist[i]!
      continue
    }
    const tx = i % cave.w
    const ty = Math.floor(i / cave.w)
    let best = FAR
    for (let d = 0; d < 4; d++) {
      const x = tx + DX[d]
      const y = ty + DY[d]
      if (x >= 0 && y >= 0 && x < cave.w && y < cave.h && dist[y * cave.w + x]! >= 0) best = Math.min(best, dist[y * cave.w + x]!)
    }
    walk[i] = best
  }
  return walk
}

/** The walked distance where no floor reaches. */
const FAR = 99

function spreadToWalls(l: Layer, field: Float32Array, dist: Int32Array): void {
  const src = field.slice()
  for (let ty = 0; ty < l.h; ty++)
    for (let tx = 0; tx < l.w; tx++) {
      const i = ty * l.w + tx
      if (dist[i]! >= 0) continue
      let best = 0
      for (let d = 0; d < 4; d++) {
        const x = tx + DX[d]
        const y = ty + DY[d]
        if (x >= 0 && y >= 0 && x < l.w && y < l.h && dist[y * l.w + x]! >= 0) best = Math.max(best, src[y * l.w + x]!)
      }
      field[i] = Math.max(field[i]!, best)
    }
}

/**
 * Open air: the surface in front of each mouth, and everything at or
 * below it that joins it without climbing. Where the cave layer has
 * nothing there, you look out of the cave at daylit land.
 */
export function openAir(stack: Stack, top: Int8Array): Uint8Array {
  const size = stack.w * stack.h
  const open = new Uint8Array(size)
  for (const [key, to] of stack.portals) {
    if (to !== CAVE) continue
    const t = key >> 2
    if (Math.floor(t / size) !== SURFACE) continue
    const start = t % size
    const level = top[start]!
    if (open[start]) continue
    const queue = [start]
    open[start] = 1
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!
      const tx = i % stack.w
      const ty = Math.floor(i / stack.w)
      for (let d = 0; d < 4; d++) {
        const x = tx + DX[d]
        const y = ty + DY[d]
        if (x < 0 || y < 0 || x >= stack.w || y >= stack.h) continue
        const j = y * stack.w + x
        if (open[j] || top[j]! > level) continue
        open[j] = 1
        queue.push(j)
      }
    }
  }
  return open
}

/** Light passes over floor, water and the cave's own drops; rock and the nothing past it stop it. */
function clear(l: Layer, i: number): boolean {
  const k = l.kind[i]
  return k === KIND.flat || k === KIND.slope || k === KIND.water || k === KIND.face
}

/** Whether a straight line between two tile middles stays over clear tiles (its ends needn't be). */
function sightLine(l: Layer, ax: number, ay: number, bx: number, by: number): boolean {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 3)
  let last = -1
  for (let s = 1; s < n; s++) {
    const tx = Math.floor(ax + 0.5 + ((bx - ax) * s) / n)
    const ty = Math.floor(ay + 0.5 + ((by - ay) * s) / n)
    if (tx === bx && ty === by) break
    const i = ty * l.w + tx
    if (i === last) continue
    last = i
    if (!clear(l, i)) return false
  }
  return true
}

/** A cave tile's floor level (a drop: its foot; rock and water: the nearest floor's), for light and for drawing by level. */
export function caveLevels(l: Layer): Int8Array {
  const out = new Int8Array(l.w * l.h)
  const known = new Uint8Array(l.w * l.h)
  const queue: number[] = []
  for (let i = 0; i < l.w * l.h; i++) {
    const k = l.kind[i]
    let z = Number.NaN
    if (k === KIND.flat) z = Math.round(l.edge[i * 4]!)
    else if (k === KIND.slope) {
      let lo = Infinity
      for (let d = 0; d < 4; d++) {
        const e = l.edge[i * 4 + d]!
        if (!Number.isNaN(e)) lo = Math.min(lo, e)
      }
      z = Math.floor(lo + 0.001)
    } else if (k === KIND.face) z = l.faceTop[i]! - l.faceRows[i]! / ROWS_PER_LEVEL
    if (Number.isNaN(z)) continue
    out[i] = Math.round(z)
    known[i] = 1
    queue.push(i)
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!
    const tx = i % l.w
    const ty = Math.floor(i / l.w)
    for (let d = 0; d < 4; d++) {
      const x = tx + DX[d]
      const y = ty + DY[d]
      if (x < 0 || y < 0 || x >= l.w || y >= l.h) continue
      const j = y * l.w + x
      if (known[j]) continue
      known[j] = 1
      out[j] = out[i]!
      queue.push(j)
    }
  }
  return out
}

/**
 * The still light on each tile of the cave layer, 0–1: daylight, crystals
 * (each fading with distance, a level of height counting as two tiles, and
 * stopped by rock), and open air where the layer has nothing.
 */
export function stillLight(stack: Stack, top: Int8Array, glows: readonly Glow[]): Float32Array {
  const cave = stack.layers[CAVE]!
  const size = stack.w * stack.h
  const air = openAir(stack, top)
  const levels = caveLevels(cave)
  const out = new Float32Array(size)
  const reach = Math.ceil(CRYSTAL_REACH)
  // What's still dark after each source: 1 − light, multiplied up.
  const dark = new Float32Array(size).fill(1)
  for (let i = 0; i < size; i++) {
    if (cave.kind[i] === KIND.none) dark[i] = air[i] ? 0 : 1
    else dark[i] = 1 - cave.sky[i]!
  }
  for (const g of glows) {
    for (let ty = g.ty - reach; ty <= g.ty + reach; ty++)
      for (let tx = g.tx - reach; tx <= g.tx + reach; tx++) {
        if (tx < 0 || ty < 0 || tx >= cave.w || ty >= cave.h) continue
        const i = ty * cave.w + tx
        if (cave.kind[i] === KIND.none) continue
        const r = Math.hypot(tx - g.tx, ty - g.ty) + Math.abs(levels[i]! - g.z) * 2
        if (r >= CRYSTAL_REACH) continue
        if (!sightLine(cave, g.tx, g.ty, tx, ty)) continue
        const k = 1 - r / CRYSTAL_REACH
        dark[i] = dark[i]! * (1 - CRYSTAL_POWER * k * k)
      }
  }
  for (let i = 0; i < size; i++) out[i] = 1 - dark[i]!
  return out
}

/** The still dark as texels (LIGHT_RES px each, row by row): 0 clear, up to DARK_MAX; softened by a short blur. */
export interface DarkMap {
  w: number
  h: number
  a: Float32Array
}

export function darkMap(stack: Stack, light: Float32Array): DarkMap {
  const per = TILE_PX / LIGHT_RES
  const w = stack.w * per
  const h = stack.h * per
  let a = new Float32Array(w * h)
  // Bilinear between tile middles.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = (x + 0.5) / per - 0.5
      const gy = (y + 0.5) / per - 0.5
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const fx = gx - x0
      const fy = gy - y0
      const at = (tx: number, ty: number) => light[Math.min(stack.h - 1, Math.max(0, ty)) * stack.w + Math.min(stack.w - 1, Math.max(0, tx))]!
      const l = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
      a[y * w + x] = (1 - l) * DARK_MAX
    }
  // Two passes of a 5-texel box blur, across then down.
  for (let pass = 0; pass < 2; pass++)
    for (const across of [true, false]) {
      const b = new Float32Array(w * h)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0
          let n = 0
          for (let k = -2; k <= 2; k++) {
            const xx = across ? x + k : x
            const yy = across ? y : y + k
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
            s += a[yy * w + xx]!
            n++
          }
          b[y * w + x] = s / n
        }
      a = b
    }
  return { w, h, a }
}

/** The still dark at a world point (bilinear between texels). */
export function darkAt(m: DarkMap, x: number, y: number): number {
  const gx = x / LIGHT_RES - 0.5
  const gy = y / LIGHT_RES - 0.5
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0
  const at = (tx: number, ty: number) => m.a[Math.min(m.h - 1, Math.max(0, ty)) * m.w + Math.min(m.w - 1, Math.max(0, tx))]!
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
}

/** The hero's own light, close: clear out to INNER px, gone at OUTER. Wide is the same, LIGHT_SCALE times as far; none is none. */
export const HERO_INNER = 30
export const HERO_OUTER = 80
export const LIGHT_SCALE = { lantern: 1, wide: 1.8, dim: 0 } as const
export type HeroLight = keyof typeof LIGHT_SCALE

const smooth = (t: number) => t * t * (3 - 2 * t)

/** How much of the dark the hero's light takes away at `r` px from them, 0–1. */
export function heroLight(kind: HeroLight, r: number): number {
  const s = LIGHT_SCALE[kind]
  if (!s) return 0
  return 1 - smooth(Math.max(0, Math.min(1, (r / s - HERO_INNER) / (HERO_OUTER - HERO_INNER))))
}

/**
 * How far into the cave view the hero is, 0–1: from the surface's view at
 * the arch to the cave's over `tiles` walked tiles. This is the crossfade
 * between the two views, not a dimmer: once it's 1 the dark is the world's.
 */
export function caveView(walked: number, tiles: number): number {
  return Math.max(0, Math.min(1, walked / Math.max(0.01, tiles)))
}

/**
 * The dark drawn at a world point while the hero is in the cave: the
 * still dark, less the hero's light round them, faded in with the view.
 */
export function shownDark(m: DarkMap, x: number, y: number, hero: { x: number; y: number }, light: HeroLight, view: number): number {
  return view * darkAt(m, x, y) * (1 - heroLight(light, Math.hypot(x - hero.x, y - hero.y)))
}
