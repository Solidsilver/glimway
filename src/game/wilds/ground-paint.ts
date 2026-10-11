/**
 * The open map's ground painter (docs/design/open-map.md 2.5): every pixel
 * of the Wilds' floor is a pure function of its world pixel, the world seed,
 * the look and the tiles around it. So a chunk's image joins its
 * neighbours' with no seam: painted alone, with whatever neighbours are
 * loaded, two chunks agree on every pixel either could paint (the seam test
 * paints one chunk with a margin and compares it with the next one's
 * interior).
 *
 * The woods painter of 0.7 (ragged edges through a wobbly lens, the trodden
 * line sampled smoothly so a stepped route winds, shade by openness, sun
 * flecks, leaf litter in drifts, broken cobbles, still water, the white
 * quiet's pale drifts), now in world pixels, plus the open map's grounds:
 * meadow, the Wend's banks and fords, the Lantern Road's paving and laid
 * paths (both painted as trodden ground here; their tile art stands on top,
 * ./window-chunk.ts). Pure: it writes RGBA into a buffer, so node tests can
 * paint and time it. Tiles nothing is known about (past the frontier) read
 * as deep woods.
 */
import { TILE } from '../../lib/tile.ts'
import { latticeNoise, valueNoise } from './noise.ts'
import type { GroundPalette } from './wilds-looks.ts'
import { hash01 } from '../../lib/hash.ts'

type RGB = [number, number, number]

export type GroundCat = 'woods' | 'moss' | 'trodden' | 'road' | 'water' | 'meadow' | 'bank' | 'ford' | 'paving' | 'laid'

/** What the painter reads: the ground and solidity at any world tile (null: nothing known there). */
export interface GroundSource {
  ground(tx: number, ty: number): number | null
  solid(tx: number, ty: number): boolean
}

/** How a ground paints, and how much trodden line it carries. */
export interface GroundPaint {
  cat: GroundCat
  trail: number
}

/** TERRAIN id → its paint (./ground-table.ts builds it from content; the worker gets it with each job). */
export type PaintTable = readonly (readonly [number, GroundCat, number])[]

/** Content ground id → how it paints, and how much trodden line it carries. */
export const PAINT: Record<string, GroundPaint> = {
  woods: { cat: 'woods', trail: 0 },
  moss: { cat: 'moss', trail: 0 },
  verge: { cat: 'moss', trail: 0.2 },
  path: { cat: 'moss', trail: 1 },
  trodden: { cat: 'trodden', trail: 0 },
  road: { cat: 'road', trail: 0 },
  water: { cat: 'water', trail: 0 },
  meadow: { cat: 'meadow', trail: 0 },
  bank: { cat: 'bank', trail: 0 },
  ford: { cat: 'ford', trail: 0 },
  paving: { cat: 'paving', trail: 0 },
  'laid-stone': { cat: 'laid', trail: 0 },
  'laid-plank': { cat: 'laid', trail: 0 },
}

/** How a TERRAIN id paints by the table (unknown ids read as moss; nothing known, as deep woods). */
export function paintOf(table: PaintTable, terrain: number | null): GroundPaint {
  if (terrain === null) return PAINT.woods
  const row = table.find((r) => r[0] === terrain)
  return row ? { cat: row[1], trail: row[2] } : PAINT.moss
}

/** 4×4 Bayer matrix (0..15) for ordered dithering. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const bayer = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16

/** Tiles of context the painter reads around what it paints (the lens, the trail and the shade). */
const CONTEXT = 2

/**
 * Paint world pixels [x0, x0+w) × [y0, y0+h) into `out` (RGBA, row-major,
 * w×h). `seed` is the world's (fnv1a32 of its seed), so every chunk of a
 * world shares one set of fields.
 */
