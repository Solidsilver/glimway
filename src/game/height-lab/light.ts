/**
 * Height lab (dev only): the cave's light, as a property of the world, in
 * the terms of the lighting system (./lighting.ts). Pure, no Phaser, so
 * node tests read it.
 *
 * What the cave gives the lighting:
 *  - ambient per tile: a low cave dark; daylight through each mouth, fading
 *    along the floor with the walked distance from the mouth (so it follows
 *    a tunnel round its bends); open air (where the cave layer has nothing
 *    in front of a mouth, and the cliff faces above that land) at full
 *    daylight; the hill over your head (nothing, not open air) at none;
 *  - occluders: rock stops light; floor, water and the cave's drops don't;
 *  - levels: each tile's floor level;
 *  - sources: the crystals (still), the hero's own light and the remote
 *    player's lantern (moving; ./scene.ts).
 */
import { CAVE, DX, DY, KIND, ROWS_PER_LEVEL, SURFACE, step, type Dir, type Layer, type Stack } from './levels.ts'
import type { LightSource } from './lighting.ts'

/** World px a texel of the light. */
export const LIGHT_RES = 4

/** A cave's own light where nothing reaches (a little of the floor always shows). */
export const CAVE_AMBIENT: readonly [number, number, number] = [0.05, 0.045, 0.07]

/** Daylight's colour (the surface's ambient, and what spills in through a mouth). */
export const DAYLIGHT: readonly [number, number, number] = [1, 1, 1]

/** A crystal's light: its reach in px, full out to inner, how bright. */
export const CRYSTAL = { radius: 6 * 16, inner: 10, intensity: 0.95 } as const

/** A light source in the cave (tile middles; z: its floor's level). */
export interface Glow {
  tx: number
  ty: number
  z: number
  color: number
}

/** The hero's own light: close, wide, or "none" (a faint glow that keeps the hero readable, not the floor). */
export const HERO_LIGHT = {
  lantern: { radius: 80, inner: 30, intensity: 1, color: 0xffe6bf },
  wide: { radius: 144, inner: 54, intensity: 1, color: 0xffe6bf },
  dim: { radius: 22, inner: 6, intensity: 0.6, color: 0xffe6bf }
} as const
export type HeroLight = keyof typeof HERO_LIGHT

/** The remote player's lantern. */
export const FRIEND_LIGHT = { radius: 64, inner: 18, intensity: 0.9, color: 0xffcf8a } as const

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
 * Open air, 0–1 a tile: the land you see out of a cave's mouths. From each
 * mouth, the surface at or below its foot that joins it without climbing,
 * full out to OPEN_AIR.full walked tiles and gone OPEN_AIR.fade further on
 * (so the land over a cave's far rooms, beyond the rim, isn't sunny from
 * inside). A cliff face takes the open air of the land at its foot. Where
 * the cave layer has nothing, you see this land, daylit.
 */
export const OPEN_AIR = { full: 16, fade: 6 } as const

export function openAir(stack: Stack, top: Int8Array): Float32Array {
  const size = stack.w * stack.h
  const open = new Float32Array(size)
  const reach = OPEN_AIR.full + OPEN_AIR.fade
  for (const [key, to] of stack.portals) {
    if (to !== CAVE) continue
    const t = key >> 2
    if (Math.floor(t / size) !== SURFACE) continue
    const start = t % size
    const level = top[start]!
    const dist = new Map<number, number>([[start, 0]])
    const queue = [start]
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!
      const d = dist.get(i)!
      const k = d <= OPEN_AIR.full ? 1 : 1 - (d - OPEN_AIR.full) / OPEN_AIR.fade
      open[i] = Math.max(open[i]!, k * k * (3 - 2 * k))
      if (d >= reach) continue
      const tx = i % stack.w
      const ty = Math.floor(i / stack.w)
      for (let dir = 0; dir < 4; dir++) {
        const x = tx + DX[dir]
        const y = ty + DY[dir]
        if (x < 0 || y < 0 || x >= stack.w || y >= stack.h) continue
        const j = y * stack.w + x
        if (dist.has(j) || top[j]! > level) continue
        dist.set(j, d + 1)
        queue.push(j)
      }
    }
  }
  // A cliff face stands in the open air of the land at its foot: from
  // inside a mouth you see the sunny face round the arch, not rock.
  const surface = stack.layers[SURFACE]!
  const isFace = (i: number) => surface.kind[i] === KIND.face || surface.kind[i] === KIND.mouth
  for (let i = 0; i < size; i++) {
    if (!isFace(i)) continue
    let j = i
    while (j + stack.w < size && isFace(j)) j += stack.w
    open[i] = Math.max(open[i]!, open[j]!)
  }
  return open
}

