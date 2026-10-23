/** Dev-only slope albedo: material, contours and terrace marks. Sun light lives in sun-map.ts. */
import { TERRAIN } from '../../lib/tile.ts'
import { wildsGround } from '../../lib/wilds/data.ts'
import { fnv1a32 } from '../../lib/hash.ts'
import { paintGround } from '../wilds/ground-paint.ts'
import { groundTable } from '../wilds/ground-table.ts'
import { wildsLook } from '../wilds/wilds-looks.ts'
import { G, GROUNDS, SURFACE, type LabArea } from './area.ts'
import { DX, DY, KIND, TILE_PX } from './levels.ts'
import { liftColumn, spanGround, type Field, type Span } from './slopes.ts'

/** Sparse contours: a level apart, in accents chosen per SPARSE_CELL px world cell (a few in ten left out). */
export const SPARSE_CONTOUR = 1
const SPARSE_CELL = 9

type RGB = [number, number, number]
const T = TILE_PX

function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const hexRGB = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]

/** Fog bands: a level image every half level. */
export const BAND = 0.5
export const bandOf = (z: number) => Math.floor(z / BAND + 1e-4) * BAND


/** Contours every CONTOUR levels, stronger every CONTOUR_MAJOR of them; terraces TERRACE levels high. */
export const CONTOUR = 0.5
const CONTOUR_MAJOR = 4
export const TERRACE = 0.2

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
  const lk = info.look
  const dry = hexRGB('#d8c890')
  const stone = hexRGB('#a8a296')
  const snow = hexRGB('#eef2f8')
  const scree = hexRGB('#aa9f8e')
  const bare = hexRGB('#96928b')
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
      const open = kind === KIND.flat || kind === KIND.slope || kind === KIND.prop
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
      const slope = Math.hypot(gx, gy)
      if (ground === G.bank) {
        // The sea's stand-in: pale sand flats with ripples.
        tint(sand, 0.45)
        const ripple = (wy + Math.round(Math.sin(wx / 9) * 2)) % 7
        if (ripple === 0) tint([226, 230, 226], 0.4)
        else if (ripple === 1) tint([128, 136, 140], 0.15)
      } else {
        tint(dry, 0.18 * smoothstep(2.5, 6.5, z))
        tint(stone, 0.42 * smoothstep(6, 10, z))
        if (z > 11) tint(snow, (0.35 + hash(wx >> 2, wy >> 2, 21) * 0.25) * smoothstep(11, 12.5, z))
      }
      if (kind === KIND.steep) {
        // Scree down the fall line (broken streaks of uneven length); bare rock where it's steeper still.
        // Its own stone, not the painter's: grey-brown grit, patchy.
        const rock = slope > 0.55
        const base = (rock ? bare : scree).map((ch) => ch * (0.92 + hash(wx >> 3, wy >> 3, 31) * 0.16 + (hash(wx, wy, 32) - 0.5) * 0.12)) as RGB
        r = base[0]
        g = base[1]
        b = base[2]
        const dx = gx / (slope || 1)
        const dy = gy / (slope || 1)
        const along = wx * dx + wy * dy
        const across = -wx * dy + wy * dx
        // Short dashes down the fall line, on a world grid so they don't swirl with it.
        const lane = Math.floor(across / 2)
        const dash = hash(lane, Math.floor(along / 5), 22)
        if (dash < 0.1) tint([58, 54, 50], rock ? 0.35 : 0.25)
        else if (dash > 0.93) tint([214, 208, 196], 0.18)
        // Loose pale stones in the material.
        if (hash(wx >> 1, wy >> 1, 23) < 0.05 && (wx & 1) === 0 && (wy & 1) === 0) tint([228, 222, 208], 0.55)
        if (talus) {
          // Fallen blocks at a cliff foot, varied by material.
          const bx = Math.floor((wx + (Math.floor(wy / 3) % 2) * 2) / 4)
          const by = Math.floor(wy / 3)
          const blk = hash(bx, by, 33)
          const k2 = 0.78 - blk * 0.16
          r *= k2
          g *= k2 * 0.98
          b *= k2 * 0.97
        }
        // A rim of loose stones where the walkable ground ends.
        const fx = wx & 15
        const fy = wy & 15
        for (let d = 0; d < 4; d++) {
          const nx = tx + DX[d]
          const ny = ty + DY[d]
          if (nx < 0 || ny < 0 || nx >= f.w || ny >= f.h) continue
          const nk = f.kind[ny * f.w + nx]!
          if (nk !== KIND.flat && nk !== KIND.slope && nk !== KIND.prop) continue
          if (surface.kind[ny * f.w + nx] === KIND.face) continue
          const off = d === 0 ? fy : d === 1 ? 15 - fx : d === 2 ? 15 - fy : fx
          if (off < 2) tint([214, 204, 182], off === 0 ? 0.55 : 0.3)
        }
      } else if (kind === KIND.crag) {
        // Broken rock: blocks with a lit edge to the north-west, cracks.
        const cell = Math.floor((wx + (Math.floor(wy / 5) % 2) * 3) / 6) * 977 + Math.floor(wy / 5)
        const c = 96 + hash(cell, 0, 24) * 40
        r = c
        g = c * 0.97
        b = c * 0.95
        const ex = (wx + (Math.floor(wy / 5) % 2) * 3) % 6
        const ey = wy % 5
        if (ey === 4 || ex === 5) tint([30, 28, 30], 0.6)
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
      // The treatments: light, then lines.
      let k = 1
      const step = (lo: number, hi: number) => Math.abs(hi - lo) < 0.15
      if (lk.contours === 'current' && kind !== KIND.crag) {
        const band = Math.floor(z / CONTOUR)
        let low = false
        let high = false
        let major = false
        for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const zn = zAt(x + ax, y + ay)
          if (!step(z, zn)) continue
          const bn = Math.floor(zn / CONTOUR)
          if (bn > band) {
            low = true
            if (bn % CONTOUR_MAJOR === 0) major = true
          } else if (bn < band) high = true
        }
        if (low) k *= major ? 0.55 : 0.7
        else if (high) k *= 1.15
      }
      if (lk.contours === 'sparse' && open && ground !== G.bank && slope > 0.02) {
        // Distance (px) above the level line below, and below the level line above.
        const gp = slope / T
        const lv = z / SPARSE_CONTOUR
        const above = ((lv - Math.floor(lv)) * SPARSE_CONTOUR) / gp
        const below = ((Math.ceil(lv) - lv) * SPARSE_CONTOUR) / gp
        // The line this pixel is by (the one below it on the high side, the one above on the low side), and the accent there.
        const line = above < below ? Math.floor(lv) : Math.ceil(lv)
        const cell = hash(Math.floor(wx / SPARSE_CELL), Math.floor(wy / SPARSE_CELL), 41 + line)
        const fade = 1 - smoothstep(0.18, 0.26, slope)
        if (cell >= 0.5 && fade > 0) {
          if (cell < 0.78) {
            // Grass tips: light blades of uneven height on the high side's edge, a dark shade under them.
            if (hash(wx, line, 43) < 0.6 && above < 0.7 + 1.1 * hash(wx, line, 44)) tint([204, 228, 124], 0.42 * fade)
            else if (below < 0.9) tint([32, 56, 26], 0.28 * fade)
            else if (below < 1.8) tint([32, 56, 26], 0.1 * fade)
          } else if (cell < 0.94) {
            // A soil edge: a light rim, bare soil just below it.
            if (above < 0.9) tint([240, 230, 186], 0.32 * fade)
            else if (below < 0.9) tint([92, 68, 44], 0.32 * fade)
            else if (below < 1.8) tint([92, 68, 44], 0.12 * fade)
          } else if (below < 1.8 && hash(wx >> 1, wy >> 1, 45) < 0.45) {
            // A few stones along the line, each lit on top, a shadow under it.
            tint((wy & 1) === 0 ? [222, 216, 200] : [48, 44, 40], (wy & 1) === 0 ? 0.48 * fade : 0.28 * fade)
          }
        }
      }
      if (lk.terraces && kind !== KIND.crag) {
        const tb = (zz: number) => Math.floor(zz / TERRACE)
        const here = tb(z)
        const n1 = zAt(x, y - 1)
        const n2 = zAt(x, y - 2)
        const s1 = zAt(x, y + 1)
        if (step(z, n1) && tb(n1) > here) k *= 0.6
        else if (step(z, n2) && step(n1, n2) && tb(n2) > here) k *= 0.8
        else if (step(z, s1) && tb(s1) < here) k *= 1.24
        else if (step(z, s1) && tb(s1) > here) k *= 0.78
        else {
          const e1 = zAt(x + 1, y)
          const w1 = zAt(x - 1, y)
          if ((step(z, e1) && tb(e1) > here) || (step(z, w1) && tb(w1) > here)) k *= 0.84
        }
      }
      px[o] = r * k
      px[o + 1] = g * k
      px[o + 2] = b * k
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

