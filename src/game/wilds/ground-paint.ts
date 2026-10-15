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
 *
 * Fixed ground (the town and the lots: docs/design/hearthwick-2.md 4, 5)
 * is painted here too, by its own rows of the table (./fixed-ground.ts),
 * with two grounds of its own: the town's cobbles, with a worn verge where
 * grass meets them, and tilled fields in furrows. It is settled ground: the
 * white quiet's drifts thin out over it.
 */
import { TILE } from '../../lib/tile.ts'
import { latticeNoise, smoothField, valueNoise } from './noise.ts'
import type { GroundPalette } from './wilds-looks.ts'
import { hash01 } from '../../lib/hash.ts'

type RGB = [number, number, number]

export type GroundCat = 'woods' | 'moss' | 'trodden' | 'road' | 'water' | 'meadow' | 'bank' | 'ford' | 'paving' | 'laid' | 'cobble' | 'tilled'

/** What the painter reads: the ground and solidity at any world tile (null: nothing known there). */
export interface GroundSource {
  ground(tx: number, ty: number): number | null
  solid(tx: number, ty: number): boolean
}

/** How a ground paints, how much trodden line it carries, and whether it is settled (fixed ground: no white quiet). */
export interface GroundPaint {
  cat: GroundCat
  trail: number
  settled?: boolean
}

/**
 * Paint id → its paint, its trodden line and (1) whether it is settled
 * (./ground-table.ts builds it from content and ./fixed-ground.ts; the
 * worker gets it with each job).
 */
export type PaintTable = readonly (readonly [number, GroundCat, number, number?])[]

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
  return row ? { cat: row[1], trail: row[2], ...(row[3] ? { settled: true } : {}) } : PAINT.moss
}

/** 4×4 Bayer matrix (0..15) for ordered dithering. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const bayer = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16

/**
 * Tiles of context the painter reads around what it paints: the lens and
 * the bilinear reads reach a tile, the 5×5 blurs of openness and of the
 * meadow two more.
 */