/** Light passes over floor, water and the cave's own drops; rock and the nothing past it stop it. */
export function caveStops(l: Layer): Uint8Array {
  const out = new Uint8Array(l.w * l.h)
  for (let i = 0; i < l.w * l.h; i++) {
    const k = l.kind[i]
    out[i] = k === KIND.flat || k === KIND.slope || k === KIND.water || k === KIND.face ? 0 : 1
  }
  return out
}

/** The cave layer's ambient per tile (r, g, b): cave dark plus daylight from the mouths; open air lit; the hill over you, none. */
export function caveAmbient(stack: Stack, air: Float32Array): Float32Array {
  const cave = stack.layers[CAVE]!
  const size = stack.w * stack.h
  const out = new Float32Array(size * 3)
  for (let i = 0; i < size; i++) {
    for (let c = 0; c < 3; c++) {
      let v: number
      // Nothing, or the cave's rock where it lies behind a sunny cliff
      // face (the rock round an arch, not painted): the open air's light.
      if (cave.kind[i] === KIND.none || sunnyFaceRock(stack, air, i)) v = air[i]! * DAYLIGHT[c]!
      else v = CAVE_AMBIENT[c]! + cave.sky[i]! * DAYLIGHT[c]!
      out[i * 3 + c] = Math.min(1, v)
    }
  }
  return out
}

/**
 * The cave's rock where it lies behind a sunny cliff face round an arch:
 * not painted, lit as the face. Not where a tunnel runs just behind the
 * face's top (the face's rows are then the tunnel's south wall, seen from
 * inside), unless it's right beside the arch.
 */
export function sunnyFaceRock(stack: Stack, air: Float32Array, i: number): boolean {
  const surface = stack.layers[SURFACE]!
  const cave = stack.layers[CAVE]!
  const isFace = (j: number) => surface.kind[j] === KIND.face || surface.kind[j] === KIND.mouth
  if (cave.kind[i] !== KIND.rock || !isFace(i) || !(air[i]! > 0)) return false
  const w = stack.w
  const tx = i % w
  const ty = Math.floor(i / w)
  for (let y = ty - 1; y <= ty + 1; y++)
    for (let x = tx - 1; x <= tx + 1; x++) if (x >= 0 && y >= 0 && x < w && y < stack.h && surface.kind[y * w + x] === KIND.mouth) return true
  // Up the face to its top, then the tile behind it.
  let j = i
  while (j - w >= 0 && isFace(j)) j -= w
  const k = cave.kind[j]
  return k !== KIND.flat && k !== KIND.slope && k !== KIND.water
}

/** A crystal as a light source. */
export function crystalLight(g: Glow, i: number, tile: number): LightSource {
  return { id: `crystal-${i}`, x: g.tx * tile + tile / 2, y: g.ty * tile + tile / 2, layer: CAVE, z: g.z, color: g.color, ...CRYSTAL, moving: false }
}

/**
 * How far into the cave view the hero is, 0–1: from the surface's view at
 * the arch to the cave's over `tiles` walked tiles. This is the crossfade
 * between the two views' light, not a dimmer: once it's 1 the light is the
 * cave's own.
 */
export function caveView(walked: number, tiles: number): number {
  return Math.max(0, Math.min(1, walked / Math.max(0.01, tiles)))
}

/**
 * A cave tile's floor level, smooth: a flat floor's height; a ramp's at its
 * middle (its open edges' mean), so levels change evenly along every ramp
 * with no step at whole levels; a drop's down its face; rock and water the
 * nearest floor's. For light (a level's difference costs reach) and the
 * depth darkening (./lighting.ts).
 */
