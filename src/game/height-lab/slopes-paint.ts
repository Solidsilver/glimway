/** Dev-only slope albedo: material and cliff faces. Sun light lives in ../terrain/sun-map.ts. */
import { TERRAIN } from '../../lib/tile.ts'
import { wildsGround } from '../../lib/wilds/data.ts'
import { fnv1a32 } from '../../lib/hash.ts'
import { paintGround } from '../wilds/ground-paint.ts'
import { groundTable } from '../wilds/ground-table.ts'
import { wildsLook } from '../wilds/wilds-looks.ts'
import { G, GROUNDS, SURFACE, type LabArea } from './area.ts'
import { DX, DY, KIND, TILE_PX } from './levels.ts'
import { liftColumn, spanGround, type Field, type Span } from './slopes.ts'
import { cliffMaterial, cragMaterial, hash, heightTint, steepMaterial } from '../terrain/material.ts'


type RGB = [number, number, number]
const T = TILE_PX

const mix = (a: number, b: number, t: number) => a + (b - a) * t
const hexRGB = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]

/** Fog bands: a level image every half level. */
export const BAND = 0.5
export const bandOf = (z: number) => Math.floor(z / BAND + 1e-4) * BAND



/** The painter's terrain for each of the slopes area's grounds (its own tints are this file's). */
const SPECIAL: Partial<Record<string, keyof typeof TERRAIN>> = { 'tops-scree': 'stone_b', 'tops-crag': 'stone_a', 'wq-stone': 'stone_a', 'tops-path': 'path_a' }