const CONTEXT = 4

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
  const shade9 = field(0x1b873593, 9, 1)
  const litter6 = field(0x2c1b3c6d, 6, 1)
  // The broad fields (shade, sun flecks, the white quiet) are rotated two-octave
  // noise, so their thresholds make soft shapes, never squares on a lattice.
  const shade18 = smoothField(seed ^ 0x1b873593, 22, x0, y0, w, h, 4)
  const dapple10 = smoothField(seed ^ 0xcc9e2d51, 12, x0, y0, w, h, 4)
  const quiet26 = smoothField(seed ^ 0x6a09e667, 30, x0, y0, w, h, 8)

  // Tile context: categories, trails and openness, CONTEXT tiles past each side.
  const tx0 = Math.floor(x0 / TILE) - CONTEXT
  const ty0 = Math.floor(y0 / TILE) - CONTEXT
  const tw = Math.floor((x0 + w - 1) / TILE) - tx0 + 1 + CONTEXT
  const th = Math.floor((y0 + h - 1) / TILE) - ty0 + 1 + CONTEXT
  const rows = new Map<number, GroundPaint>()
  const paintAt = (g: number | null): GroundPaint => {
    if (g === null) return PAINT.woods
    let p = rows.get(g)
    if (!p) rows.set(g, (p = paintOf(table, g)))
    return p
  }
  const cats: GroundCat[] = new Array(tw * th)
  const trails = new Float32Array(tw * th)
  const trods = new Float32Array(tw * th)
  const waters = new Float32Array(tw * th)
  const banks = new Float32Array(tw * th)
  const woodses = new Float32Array(tw * th)
  const pavings = new Float32Array(tw * th)
  const cobbles = new Float32Array(tw * th)
  const tilleds = new Float32Array(tw * th)
  // The Wilds (1) or settled ground (0): the white quiet lies only on the Wilds.
  const wilds = new Float32Array(tw * th)
  const solids = new Uint8Array(tw * th)
  // Meadow or not, where a tile says (-1: a path, water or the like says nothing).
  const meadowSays = new Float32Array(tw * th)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const g = src.ground(tx0 + x, ty0 + y)
      const p = paintAt(g)
      const k = y * tw + x
      cats[k] = p.cat
      trails[k] = p.trail
      trods[k] = p.cat === 'trodden' ? 1 : 0
      waters[k] = p.cat === 'water' || p.cat === 'ford' ? 1 : 0
      banks[k] = p.cat === 'bank' ? 1 : 0
      woodses[k] = p.cat === 'woods' ? 1 : 0
      pavings[k] = p.cat === 'paving' ? 1 : 0
      cobbles[k] = p.cat === 'cobble' ? 1 : 0
      tilleds[k] = p.cat === 'tilled' ? 1 : 0
      wilds[k] = p.settled ? 0 : 1
      solids[k] = g === null || src.solid(tx0 + x, ty0 + y) ? 1 : 0
      meadowSays[k] = p.cat === 'meadow' ? 1 : (p.cat === 'moss' && p.trail === 0) || p.cat === 'woods' ? 0 : -1
    }
  // 5×5 blurs (weights 1 2 3 2 1 each way), clamped at the context's rim.
  const blur = (value: (k: number) => number, weight: (k: number) => number): Float32Array => {
    const W = [1, 2, 3, 2, 1]
    const out = new Float32Array(tw * th)
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        let sum = 0
        let wsum = 0
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const xx = Math.max(0, Math.min(tw - 1, x + dx))
            const yy = Math.max(0, Math.min(th - 1, y + dy))
            const k = yy * tw + xx
            const wgt = W[dx + 2]! * W[dy + 2]! * weight(k)
            sum += value(k) * wgt
            wsum += wgt
          }
        out[y * tw + x] = wsum > 0 ? sum / wsum : 0
      }
    return out
  }
  // How much of the land around is meadow: grass blends from the woods' moss
  // into meadow over a few tiles, never tile by tile.
  const meadowness = blur((k) => meadowSays[k]!, (k) => (meadowSays[k]! < 0 ? 0 : 1))
  // The woods' floor shows where the woods stand together: a lone solid tile in
  // the open (a stone, a lamp stone, a stump) keeps the grass under it.
  const woodsFloor = new Float32Array(tw * th)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      let sum = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(tw - 1, x + dx))
          const yy = Math.max(0, Math.min(th - 1, y + dy))
          sum += woodses[yy * tw + xx]! * (dx ? 1 : 2) * (dy ? 1 : 2)
        }
      woodsFloor[y * tw + x] = sum / 16
    }
  // Everything the painter reads lies within CONTEXT tiles of the patch (the
  // lens and the road's fray reach under a tile), so no index is clamped.
  const at = (tx: number, ty: number): number => (ty - ty0) * tw + (tx - tx0)
  // Openness: how walkable the 5×5 around a tile is, sampled smoothly per pixel
  // (ground near the trees sits in their shade).
  const open = blur((k) => 1 - solids[k]!, () => 1)
  /** A per-tile field read smoothly at a world point (bilinear between tile centres). */
  const smooth = (f: Float32Array, wx: number, wy: number): number => {
    const fx = wx / TILE - 0.5
    const fy = wy / TILE - 0.5
    const x0t = Math.floor(fx)
    const y0t = Math.floor(fy)
    const ax = fx - x0t
    const ay = fy - y0t
    const k = at(x0t, y0t)
    const a = f[k]! + (f[k + 1]! - f[k]!) * ax
    const b = f[k + tw]! + (f[k + tw + 1]! - f[k + tw]!) * ax
    return a + (b - a) * ay
  }
  const openAt = (wx: number, wy: number): number => smooth(open, wx, wy)
  // How wild the land around is (the white quiet thins over a few tiles into settled ground).
  const wildness = G.mist ? blur((k) => wilds[k]!, () => 1) : null
  // The town's setts: the road's stone warmed toward the earth between them.
  const setts = G.road.map((c, i) => mix(c, G.trodden[Math.min(i, G.trodden.length - 1)]!, 0.45))
  const catAt = (tx: number, ty: number) => cats[at(tx, ty)]
  const solidAt = (tx: number, ty: number) => solids[at(tx, ty)] === 1

  // The bilinear weights at a pixel's lens point, shared by every field read there.
  let rk = 0
  let w00 = 0
  let w10 = 0
  let w01 = 0
  let w11 = 0
  const read = (f: Float32Array) => f[rk]! * w00 + f[rk + 1]! * w10 + f[rk + tw]! * w01 + f[rk + tw + 1]! * w11

  for (let py = 0; py < h; py++) {
    const wy = y0 + py
    for (let px = 0; px < w; px++) {
      const wx = x0 + px
      // Ragged edges: look the category up through a wobbly lens.
      const jx = (warpA7(wx, wy) - 0.5) * 7 + (hash01(wx, wy, 1) - 0.5) * 1.5
      const jy = (warpB7(wx, wy) - 0.5) * 7 + (hash01(wx, wy, 2) - 0.5) * 1.5
      const ltx = Math.floor((wx + jx) / TILE)
      const lty = Math.floor((wy + jy) / TILE)
      let cat: GroundCat | 'path' | 'grass' = catAt(ltx, lty)
      let trail = 0
      // Everything but the old cobbles and laid paths is decided from smooth
      // per-tile fields read through the lens, never tile by tile: the river
      // and its banks, the woods' floor, the road's bed, the trodden line
      // (paths wind), trodden earth (camps' edges are soft); what is left is
      // grass, moss blending into meadow with the land around.
      let grassMeadow = false
      if (cat !== 'road' && cat !== 'laid' && cat !== 'cobble') {
        const sx = wx + jx * 0.6
        const sy = wy + jy * 0.6
        // One set of bilinear weights for every field at this point.
        const fx = sx / TILE - 0.5
        const fy = sy / TILE - 0.5
        const xt = Math.floor(fx)
        const yt = Math.floor(fy)
        const ax = fx - xt
        const ay = fy - yt
        rk = at(xt, yt)
        w00 = (1 - ax) * (1 - ay)
        w10 = ax * (1 - ay)
        w01 = (1 - ax) * ay
        w11 = ax * ay
        const edge = 0.5 + (bayer(wx, wy) - 0.5) * 0.12
        if (read(waters) > edge) cat = cat === 'ford' || catAt(Math.floor(sx / TILE), Math.floor(sy / TILE)) === 'ford' ? 'ford' : 'water'
        else if (read(banks) > edge) cat = 'bank'
        else if (read(woodsFloor) > edge) cat = 'woods'
        else if (read(pavings) > edge) cat = 'paving'
        else if (read(tilleds) > edge) cat = 'tilled'
        else if ((trail = read(trails)) > 0.5) cat = 'path'
        else if (read(trods) > edge) cat = 'trodden'
        // A worn verge where grass meets the town's cobbles.
        else if (read(cobbles) > 0.14 + bayer(wx, wy) * 0.3) cat = 'trodden'
        else {
          cat = 'grass'
          const m = read(meadowness)
          const t = m * m * (3 - 2 * m)
          grassMeadow = t > bayer(wx, wy) * 0.9 + 0.05
        }
      }
      const n = hash01(wx, wy, 5)
      const ramp = cat === 'grass' ? (grassMeadow ? G.meadow : G.moss) : rampOf(G, cat)
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
      } else if (cat === 'grass' && !grassMeadow) {
        // Moss: a few bright flecks, some litter blown in from the trees.
        if (n > 0.96) col = G.grassFleck[Math.floor(hash01(wx, wy, 8) * G.grassFleck.length)]
        else if (n < 0.2 && litter6(wx, wy) > G.litterAmount + 0.1) col = G.litter[Math.floor(hash01(wx, wy, 6) * G.litter.length)]
      } else if (cat === 'grass') {
        // Meadow: bright blade flecks, a few seed heads, no litter.
        if (n > 0.93) col = G.grassFleck[Math.floor(hash01(wx, wy, 8) * G.grassFleck.length)]
        else if (n < 0.04) col = G.meadow[0]
      } else if (cat === 'path' || cat === 'trodden' || cat === 'paving' || cat === 'laid') {
        // Grass creeps in at the trail's edge; pebbles and ruts on the tread.
        if (cat === 'path' && trail < 0.57 && n < 0.5) {
          const m = smooth(meadowness, wx, wy)
          col = (m > bayer(wx, wy) ? G.meadow : G.moss)[Math.max(0, Math.min(5, Math.round(level)))]
        }
        else if (n > 0.988) col = G.pebble
        else if (n < 0.012) col = ramp[0]
      } else if (cat === 'cobble') {
        // The town's setts: tidy rows, broken only where the lens frays the edge.
        const fray = catAt(Math.floor((wx + jx * 1.8) / TILE), Math.floor((wy + jy * 1.8) / TILE)) !== 'cobble'
        col = fray && n < 0.4 ? G.trodden[Math.max(0, Math.min(5, Math.round(level - 0.5)))] : sett(wx, wy, level, setts, G)
      } else if (cat === 'tilled') {
        col = furrow(wx, wy, level, n, G)
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
        // Still water: darker at the bank, a few bright ripple lines. A ford is
        // the river's own water; its stepping stones are art (./window-chunk.ts).
        const o = openAt(wx, wy)
        const t = Math.round(1.5 + (shade9(wx, wy) - 0.5) * 2 + o * 1.5 + (bayer(wx, wy) - 0.5) * 0.6)
        col = G.water[Math.max(0, Math.min(G.water.length - 2, t))]
        if (hash01(Math.floor(wx / 4), wy, 21) < 0.08 && ((wy % 3) + 3) % 3 === 0) col = G.water[G.water.length - 1]
      }
      const i = (py * w + px) * 4
      // The white quiet: pale drifts lying across the outer Wilds.
      if (wildness && G.mist && cat !== 'water' && cat !== 'ford') {
        const q = quiet26(wx, wy) + (bayer(wx, wy) - 0.5) * 0.08
        if (q > 0.62 + (1 - smooth(wildness, wx, wy)) * 0.6) {
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
    case 'tilled':
      return G.trodden
    case 'cobble':
      return G.road
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

const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]

/** Size of the cells the town's setts are scattered on (world px). */
const SETT = 6

/**
 * The town's cobbles: rounded stones of uneven size (each the pixels nearest
 * one point of a jittered grid), lit from the upper left, earth in the
 * joints and now and then moss.
 */
function sett(wx: number, wy: number, level: number, setts: RGB[], G: GroundPalette): RGB {
  const gx = Math.floor(wx / SETT)
  const gy = Math.floor(wy / SETT)
  let d1 = Infinity
  let d2 = Infinity
  let sx = 0
  let sy = 0
  let ox = 0
  let oy = 0
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = gx + i
      const cy = gy + j
      const dx = wx + 0.5 - (cx + 0.2 + hash01(cx, cy, 44) * 0.6) * SETT
      const dy = wy + 0.5 - (cy + 0.2 + hash01(cx, cy, 45) * 0.6) * SETT
      const d = dx * dx + dy * dy
      if (d < d1) {
        d2 = d1
        d1 = d
        sx = cx
        sy = cy
        ox = dx
        oy = dy
      } else if (d < d2) d2 = d
    }
  // The joint: where two stones are nearly as near.
  if (Math.sqrt(d2) - Math.sqrt(d1) < 1.1) return hash01(wx, wy, 41) < 0.14 ? G.jointMoss[Math.floor(hash01(wx, wy, 43) * 2)]! : G.trodden[Math.max(0, Math.min(5, Math.round(level - 1.8)))]!
  const lit = ox + oy < -2.2 ? 0.9 : ox + oy > 2.2 ? -0.7 : 0
  const tone = Math.round(level - 0.2 + (hash01(sx, sy, 42) - 0.5) * 1.6 + lit)
  return setts[Math.max(0, Math.min(setts.length - 1, tone))]!
}

/** Tilled ground: furrows running east–west, a dark trench between ridges of turned earth, a few shoots on the ridges. */
function furrow(wx: number, wy: number, level: number, n: number, G: GroundPalette): RGB {
  const f = (((wy + Math.round((hash01(wx >> 3, wy >> 3, 51) - 0.5) * 1.2)) % 5) + 5) % 5
  const at = (ramp: RGB[], l: number) => ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(l)))]!
  if (f === 0) return at(G.path, level - 2.5)
  if (f === 4) return at(G.path, level - 1.2)
  if (f === 2 && n > 0.86) return at(G.moss, level + 0.5)
  return at(G.trodden, level + (f === 1 ? 0.6 : 0))
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