export function caveLevels(l: Layer): Float32Array {
  const out = new Float32Array(l.w * l.h)
  const known = new Uint8Array(l.w * l.h)
  const queue: number[] = []
  for (let i = 0; i < l.w * l.h; i++) {
    const k = l.kind[i]
    let z = Number.NaN
    if (k === KIND.flat) z = l.edge[i * 4]!
    else if (k === KIND.slope) {
      let sum = 0
      let n = 0
      for (let d = 0; d < 4; d++) {
        const e = l.edge[i * 4 + d]!
        if (Number.isNaN(e)) continue
        sum += e
        n++
      }
      z = sum / n
    } else if (k === KIND.face) z = l.faceTop[i]! - (l.faceRow[i]! + 0.5) / ROWS_PER_LEVEL
    if (Number.isNaN(z)) continue
    out[i] = z
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
 * The ways into a cave's view, switched in the dev panel (./look.ts):
 *  - blend: round 4's, even over the crossfade's tiles;
 *  - eased: over two tiles more, eased in and out;
 *  - stages: the light first (the hill over you goes dark, the cave's own
 *    light comes up), then the cave's floors come in under it;
 *  - iris: the cave's view opens from the mouth outward, a circle.
 */
export type WayIn = 'blend' | 'eased' | 'stages' | 'iris'

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

/**
 * How far into the cave's view, from the walked tiles since the arch: the
 * light (the cave's over the surface's) and the cave's floors (their
 * alpha). For the iris, how far the circle has opened (0–1), both the same.
 */
export function wayIn(walked: number, tiles: number, way: WayIn): { light: number; alpha: number } {
  const t = Math.max(0.01, tiles)
  if (way === 'eased') {
    const s = smooth(walked / (t + 2))
    return { light: s, alpha: s }
  }
  if (way === 'stages') {
    const p = walked / (t + 1)
    return { light: smooth(p / 0.55), alpha: smooth((p - 0.4) / 0.6) }
  }
  if (way === 'iris') {
    const s = smooth(walked / t)
    return { light: s, alpha: s }
  }
  const b = caveView(walked, tiles)
  return { light: b, alpha: b }
}

/**
 * How much the cave's image covers, per texel (`res` px a side), 0–1: its
 * floors, drops and water fully, the rock round them fully near them and
 * fading out smoothly with distance (not tile by tile) to nothing at the
 * edge of what's drawn. The image's alpha, and where the light's cap
 * (./lighting.ts) applies: the two agree, so the cave's edge is soft as
 * it comes in over the hill (it was hard, tile-aligned slabs of rock).
 */
export const COVER_FADE = { from: 1.5, to: 2.75 } as const

export function caveCover(stack: Stack, air: Float32Array, tile: number, res: number): Float32Array {
  const cave = stack.layers[CAVE]!
  const per = tile / res
  const tw = cave.w * per
  const th = cave.h * per
  let dist = new Float32Array(tw * th).fill(1e9)
  const tileOf = (x: number, y: number) => Math.floor(y / per) * cave.w + Math.floor(x / per)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const k = cave.kind[tileOf(x, y)]
      if (k === KIND.flat || k === KIND.slope || k === KIND.water || k === KIND.face) dist[y * tw + x] = 0
    }
  // Chamfer distance (texels), two passes.
  const D = Math.SQRT2
  const relax = (x: number, y: number, dx: number, dy: number, c: number) => {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= tw || ny >= th) return
    const v = dist[ny * tw + nx]! + c
    if (v < dist[y * tw + x]!) dist[y * tw + x] = v
  }
  const distancePass = () => {
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        relax(x, y, -1, 0, 1)
        relax(x, y, 0, -1, 1)
        relax(x, y, -1, -1, D)
        relax(x, y, 1, -1, D)
      }
    for (let y = th - 1; y >= 0; y--)
      for (let x = tw - 1; x >= 0; x--) {
        relax(x, y, 1, 0, 1)
        relax(x, y, 0, 1, 1)
        relax(x, y, 1, 1, D)
        relax(x, y, -1, 1, D)
      }
  }
  distancePass()
  const floorDist = dist
  dist = new Float32Array(tw * th).fill(1e9)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++)
      if (cave.kind[tileOf(x, y)] === KIND.none || sunnyFaceRock(stack, air, tileOf(x, y))) dist[y * tw + x] = 0
  distancePass()
  const out = new Float32Array(tw * th)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const i = tileOf(x, y)
      if (cave.kind[i] === KIND.none || sunnyFaceRock(stack, air, i)) continue
      // Distance from a texel's middle to the floor's edge, in tiles.
      const d = Math.max(0, floorDist[y * tw + x]! - 0.5) / per
      const f = Math.max(0, Math.min(1, (d - COVER_FADE.from) / (COVER_FADE.to - COVER_FADE.from)))
      // Fade toward every unpainted edge, including the sunny face at a cliff lip.
      const lip = smooth(Math.max(0, dist[y * tw + x]! - 0.5) / per / (COVER_FADE.to - COVER_FADE.from))
      out[y * tw + x] = Math.min(1 - f * f * (3 - 2 * f), cave.kind[i] === KIND.rock ? lip : 1)
    }
  return out
}