/** The field's ground, painted and shaded, over a rectangle of field pixels: RGBA, and each pixel's height. */
export function paintField(area: LabArea, x0: number, y0: number, w: number, h: number): { px: Uint8ClampedArray; z: Float32Array } {
  const info = area.slopes!
  const f = info.field
  const look = wildsLook('outer', 'Carting')
  const terrain = GROUNDS.map((g) => {
    const special = SPECIAL[g]
    if (special) return TERRAIN[special]
    return g.startsWith('cave') || g.startsWith('tops') || g.startsWith('wq') ? TERRAIN.dirt : (TERRAIN as Record<string, number>)[wildsGround(g).terrain]!
  })
  const tileAt = (tx: number, ty: number) => Math.min(f.h - 1, Math.max(0, ty)) * f.w + Math.min(f.w - 1, Math.max(0, tx))
  const src = { ground: (tx: number, ty: number) => terrain[f.ground[tileAt(tx, ty)]!]!, solid: () => false }
  const px = new Uint8ClampedArray(w * h * 4)
  paintGround(px, x0, y0, w, h, src, look.ground, fnv1a32('height-lab-slopes'), groundTable())

  // Height at every pixel (and a ring round it), each from its own tile's corners.
  const M = 9
  const zw = w + 2 * M
  const zh = h + 2 * M
  const zg = new Float32Array(zw * zh)
  for (let y = 0; y < zh; y++)
    for (let x = 0; x < zw; x++) {
      const wx = Math.min(f.w * T - 1, Math.max(0, x0 + x - M))
      const wy = Math.min(f.h * T - 1, Math.max(0, y0 + y - M))
      zg[y * zw + x] = zPx(f, wx, wy)
    }
  const zAt = (x: number, y: number) => zg[(y + M) * zw + x + M]!
  const scree = hexRGB('#aa9f8e')
  const sand = hexRGB('#c4c2b2')
  const surface = area.stack.layers[SURFACE]!
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const wx = x0 + x
      const wy = y0 + y
      const tx = Math.min(f.w - 1, wx >> 4)
      const ty = Math.min(f.h - 1, wy >> 4)
      const i = ty * f.w + tx
      // A cliff's footprint (closed in every style; drawn as talus, under the face when unlifted).
      const talus = surface.kind[i] === KIND.face
      const kind = talus ? KIND.steep : f.kind[i]!
      const ground = f.ground[i]!
      const o = (y * w + x) * 4
      let r = px[o]!
      let g = px[o + 1]!
      let b = px[o + 2]!
      const tint = (c: RGB, k: number) => {
        r = mix(r, c[0], k)
        g = mix(g, c[1], k)
        b = mix(b, c[2], k)
      }
      const z = zAt(x, y)
      // The slope across a tile's width round the pixel: smooth over tile borders (a tile's own is a constant,
      // and shading by it stripes); the tile's own where that spans a cliff.
      let gx = zAt(x + 8, y) - zAt(x - 8, y)
      let gy = zAt(x, y + 8) - zAt(x, y - 8)
      if (Math.abs(gx) > 1 || Math.abs(gy) > 1) [gx, gy] = gradPx(f, Math.min(f.w * T - 1, wx), Math.min(f.h * T - 1, wy))
      const c: RGB = [r, g, b]
      if (ground === G.bank) {
        // The sea's stand-in: pale sand flats with ripples.
        tint(sand, 0.45)
        const ripple = (wy + Math.round(Math.sin(wx / 9) * 2)) % 7
        if (ripple === 0) tint([226, 230, 226], 0.4)
        else if (ripple === 1) tint([128, 136, 140], 0.15)
        c[0] = r
        c[1] = g
        c[2] = b
      } else heightTint(c, z, wx, wy)
      if (kind === KIND.steep) {
        // A rim of loose stones where the walkable ground ends.
        const fx = wx & 15
        const fy = wy & 15
        let rimOff = -1
        for (let d = 0; d < 4; d++) {
          const nx = tx + DX[d]
          const ny = ty + DY[d]
          if (nx < 0 || ny < 0 || nx >= f.w || ny >= f.h) continue
          const nk = f.kind[ny * f.w + nx]!
          if (nk !== KIND.flat && nk !== KIND.slope && nk !== KIND.prop) continue
          if (surface.kind[ny * f.w + nx] === KIND.face) continue
          const off = d === 0 ? fy : d === 1 ? 15 - fx : d === 2 ? 15 - fy : fx
          if (rimOff < 0 || off < rimOff) rimOff = off
        }
        steepMaterial(c, wx, wy, gx, gy, z, talus, rimOff)
      } else if (kind === KIND.crag) cragMaterial(c, wx, wy, gx, gy, z)
      r = c[0]
      g = c[1]
      b = c[2]
      if (kind === KIND.steep || kind === KIND.crag) {
        // Their own stone (../terrain/material.ts).
      } else if (ground === G['tops-path']) {
        // The rocky path: flat stones of the scree's own stone, laid (scree has streaks down the fall line and loose
        // stones): each stone a jittered 9 px cell's nearest pixels, its own shade, a dark joint round it, lit on its
        // north-west side, worn smooth (no grit).
        const [stoneId, edge] = flagstone(wx, wy)
        const v = hash(stoneId, 0, 35)
        const c = scree.map((ch) => ch * (0.95 + v * 0.13)) as RGB
        r = c[0]
        g = c[1]
        b = c[2]
        if (edge < 0.45) tint([95, 90, 82], 0.45)
      }
      px[o] = r
      px[o + 1] = g
      px[o + 2] = b
      px[o + 3] = 255
    }
  const zs = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) zs[y * w + x] = zAt(x, y)
  return { px, z: zs }
}

/** Flagstones: the stone (a cell id) a pixel is in, how far it is from the stone's edge (px), and whether that edge is its north-west side. */
function flagstone(wx: number, wy: number): [number, number, boolean] {
  const S = 9
  const cx = Math.floor(wx / S)
  const cy = Math.floor(wy / S)
  let best = Infinity
  let second = Infinity
  let id = 0
  let bx = 0
  let by = 0
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx
      const gy = cy + dy
      const px = (gx + 0.2 + hash(gx, gy, 37) * 0.6) * S
      const py = (gy + 0.2 + hash(gx, gy, 38) * 0.6) * S
      const d = Math.hypot(wx + 0.5 - px, wy + 0.5 - py)
      if (d < best) {
        second = best
        best = d
        id = gx * 7919 + gy
        bx = px
        by = py
      } else if (d < second) second = d
    }
  // Distance to the edge with the next stone, roughly half the difference of the two nearest.
  return [id, (second - best) / 2, wx + 0.5 - bx + (wy + 0.5 - by) < 0]
}

/** A field pixel's height, from its tile's corners. */
function zPx(f: Field, wx: number, wy: number): number {
  const tx = wx >> 4
  const ty = wy >> 4
  const fx = ((wx & 15) + 0.5) / T
  const fy = ((wy & 15) + 0.5) / T
  const i = (ty * f.w + tx) * 4
  const c = f.corner
  const n = c[i]! + (c[i + 1]! - c[i]!) * fx
  const s = c[i + 3]! + (c[i + 2]! - c[i + 3]!) * fx
  return n + (s - n) * fy
}