export function paintGround(out: Uint8ClampedArray, x0: number, y0: number, w: number, h: number, src: GroundSource, G: GroundPalette, seed: number, table: PaintTable): void {
  // The smooth fields, each read on a grid of 2^shift world pixels (they
  // barely move within one): worked out once for this patch, so a pixel
  // costs a lookup. The grid is the world's, so chunks still agree.
  const field = (salt: number, scale: number, shift: number) => {
    const gx0 = x0 >> shift
    const gy0 = y0 >> shift
    const gw = ((x0 + w - 1) >> shift) - gx0 + 1
    const gh = ((y0 + h - 1) >> shift) - gy0 + 1
    const noise = latticeNoise(seed ^ salt, scale, gx0 << shift, gy0 << shift, gw << shift, gh << shift)
    const grid = new Float32Array(gw * gh)
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) grid[j * gw + i] = noise((gx0 + i) << shift, (gy0 + j) << shift)
    return (wx: number, wy: number) => grid[((wy >> shift) - gy0) * gw + ((wx >> shift) - gx0)]!
  }
  const warpA7 = field(0x9e3779b9, 7, 1)
  const warpB7 = field(0x7f4a7c15, 7, 1)
  const shade18 = field(0x1b873593, 18, 2)
  const shade9 = field(0x1b873593, 9, 1)
  const dapple10 = field(0xcc9e2d51, 10, 1)
  const litter6 = field(0x2c1b3c6d, 6, 1)
  const quiet26 = field(0x6a09e667, 26, 2)

  // Tile context: categories, trails and openness, CONTEXT tiles past each side.
  const tx0 = Math.floor(x0 / TILE) - CONTEXT
  const ty0 = Math.floor(y0 / TILE) - CONTEXT
  const tw = Math.floor((x0 + w - 1) / TILE) - tx0 + 1 + CONTEXT
  const th = Math.floor((y0 + h - 1) / TILE) - ty0 + 1 + CONTEXT
  const cats: GroundCat[] = new Array(tw * th)
  const trails = new Float32Array(tw * th)
  const solids = new Uint8Array(tw * th)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const g = src.ground(tx0 + x, ty0 + y)
      const p = paintOf(table, g)
      cats[y * tw + x] = p.cat
      trails[y * tw + x] = p.trail
      solids[y * tw + x] = g === null || src.solid(tx0 + x, ty0 + y) ? 1 : 0
    }
  // Everything the painter reads lies within CONTEXT tiles of the patch (the
  // lens and the road's fray reach under a tile), so no index is clamped.
  const at = (tx: number, ty: number): number => (ty - ty0) * tw + (tx - tx0)
  // Openness per tile (share of the 3×3 that is walkable), sampled smoothly per pixel.
  const open = new Float32Array(tw * th)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      let n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(tw - 1, x + dx))
          const yy = Math.max(0, Math.min(th - 1, y + dy))
          if (!solids[yy * tw + xx]) n++
        }
      open[y * tw + x] = n / 9
    }
  const openAt = (wx: number, wy: number): number => {
    const fx = wx / TILE - 0.5
    const fy = wy / TILE - 0.5
    const x0t = Math.floor(fx)
    const y0t = Math.floor(fy)
    const ax = fx - x0t
    const ay = fy - y0t
    const a = open[at(x0t, y0t)] + (open[at(x0t + 1, y0t)] - open[at(x0t, y0t)]) * ax
    const b = open[at(x0t, y0t + 1)] + (open[at(x0t + 1, y0t + 1)] - open[at(x0t, y0t + 1)]) * ax
    return a + (b - a) * ay
  }
  const trailAt = (tx: number, ty: number) => trails[at(tx, ty)]
  const catAt = (tx: number, ty: number) => cats[at(tx, ty)]
  const solidAt = (tx: number, ty: number) => solids[at(tx, ty)] === 1

  for (let py = 0; py < h; py++) {
    const wy = y0 + py
    for (let px = 0; px < w; px++) {
      const wx = x0 + px
      // Ragged edges: look the category up through a wobbly lens.
      const jx = (warpA7(wx, wy) - 0.5) * 7 + (hash01(wx, wy, 1) - 0.5) * 1.5
      const jy = (warpB7(wx, wy) - 0.5) * 7 + (hash01(wx, wy, 2) - 0.5) * 1.5
      const ltx = Math.floor((wx + jx) / TILE)
      const lty = Math.floor((wy + jy) / TILE)
      let cat: GroundCat | 'path' = catAt(ltx, lty)
      let trail = 0
      if (cat === 'moss' || cat === 'woods' || cat === 'meadow') {
        const fx = (wx + jx * 0.6) / TILE - 0.5
        const fy = (wy + jy * 0.6) / TILE - 0.5
        const xa = Math.floor(fx)
        const ya = Math.floor(fy)
        const ax = fx - xa
        const ay = fy - ya
        const a = trailAt(xa, ya) + (trailAt(xa + 1, ya) - trailAt(xa, ya)) * ax
        const b = trailAt(xa, ya + 1) + (trailAt(xa + 1, ya + 1) - trailAt(xa, ya + 1)) * ax
        trail = a + (b - a) * ay
        if (trail > 0.5) cat = 'path'
      }
      const n = hash01(wx, wy, 5)
      const ramp = rampOf(G, cat)
      // Base tone: a soft low-frequency wash plus per-pixel grain.
      let level = 1.6 + (shade18(wx, wy) - 0.5) * 2.2 + (n - 0.5) * (cat === 'woods' ? 0.9 : 0.5)
      if (cat !== 'woods') {
        // Shade near the trees; sun-flecks where the canopy opens.
        const o = openAt(wx, wy)
        level += (o - 0.75) * 3.2
        if (dapple10(wx, wy) > 0.66 + (bayer(wx, wy) - 0.5) * 0.08) level += 1.2
        level += 1
      }
      let col: RGB = ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(level + (bayer(wx, wy) - 0.5) * 0.6)))]

      if (cat === 'woods') {
        // Leaf litter lies in drifts, not as even speckle.
        if (n < 0.35 && litter6(wx, wy) > G.litterAmount) col = G.litter[Math.floor(hash01(wx, wy, 6) * G.litter.length)]
        else if (n > 0.95) col = G.mossFleck[Math.floor(hash01(wx, wy, 7) * G.mossFleck.length)]
      } else if (cat === 'moss') {
        if (n > 0.96) col = G.grassFleck[Math.floor(hash01(wx, wy, 8) * G.grassFleck.length)]
        else if (n < 0.2 && litter6(wx, wy) > G.litterAmount + 0.1) col = G.litter[Math.floor(hash01(wx, wy, 6) * G.litter.length)]
      } else if (cat === 'meadow') {
        // Open grass: bright blade flecks, a few seed heads, no litter.
        if (n > 0.93) col = G.grassFleck[Math.floor(hash01(wx, wy, 8) * G.grassFleck.length)]
        else if (n < 0.04) col = G.meadow[0]
      } else if (cat === 'path' || cat === 'trodden' || cat === 'paving' || cat === 'laid') {
        // Moss creeps in at the trail's edge; pebbles and ruts on the tread.
        if (cat === 'path' && trail < 0.57 && n < 0.5) col = G.moss[Math.max(0, Math.min(5, Math.round(level)))]
        else if (n > 0.988) col = G.pebble
        else if (n < 0.012) col = ramp[0]
      } else if (cat === 'road') {
        // Broken cobbles: gaps grow toward the road's ragged edges.
        const fray = catAt(Math.floor((wx + jx * 1.8) / TILE), Math.floor((wy + jy * 1.8) / TILE)) !== 'road'
        col = (fray && n < 0.7 ? null : cobble(wx, wy, level, G)) ?? (solidAt(Math.floor(wx / TILE), Math.floor(wy / TILE)) ? G.woods : G.path)[Math.max(0, Math.min(4, Math.round(level - 0.5)))]
      } else if (cat === 'bank') {
        // Silt and grit by the water: darker where it's wet, a few pebbles.
        const wet = catAt(Math.floor((wx + jx * 2) / TILE), Math.floor((wy + jy * 2) / TILE)) === 'water'
        if (wet) col = G.bank[Math.max(0, Math.min(G.bank.length - 1, Math.round(level - 2)))]
        if (n > 0.982) col = G.pebble
      } else if (cat === 'water' || cat === 'ford') {
        // Still water: darker at the bank, a few bright ripple lines. A ford's
        // shallows are lighter; its stones are art (./window-chunk.ts).
        const o = openAt(wx, wy)
        const shallow = cat === 'ford' ? 1.5 : 0
        const t = Math.round(1.5 + shallow + (shade9(wx, wy) - 0.5) * 2 + o * 1.5 + (bayer(wx, wy) - 0.5) * 0.6)
        col = G.water[Math.max(0, Math.min(G.water.length - 2, t))]
        if (hash01(Math.floor(wx / 4), wy, 21) < 0.08 && ((wy % 3) + 3) % 3 === 0) col = G.water[G.water.length - 1]
      }
      const i = (py * w + px) * 4
      // The white quiet: pale drifts lying across the outer Wilds.
      if (G.mist && cat !== 'water' && cat !== 'ford') {
        const q = quiet26(wx, wy) + (bayer(wx, wy) - 0.5) * 0.08
        if (q > 0.62) {
          const a = q > 0.72 ? 0.28 : 0.15
          const m = G.mist
          out[i] = Math.round(col[0] + (m[0] - col[0]) * a)
          out[i + 1] = Math.round(col[1] + (m[1] - col[1]) * a)
          out[i + 2] = Math.round(col[2] + (m[2] - col[2]) * a)
          out[i + 3] = 255
          continue
        }
      }
      out[i] = col[0]
      out[i + 1] = col[1]
      out[i + 2] = col[2]
      out[i + 3] = 255
    }
  }
}

