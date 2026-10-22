/**
 * Height lab (dev only): the slopes area's ground (./slopes.ts) in the four
 * drawing styles the owner picked, painted a part (a chunk) at a time. Pure
 * pixels (./slopes-art.ts makes them textures), so a node script can render
 * previews.
 *
 *  - shading by facing: ground facing the light (from the north-west, the
 *    top left of the screen, as relief maps light it) brighter, ground
 *    facing away darker. Lit from the south (as the cliffs' sunny faces
 *    are), relief read inverted in the first frames: the outcrop looked
 *    like a pit;
 *  - contour hints: a faint grass edge every half level, dark on the low
 *    side and light on the high side, a little stronger every two levels;
 *  - small terraces: the slope as shallow steps of a fifth of a level, each
 *    with a lit lip and a short riser where it faces you;
 *  - true ¾ lift: the ground painted where it lies, then moved north 3 rows
 *    a level as it rises (./slopes.ts liftColumn), cliffs opening into
 *    their faces.
 *
 * Shading can be added to the other three (the "with shading" switch).
 * Whatever the style, the ground is the Wilds' own painter
 * (../wilds/ground-paint.ts), higher land drier, then stonier, then snowy;
 * too-steep ground is scree (streaks down the fall line, loose stones) or
 * bare rock; crags are broken rock (a standing rock is drawn on each by the
 * scene). The level images are cut by half levels, so fog by height
 * difference fades in small steps; each overlaps the band below it by a
 * pixel, so no seam shows between them.
 */
import { TERRAIN } from '../../lib/tile.ts'
import { wildsGround } from '../../lib/wilds/data.ts'
import { fnv1a32 } from '../../lib/hash.ts'
import { paintGround } from '../wilds/ground-paint.ts'
import { groundTable } from '../wilds/ground-table.ts'
import { wildsLook } from '../wilds/wilds-looks.ts'
import { G, GROUNDS, SURFACE, type LabArea } from './area.ts'
import { DX, DY, KIND, TILE_PX } from './levels.ts'
import { liftColumn, spanGround, type Field, type Span } from './slopes.ts'

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

/** The light, from the north-west and above (x east, y south, z up). */
const SUN = (() => {
  const v = [-0.5, -0.5, 0.7]
  const n = Math.hypot(v[0]!, v[1]!, v[2]!)
  return v.map((c) => c / n) as [number, number, number]
})()
/** How strongly facing shades: brightness change per unit of the sun's cosine. */
const SHADE_GAIN = 1.4

/** Contours every CONTOUR levels, stronger every CONTOUR_MAJOR of them; terraces TERRACE levels high. */
export const CONTOUR = 0.5
const CONTOUR_MAJOR = 4
export const TERRACE = 0.2

/** The painter's terrain for each of the slopes area's grounds (its own tints are this file's). */
const SPECIAL: Partial<Record<string, keyof typeof TERRAIN>> = { 'tops-scree': 'stone_b', 'tops-crag': 'stone_a', 'wq-stone': 'stone_a', 'tops-path': 'path_a' }