/** A field pixel's slope (levels a tile, east and south). */
function gradPx(f: Field, wx: number, wy: number): [number, number] {
  const tx = wx >> 4
  const ty = wy >> 4
  const fx = ((wx & 15) + 0.5) / T
  const fy = ((wy & 15) + 0.5) / T
  const i = (ty * f.w + tx) * 4
  const c = f.corner
  return [(c[i + 1]! - c[i]!) * (1 - fy) + (c[i + 2]! - c[i + 3]!) * fy, (c[i + 3]! - c[i]!) * (1 - fx) + (c[i + 2]! - c[i + 1]!) * fx]
}

/** The paint cache's key (./slopes-art.ts) for a chunk of the area as it's drawn: every setting that paints (the lift). */
export function chunkKey(area: LabArea, cx: number, cy: number): string {
  const l = area.slopes!.look
  return `${l.lift}|${cx},${cy}`
}

/** A part of the map (tiles, inclusive). */
export interface SlopesPart {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One half level's image of a part: its pixels and where they go (world px). */
export interface BandPixels {
  band: number
  x: number
  y: number
  w: number
  h: number
  px: Uint8ClampedArray
}

/** Tile rows (flat) or columns (lift) per step; narrow strips limit cold-paint tails. */
const STRIP = 1

/**
 * One part of the slopes area's surface as the view shows it (RGBA, the
 * part's size), and each pixel's height (NaN: nothing), painted a strip at a
 * time: each `yield` is a point where the scene may stop until the next
 * frame (./scene.ts keeps painting under a time budget).
 */
export function* paintPartSteps(area: LabArea, part: SlopesPart): Generator<void, { px: Uint8ClampedArray; z: Float32Array }> {
  const info = area.slopes!
  const f = info.field
  const l = info.view
  const W = (part.x1 - part.x0 + 1) * T
  const H = (part.y1 - part.y0 + 1) * T
  const ox = part.x0 * T
  const oy = part.y0 * T
  const px = new Uint8ClampedArray(W * H * 4)
  const zp = new Float32Array(W * H).fill(Number.NaN)
  if (!info.lift) {
    for (let r = part.y0; r <= part.y1; r += STRIP) {
      const rows = Math.min(STRIP, part.y1 - r + 1)
      const g = paintField(area, ox, r * T, W, rows * T)
      px.set(g.px, (r - part.y0) * T * W * 4)
      zp.set(g.z, (r - part.y0) * T * W)
      yield
    }
    for (let ty = part.y0; ty <= part.y1; ty++) for (let tx = part.x0; tx <= part.x1; tx++) {
      const i = ty * l.w + tx
      if (l.kind[i] !== KIND.face) continue
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        const at = ((ty - part.y0) * T + y) * W + (tx - part.x0) * T + x
        const z = l.faceTop[i]! - (l.faceRow[i]! + (y + 0.5) / T) / 3
        const color = cliffMaterial(tx * T + x, z, l.faceTop[i]!)
        for (let c = 0; c < 3; c++) px[at * 4 + c] = color[c]!
        px[at * 4 + 3] = 255
        zp[at] = z
      }
    }
  } else {
    for (let c = part.x0; c <= part.x1; c += STRIP) {
      const cols = Math.min(STRIP, part.x1 - c + 1)
      const sw = cols * T
      // Each pixel column's runs, and the field rows their ground in this part comes from (every pixel column's own:
      // a tile's middle column alone missed rows, and the painting clamped to what it had, in streaks).
      const spans: Span[][] = []
      let gy0 = f.h
      let gy1 = -1
      for (let x = 0; x < sw; x++) {
        const wx = c * T + x
        const col = liftColumn(f, wx >> 4, ((wx & 15) + 0.5) / T, info.pad, info.k)
        spans.push(col)
        for (const sp of col)
          if (!sp.face && sp.s1 > oy / T && sp.s0 < (oy + H) / T) {
            gy0 = Math.min(gy0, sp.ty)
            gy1 = Math.max(gy1, sp.ty)
          }
      }
      // Faces and nothing need no ground.
      if (gy1 < 0) gy0 = gy1 = 0
      const gh = (gy1 - gy0 + 1) * T
      const painted = paintField(area, c * T, gy0 * T, sw, gh)
      for (let x = 0; x < sw; x++) {
        const wx = c * T + x
        const col = spans[x]!
        let k = col.length - 1
        const px0 = wx - ox
        for (let y = 0; y < H; y++) {
          const s = (oy + y + 0.5) / T
          while (k >= 0 && col[k]!.s1 <= s) k--
          const sp = k >= 0 && col[k]!.s0 <= s ? col[k]! : null
          const o = (y * W + px0) * 4
          if (!sp) continue
          if (sp.face) {
            // Unlit cliff material: level strata and occasional cracks.
            const down = (s - sp.s0) / Math.max(1e-6, sp.s1 - sp.s0)
            const zf = sp.zS - down * (sp.zS - sp.zBot)
            const color = cliffMaterial(wx, zf, sp.zS)
            for (let c = 0; c < 3; c++) px[o + c] = color[c]!
            px[o + 3] = 255
            zp[y * W + px0] = zf
            continue
          }
          const gy = Math.floor((sp.ty + spanGround(sp, s).fy) * T) - gy0 * T
          const from = Math.min(gh - 1, Math.max(0, gy)) * sw + x
          px[o] = painted.px[from * 4]!
          px[o + 1] = painted.px[from * 4 + 1]!
          px[o + 2] = painted.px[from * 4 + 2]!
          px[o + 3] = 255
          zp[y * W + px0] = painted.z[from]!
        }
      }
      yield
    }
  }
  return { px, z: zp }
}