function rampOf(G: GroundPalette, cat: GroundCat | 'path'): RGB[] {
  switch (cat) {
    case 'paving':
    case 'laid':
      return G.trodden
    case 'ford':
      return G.water
    default:
      return G[cat]
  }
}

/** Broken cobbles of the old road: rows of stones, mossy joints, gaps. */
function cobble(wx: number, wy: number, level: number, G: GroundPalette): RGB | null {
  const row = Math.floor(wy / 5)
  const shift = (((row % 2) + 2) % 2) * 3
  const col = Math.floor((wx + shift) / 6)
  const cx = wx + shift - col * 6
  const cy = wy - row * 5
  if (hash01(col, row, 11) < 0.3) return null
  if (cx === 0 || cy === 0) return hash01(wx, wy, 12) < 0.7 ? G.jointMoss[Math.floor(hash01(wx, wy, 13) * 2)] : G.mortar
  // Moss grown over part of a stone.
  if (hash01(col, row, 15) < 0.25 && hash01(wx, wy, 16) < 0.6) return G.jointMoss[Math.floor(hash01(wx, wy, 17) * 2)]
  const tone = Math.round(level - 1 + (hash01(col, row, 14) - 0.5) * 2 + (cy === 1 ? 1 : cy === 4 ? -1 : 0))
  return G.road[Math.max(0, Math.min(G.road.length - 1, tone))]
}