/** The paint cache's key (./slopes-art.ts) for a chunk of the area as it's drawn: every setting that paints (facing, contours, terraces, lift strength). */
export function chunkKey(area: LabArea, cx: number, cy: number): string {
  const l = area.slopes!.look
  return `${l.contours}|${l.terraces ? 1 : 0}|${l.lift}|${cx},${cy}`
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
        const tint = faceTint(l.faceTop[i]!)
        const material = 152 + (hash(tx * T + x, ty * T + y, 25) - 0.5) * 18
        for (let c = 0; c < 3; c++) px[at * 4 + c] = material * tint[c]!
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
            const hz = zf * info.k * T
            const strata = hz - Math.floor(hz / 6) * 6
            let cc = 152 + (hash(wx, Math.floor(hz), 25) - 0.5) * 14
            if (strata < 1) cc += 12
            else if (strata < 2) cc -= 22
            if (hash(wx, Math.floor(hz / 14), 26) < 0.025) cc -= 26
            const tint = faceTint(sp.zS)
            px[o] = cc * tint[0]
            px[o + 1] = cc * tint[1]
            px[o + 2] = cc * tint[2]
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

/** A lifted face's colour by the height it rises to (warm low down, greyer and cooler high up), as ./slopes-art.ts slopeFaceTint. */
function faceTint(z: number): RGB {
  return z < 2.5 ? [1.06, 0.98, 0.88] : z < 5 ? [1, 0.96, 0.92] : z < 9 ? [0.94, 0.95, 1] : [1.02, 1.03, 1.07]
}