/** One part, painted in one go (node previews, tests). */
export function paintPart(area: LabArea, part: SlopesPart): { px: Uint8ClampedArray; z: Float32Array } {
  const it = paintPartSteps(area, part)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

/** Cut half-level images in sixteen-row batches (./scene.ts supplies the time budget). */
export function* cutBandsSteps(part: SlopesPart, px: Uint8ClampedArray, zp: Float32Array): Generator<void, BandPixels[]> {
  const W = (part.x1 - part.x0 + 1) * T
  const H = (part.y1 - part.y0 + 1) * T
  const bands = new Float32Array(W * H)
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>()
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const z = zp[y * W + x]!
      const band = Number.isNaN(z) || px[(y * W + x) * 4 + 3] === 0 ? Number.NaN : bandOf(z)
      bands[y * W + x] = band
      if (Number.isNaN(band)) continue
      const b = boxes.get(band)
      if (!b) boxes.set(band, { x0: x, y0: y, x1: x, y1: y })
      else {
        if (x < b.x0) b.x0 = x
        if (x > b.x1) b.x1 = x
        if (y < b.y0) b.y0 = y
        if (y > b.y1) b.y1 = y
      }
    }
    if ((y + 1) % 16 === 0) yield
  }
  yield
  const bandPx = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? Number.NaN : bands[y * W + x]!)
  const out: BandPixels[] = []
  for (const [band, b] of [...boxes].sort((a, c) => a[0] - c[0])) {
    // A pixel past the band's box each way, inside the part.
    const x0 = Math.max(0, b.x0 - 1)
    const y0 = Math.max(0, b.y0 - 1)
    const x1 = Math.min(W - 1, b.x1 + 1)
    const y1 = Math.min(H - 1, b.y1 + 1)
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const cut = new Uint8ClampedArray(w * h * 4)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const here = bandPx(x, y)
        let keep = here === band
        if (!keep && !(here > band)) {
          // A lower band's (or nothing's) pixel next to this band: this band covers it.
          for (let dy = -1; dy <= 1 && !keep; dy++) for (let dx = -1; dx <= 1 && !keep; dx++) if (bandPx(x + dx, y + dy) === band) keep = true
        }
        if (!keep) continue
        const from = (y * W + x) * 4
        const to = ((y - y0) * w + x - x0) * 4
        cut[to] = px[from]!
        cut[to + 1] = px[from + 1]!
        cut[to + 2] = px[from + 2]!
        cut[to + 3] = px[from + 3]!
      }
      if ((y - y0 + 1) % 16 === 0) yield
    }
    out.push({ band, x: part.x0 * T + x0, y: part.y0 * T + y0, w, h, px: cut })
    yield
  }
  return out
}

/** A part cut into half-level images in one go. */
export function cutBands(part: SlopesPart, px: Uint8ClampedArray, zp: Float32Array): BandPixels[] {
  const it = cutBandsSteps(part, px, zp)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