// ---------------------------------------------------------------- the drift

/** The scene's clear colour (src/game/main.ts): the drift fogs into it. */
export const VOID: RGB = [0x24, 0x1f, 0x31]

/**
 * Paint the margin past the frontier (decision 22): a dim wash of the land
 * beyond (its main land's floor, from the near read's glimpse), and a dark
 * glinting line where the Wend runs on. The drift's trees go on top
 * (./tangle-art.ts paintDriftTrees), then `fogDrift`. Nothing here is
 * walkable.
 */
export function paintDrift(out: Uint8ClampedArray, x0: number, y0: number, w: number, h: number, G: GroundPalette, glimpse: { land: string; river: boolean } | null, seed: number): void {
  const shade = latticeNoise(seed ^ 0x1b873593, 22, x0, y0, w, h)
  const bend = valueNoise(seed ^ 0x3c6ef372)
  const ramp = glimpse?.land === 'meadow' ? G.meadow : G.woods
  const S = 24 * TILE
  for (let py = 0; py < h; py++) {
    const wy = y0 + py
    // The Wend running on: a band winding down each chunk (its middle, per row).
    let midChunk = NaN
    let mid = 0
    for (let px = 0; px < w; px++) {
      const wx = x0 + px
      const n = hash01(wx, wy, 31)
      const level = 1.5 + (shade(wx, wy) - 0.5) * 2.4 + (n - 0.5) * 0.8
      let col: RGB = ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(level + (bayer(wx, wy) - 0.5) * 0.6)))]
      if (glimpse?.river) {
        const chunkX = Math.floor(wx / S)
        if (chunkX !== midChunk) {
          midChunk = chunkX
          const along = (wy - Math.floor(wy / S) * S) / S
          mid = chunkX * S + S * (0.35 + bend(chunkX, along * 2) * 0.3)
        }
        const d = Math.abs(wx - mid)
        if (d < 22) col = G.water[d < 4 && hash01(wx >> 2, wy, 33) < 0.2 ? G.water.length - 1 : 1]
      }
      const i = (py * w + px) * 4
      out[i] = col[0]
      out[i + 1] = col[1]
      out[i + 2] = col[2]
      out[i + 3] = 255
    }
  }
}