/** The field's ground, painted and shaded, over a rectangle of field pixels: RGBA. */
export function paintField(area: LabArea, x0: number, y0: number, w: number, h: number): Uint8ClampedArray {
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
  const style = info.style
  const shade = style === 'shade' || info.shade
  const dry = hexRGB('#d8c890')
  const stone = hexRGB('#a8a296')
  const snow = hexRGB('#eef2f8')
  const scree = hexRGB('#aa9f8e')
  const bare = hexRGB('#96928b')
  const sand = hexRGB('#c4c2b2')
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const wx = x0 + x
      const wy = y0 + y
      const tx = Math.min(f.w - 1, wx >> 4)
      const ty = Math.min(f.h - 1, wy >> 4)
      const i = ty * f.w + tx
      const kind = f.kind[i]!
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
        // Loose stones, a shadow under each.
        if (hash(wx >> 1, wy >> 1, 23) < 0.05 && (wx & 1) === 0 && (wy & 1) === 0) tint([228, 222, 208], 0.55)
        else if (hash(wx >> 1, (wy - 1) >> 1, 23) < 0.05 && (wx & 1) === 0 && (wy & 1) === 1) tint([40, 36, 34], 0.4)
        // A rim of loose stones where the walkable ground ends.
        const fx = wx & 15
        const fy = wy & 15
        for (let d = 0; d < 4; d++) {
          const nx = tx + DX[d]
          const ny = ty + DY[d]
          if (nx < 0 || ny < 0 || nx >= f.w || ny >= f.h) continue
          const nk = f.kind[ny * f.w + nx]!
          if (nk !== KIND.flat && nk !== KIND.slope && nk !== KIND.prop) continue
          const off = d === 0 ? fy : d === 1 ? 15 - fx : d === 2 ? 15 - fy : fx
          if (off < 2) tint([214, 204, 182], off === 0 ? 0.55 : 0.3)
        }
      } else if (kind === KIND.crag) {
        // Broken rock: blocks with a lit edge to the south-west, cracks.
        const cell = Math.floor((wx + (Math.floor(wy / 5) % 2) * 3) / 6) * 977 + Math.floor(wy / 5)
        const c = 96 + hash(cell, 0, 24) * 40
        r = c
        g = c * 0.97
        b = c * 0.95
        const ex = (wx + (Math.floor(wy / 5) % 2) * 3) % 6
        const ey = wy % 5
        if (ey === 4 || ex === 5) tint([30, 28, 30], 0.6)
        else if (ey === 0 || ex === 0) tint([220, 214, 200], 0.3)
      }
      // The styles: light, then lines.
      let k = 1
      if (shade && kind !== KIND.crag) {
        // Physical slope: a level is ROWS_PER_LEVEL tiles high.
        const nx = -3 * gx
        const ny = -3 * gy
        const n = Math.hypot(nx, ny, 1)
        const lit = (nx * SUN[0] + ny * SUN[1] + SUN[2]) / n
        k *= Math.max(0.55, Math.min(1.4, 1 + SHADE_GAIN * (lit - SUN[2])))
      }
      const step = (lo: number, hi: number) => Math.abs(hi - lo) < 0.15
      if (style === 'contours' && kind !== KIND.crag) {
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
      if (style === 'terraces' && kind !== KIND.crag) {
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
  return px
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

/** One part of the slopes area's surface as the map shows it (RGBA, the part's size). */
export function paintPart(area: LabArea, part: SlopesPart): Uint8ClampedArray {
  const info = area.slopes!
  const f = info.field
  const l = area.stack.layers[SURFACE]!
  const W = (part.x1 - part.x0 + 1) * T
  const H = (part.y1 - part.y0 + 1) * T
  const ox = part.x0 * T
  const oy = part.y0 * T
  const px = new Uint8ClampedArray(W * H * 4)
  if (!info.lift) px.set(paintField(area, ox, oy, W, H))
  else {
    // The field rows this part shows (and two more each way).
    let gy0 = f.h
    let gy1 = -1
    for (let ty = part.y0; ty <= part.y1; ty++)
      for (let tx = part.x0; tx <= part.x1; tx++) {
        const j = info.source[ty * l.w + tx]!
        if (j < 0) continue
        const fy = Math.floor(j / f.w)
        gy0 = Math.min(gy0, fy)
        gy1 = Math.max(gy1, fy)
      }
    if (gy1 >= 0) {
      gy0 = Math.max(0, gy0 - 2)
      gy1 = Math.min(f.h - 1, gy1 + 2)
      const gh = (gy1 - gy0 + 1) * T
      const ground = paintField(area, ox, gy0 * T, W, gh)
      for (let x = 0; x < W; x++) {
        const wx = ox + x
        const col: Span[] = liftColumn(f, wx >> 4, ((wx & 15) + 0.5) / T, info.pad)
        let k = col.length - 1
        for (let y = 0; y < H; y++) {
          const s = (oy + y + 0.5) / T
          while (k >= 0 && col[k]!.s1 <= s) k--
          const sp = k >= 0 && col[k]!.s0 <= s ? col[k]! : null
          const o = (y * W + x) * 4
          if (!sp) continue
          if (sp.face) {
            // Rock, under the face's own art (./art.ts drawFaces), where a part of a tile shows.
            const down = (s - sp.s0) / Math.max(1, sp.s1 - sp.s0)
            const c = 150 - down * 50 + (hash(wx, oy + y, 25) - 0.5) * 16 - ((oy + y) % 6 === 0 ? 24 : 0)
            px[o] = c
            px[o + 1] = c * 0.98
            px[o + 2] = c * 0.95
            px[o + 3] = 255
            continue
          }
          const gy = Math.floor((sp.ty + spanGround(sp, s).fy) * T) - gy0 * T
          const from = (Math.min(gh - 1, Math.max(0, gy)) * W + x) * 4
          px[o] = ground[from]!
          px[o + 1] = ground[from + 1]!
          px[o + 2] = ground[from + 2]!
          px[o + 3] = 255
        }
      }
    }
  }
  edges(area, px, W, part)
  return px
}

/** A part cut into half-level images; each takes a pixel more where it meets a lower band (no seams). */
export function cutBands(area: LabArea, part: SlopesPart, px: Uint8ClampedArray): BandPixels[] {
  const info = area.slopes!
  const l = area.stack.layers[SURFACE]!
  const pw = part.x1 - part.x0 + 1
  const ph = part.y1 - part.y0 + 1
  const W = pw * T
  const bandAt = new Float32Array(pw * ph).fill(Number.NaN)
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>()
  for (let ty = part.y0; ty <= part.y1; ty++)
    for (let tx = part.x0; tx <= part.x1; tx++) {
      const z = info.z[ty * l.w + tx]!
      if (Number.isNaN(z)) continue
      const band = bandOf(z)
      bandAt[(ty - part.y0) * pw + tx - part.x0] = band
      const b = boxes.get(band) ?? { x0: tx, y0: ty, x1: tx, y1: ty }
      boxes.set(band, { x0: Math.min(b.x0, tx), y0: Math.min(b.y0, ty), x1: Math.max(b.x1, tx), y1: Math.max(b.y1, ty) })
    }
  const bandPx = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= ph * T ? Number.NaN : bandAt[(y >> 4) * pw + (x >> 4)]!)
  const out: BandPixels[] = []
  for (const [band, b] of [...boxes].sort((a, c) => a[0] - c[0])) {
    // A pixel past the tiles' box each way, inside the part.
    const x0 = Math.max(0, (b.x0 - part.x0) * T - 1)
    const y0 = Math.max(0, (b.y0 - part.y0) * T - 1)
    const x1 = Math.min(W - 1, (b.x1 - part.x0 + 1) * T)
    const y1 = Math.min(ph * T - 1, (b.y1 - part.y0 + 1) * T)
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const cut = new Uint8ClampedArray(w * h * 4)
    for (let y = y0; y <= y1; y++)
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
    out.push({ band, x: part.x0 * T + x0, y: part.y0 * T + y0, w, h, px: cut })
  }
  return out
}

/**
 * Where the map's ground meets a cliff (in map tiles, so in either view):
 * shadow at a face's foot, a sunlit lip at its top, a dark rim where the
 * ground drops away north, east or west (a shut edge with lower ground
 * beyond), and a cast shadow on the low side.
 */
function edges(area: LabArea, px: Uint8ClampedArray, W: number, part: SlopesPart): void {
  const l = area.stack.layers[SURFACE]!
  const kindAt = (tx: number, ty: number) => (tx < 0 || ty < 0 || tx >= l.w || ty >= l.h ? KIND.none : l.kind[ty * l.w + tx]!)
  const edge = (tx: number, ty: number, d: number) => (tx < 0 || ty < 0 || tx >= l.w || ty >= l.h ? Number.NaN : l.edge[(ty * l.w + tx) * 4 + d]!)
  const mul = (x: number, y: number, k: number) => {
    const i = ((y - part.y0 * T) * W + x - part.x0 * T) * 4
    px[i] = px[i]! * k
    px[i + 1] = px[i + 1]! * k
    px[i + 2] = px[i + 2]! * k
  }
  const tint = (x: number, y: number, c: RGB, t: number) => {
    const i = ((y - part.y0 * T) * W + x - part.x0 * T) * 4
    px[i] = mix(px[i]!, c[0], t)
    px[i + 1] = mix(px[i + 1]!, c[1], t)
    px[i + 2] = mix(px[i + 2]!, c[2], t)
  }
  const lipC: RGB = [255, 242, 196]
  const ink: RGB = [29, 26, 36]
  for (let ty = part.y0; ty <= part.y1; ty++)
    for (let tx = part.x0; tx <= part.x1; tx++) {
      const k = kindAt(tx, ty)
      if (k === KIND.face || k === KIND.none) continue
      if (kindAt(tx, ty - 1) === KIND.face) for (let y = 0; y < 6; y++) for (let x = 0; x < T; x++) mul(tx * T + x, ty * T + y, 0.6 + y * 0.065)
      if (kindAt(tx, ty + 1) === KIND.face)
        for (let x = 0; x < T; x++) {
          tint(tx * T + x, ty * T + T - 2, lipC, 0.35)
          tint(tx * T + x, ty * T + T - 1, lipC, 0.55)
        }
      if (k !== KIND.flat && k !== KIND.slope) continue
      // Drops north, east, west: this side's edge higher than the other's.
      for (const d of [0, 1, 3] as const) {
        const here = edge(tx, ty, d)
        const nx = tx + DX[d]
        const ny = ty + DY[d]
        const there = edge(nx, ny, (d + 2) & 3)
        if (Number.isNaN(here) || Number.isNaN(there) || here - there < 0.1) continue
        for (let s = 0; s < T; s++) {
          const x = d === 1 ? T - 1 : d === 3 ? 0 : s
          const y = d === 0 ? 0 : s
          tint(tx * T + x, ty * T + y, ink, 0.7)
          const x2 = d === 1 ? T - 2 : d === 3 ? 1 : s
          const y2 = d === 0 ? 1 : s
          tint(tx * T + x2, ty * T + y2, d === 0 ? lipC : ink, d === 0 ? 0.25 : 0.3)
        }
        // The low side's shadow.
        if (nx >= part.x0 && nx <= part.x1 && ny >= part.y0 && ny <= part.y1)
          for (let s = 0; s < T; s++)
            for (let k2 = 0; k2 < 4; k2++) {
              const x = d === 1 ? k2 : d === 3 ? T - 1 - k2 : s
              const y = d === 0 ? T - 1 - k2 : s
              mul(nx * T + x, ny * T + y, 0.7 + k2 * 0.075)
            }
      }
    }
}