/**
 * Fog the drift into the void in dithered steps, deeper the further past
 * the frontier: `dist(wx, wy)` is a pixel's distance from its edge.
 */
export function fogDrift(out: Uint8ClampedArray, x0: number, y0: number, w: number, h: number, dist: (wx: number, wy: number) => number): void {
  for (let py = 0; py < h; py++) {
    const wy = y0 + py
    for (let px = 0; px < w; px++) {
      const wx = x0 + px
      // Thin at the veil (the land beyond shows dimly), the void ten tiles out.
      const f = Math.min(1, Math.floor(Math.min(1, dist(wx, wy) / (10 * TILE)) * 5 + bayer(wx, wy)) / 5)
      const a = 0.22 + f * 0.74
      const i = (py * w + px) * 4
      out[i] = Math.round(out[i] + (VOID[0] - out[i]) * a)
      out[i + 1] = Math.round(out[i + 1] + (VOID[1] - out[i + 1]) * a)
      out[i + 2] = Math.round(out[i + 2] + (VOID[2] - out[i + 2]) * a)
      out[i + 3] = 255
    }
  }
}

// ---------------------------------------------------------------- off the main thread

/** The tiles a patch's painting reads, packed for a worker (ground -1: nothing known). */
export interface PackedGround {
  tx0: number
  ty0: number
  tw: number
  th: number
  ground: Int32Array
  solid: Uint8Array
}

/** Pack what painting [x0, x0+w) × [y0, y0+h) reads (the patch and CONTEXT tiles around it). */
export function packGround(src: GroundSource, x0: number, y0: number, w: number, h: number): PackedGround {
  const tx0 = Math.floor(x0 / TILE) - CONTEXT - 1
  const ty0 = Math.floor(y0 / TILE) - CONTEXT - 1
  const tw = Math.floor((x0 + w - 1) / TILE) - tx0 + CONTEXT + 2
  const th = Math.floor((y0 + h - 1) / TILE) - ty0 + CONTEXT + 2
  const ground = new Int32Array(tw * th)
  const solid = new Uint8Array(tw * th)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const g = src.ground(tx0 + x, ty0 + y)
      ground[y * tw + x] = g ?? -1
      solid[y * tw + x] = src.solid(tx0 + x, ty0 + y) ? 1 : 0
    }
  return { tx0, ty0, tw, th, ground, solid }
}

/** A packed patch read back as a ground source. */
export function unpackGround(p: PackedGround): GroundSource {
  const at = (tx: number, ty: number) => {
    const x = tx - p.tx0
    const y = ty - p.ty0
    return x >= 0 && y >= 0 && x < p.tw && y < p.th ? y * p.tw + x : -1
  }
  return {
    ground: (tx, ty) => {
      const i = at(tx, ty)
      const g = i < 0 ? -1 : p.ground[i]!
      return g < 0 ? null : g
    },
    solid: (tx, ty) => {
      const i = at(tx, ty)
      return i < 0 || p.solid[i] === 1
    },
  }
}
