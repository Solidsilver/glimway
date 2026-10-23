/**
 * Dev-only sprite cast shadows (slopes 2d). Each caster is a small solid,
 * not its ¾ drawing: a stack of round slices (trunk, crown, dome, body)
 * standing on its real footprint. Each slice is cast along the sun ray onto
 * the local ground plane, so a tree's trunk line leaves its base and its
 * crown separates as the sun drops. Shadows are drawn one pixel per world
 * pixel, in one tone with a dithered penumbra, plus a contact shadow under
 * the footprint that stays (faintly) even in terrain shade.
 *
 * Pure: the scene and ./sun-view.ts feed it alpha masks and sun samples.
 */
import { sampleVisibility, type SunMap } from './sun-map.ts'
import { shadowOpacity, sunShadow, type SunDirection } from './sun.ts'

/** Ground is drawn ¾: a round cross-section reads as an ellipse this flat. */
export const GROUND_ASPECT = 0.55
/** Shadow length is capped at this many caster heights (dawn and dusk). */
export const MAX_REACH = 4
/** Contact shadow tone over the directional one, and its floor in shade. */
export const CONTACT_TONE = 1.15
export const CONTACT_SHADE = 0.4

export type CasterKind = 'tree' | 'rock' | 'body' | 'plant'
/** A round slice of the solid between two heights, tapering r0 → r1;
 * x is its axis offset from the footprint centre (a leaning crown). */
export interface ShadowSlice { x: number; h0: number; h1: number; r0: number; r1: number }
/** Proxy in world pixels. `foot` is the footprint centre relative to the
 * frame's bottom centre (where a sprite with origin (0.5, 1) stands): the
 * visible foot sits `pad` rows up, rocks stand further back on their disc. */
export interface ShadowProxy { kind: CasterKind; slices: ShadowSlice[]; contact: { rx: number; ry: number }; foot: { x: number; y: number }; height: number }

/** How tall a ¾ drawing's rows really stand. A boulder's upper rows are
 * mostly its top seen from above; a tree's rows are nearly all height. */
const HEIGHT_SCALE: Record<CasterKind, number> = { tree: 0.9, rock: 0.8, body: 0.85, plant: 0.6 }

/** Opaque extent of each row, bottom row first; null for empty rows. */
export function rowProfile(px: Uint8ClampedArray, w: number, h: number): { rows: ({ l: number; r: number } | null)[]; pad: number } {
  const rows: ({ l: number; r: number } | null)[] = []
  for (let y = h - 1; y >= 0; y--) {
    let l = w, r = -1
    for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3]! >= 20) { l = Math.min(l, x); r = Math.max(r, x) }
    rows.push(r < l ? null : { l, r: r + 1 })
  }
  let pad = 0
  while (rows.length && !rows[0]) { rows.shift(); pad++ }
  while (rows.length && !rows.at(-1)) rows.pop()
  return { rows, pad }
}

/**
 * A caster's solid, from its alpha mask and kind. Trees, plants and rocks
 * are lathed from their smoothed row widths (a pine is a cone, an oak a
 * trunk under a crown, a boulder a low dome); bodies are a capsule.
 * Mirrored sprites mirror their proxy (x offsets are in unflipped pixels).
 */
export function casterProxy(kind: CasterKind, px: Uint8ClampedArray, w: number, h: number, scale = 1): ShadowProxy {
  return scaled(lathe(kind, px, w, h), scale)
}
function scaled(p: ShadowProxy, k: number): ShadowProxy {
  if (k === 1) return p
  return { kind: p.kind, height: p.height * k, foot: { x: p.foot.x * k, y: p.foot.y * k }, contact: { rx: p.contact.rx * k, ry: p.contact.ry * k },
    slices: p.slices.map(s => ({ x: s.x * k, h0: s.h0 * k, h1: s.h1 * k, r0: s.r0 * k, r1: s.r1 * k })) }
}
function lathe(kind: CasterKind, px: Uint8ClampedArray, w: number, h: number): ShadowProxy {
  const { rows, pad } = rowProfile(px, w, h)
  const filled = rows.map((r, i) => r ?? rows.slice(0, i).reverse().find(Boolean) ?? { l: w / 2, r: w / 2 })
  if (!filled.length) return { kind, slices: [], contact: { rx: 1, ry: GROUND_ASPECT }, foot: { x: 0, y: 0 }, height: 0 }
  const s = HEIGHT_SCALE[kind]
  const half = filled.map(r => (r.r - r.l) / 2), mid = filled.map(r => (r.l + r.r) / 2)
  const baseRows = Math.min(filled.length, 2)
  const footX = kind === 'rock' ? mid[half.indexOf(Math.max(...half))]! : mid.slice(0, baseRows).reduce((a, b) => a + b, 0) / baseRows
  const height = filled.length * s
  if (kind === 'body') {
    const r = Math.max(2, Math.max(...half) * 0.62)
    const rx = Math.max(3, Math.max(...half) * 0.6)
    return { kind, slices: [{ x: 0, h0: 0, h1: Math.max(0, height - r), r0: r, r1: r }], contact: { rx, ry: rx * GROUND_ASPECT }, foot: { x: footX - w / 2, y: -pad - 1 }, height }
  }
  // Smooth the leafy outline (a 3-row median), so crowns cast blobs, not lace.
  const smooth = half.map((_, i) => [half[i - 1] ?? half[i]!, half[i]!, half[i + 1] ?? half[i]!].sort((a, b) => a - b)[1]!)
  const lowRows = Math.max(1, Math.round(filled.length * (kind === 'rock' ? 0.6 : 0.15)))
  const baseR = Math.max(...smooth.slice(0, lowRows))
  // A rock's contact peeks a pixel or two past its sides and front, as drawn rocks sit.
  const rx = kind === 'rock' ? baseR + 1.5 : Math.max(2.5, baseR + 1.5)
  const ry = rx * GROUND_ASPECT
  // Rocks stand on a disc just behind their visible bottom (their bulge overhangs it).
  const foot = { x: footX - w / 2, y: -pad - (kind === 'rock' ? baseR * GROUND_ASPECT * 0.6 : 1) }
  const step = Math.max(1, Math.round(filled.length / 12))
  const slices: ShadowSlice[] = []
  for (let i = 0; i < filled.length; i += step) {
    const j = Math.min(filled.length - 1, i + step)
    slices.push({ x: (mid[i]! + mid[j]!) / 2 - footX, h0: i * s, h1: (j + 1) * s, r0: smooth[i]!, r1: smooth[j]! })
  }
  return { kind, slices, contact: { rx, ry }, foot, height }
}

/** Ground offset of one unit of height, on the receiving slope (gx, gy in
 * levels a tile) and lifted views (k), capped at MAX_REACH heights. */
export function shadowRay(gx: number, gy: number, sun: SunDirection, k = 0): [number, number] {
  const ray = sunShadow(gx, gy, 1, sun)
  const dy = ray.dy - k * (gx * ray.dx + gy * ray.dy)
  const len = Math.hypot(ray.dx, dy), cap = len > MAX_REACH ? MAX_REACH / len : 1
  return [ray.dx * cap, dy * cap]
}

/** Coverage of a cast proxy, one cell per world pixel. */
export interface Cast { x0: number; y0: number; w: number; h: number; dir: Uint8Array; contact: Uint8Array }

/** 4×4 ordered dither threshold, 0–1. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
export const dither = (x: number, y: number): number => (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16

/**
 * Rasterise a proxy whose frame stands at (footX, footY): the bottom centre
 * of a sprite with origin (0.5, 1), in world pixels, with the shadow ray `v` (ground px per unit of height). The
 * foot snaps to a whole pixel, so a still caster's shadow never shimmers.
 * Slices are tapered capsules from their foot's shadow to their top's, in
 * ground space unsquashed by GROUND_ASPECT. Their rim dithers, wider where
 * the slice stands higher (a penumbra grows with distance).
 */
export function castProxy(p: ShadowProxy, footX: number, footY: number, v: readonly [number, number], flip = false, clip?: { x: number; y: number; w: number; h: number }): Cast {
  const sx = flip ? -1 : 1
  const cx = Math.round(footX) + sx * p.foot.x, cy = Math.round(footY) + p.foot.y
  const segs = p.slices.map(s => ({
    ax: sx * s.x + s.h0 * v[0], ay: s.h0 * v[1] / GROUND_ASPECT,
    bx: sx * s.x + s.h1 * v[0], by: s.h1 * v[1] / GROUND_ASPECT, r0: s.r0, r1: s.r1, h0: s.h0, h1: s.h1
  })).map(s => {
    const r = Math.max(s.r0, s.r1)
    return { ...s, x0: Math.min(s.ax, s.bx) - r, x1: Math.max(s.ax, s.bx) + r, y0: Math.min(s.ay, s.by) - r, y1: Math.max(s.ay, s.by) + r }
  })
  let minX = -p.contact.rx, maxX = p.contact.rx, minY = -p.contact.ry, maxY = p.contact.ry
  for (const s of segs) {
    const r = Math.max(s.r0, s.r1)
    minX = Math.min(minX, s.ax - r, s.bx - r); maxX = Math.max(maxX, s.ax + r, s.bx + r)
    minY = Math.min(minY, (s.ay - r) * GROUND_ASPECT, (s.by - r) * GROUND_ASPECT); maxY = Math.max(maxY, (s.ay + r) * GROUND_ASPECT, (s.by + r) * GROUND_ASPECT)
  }
  let x0 = Math.floor(cx + minX) - 1, y0 = Math.floor(cy + minY) - 1
  let x1 = Math.ceil(cx + maxX) + 2, y1 = Math.ceil(cy + maxY) + 2
  // Only the part over a chunk: neighbours' long shadows are mostly elsewhere.
  if (clip) { x0 = Math.max(x0, clip.x); y0 = Math.max(y0, clip.y); x1 = Math.min(x1, clip.x + clip.w); y1 = Math.min(y1, clip.y + clip.h) }
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0)
  const dir = new Uint8Array(w * h), contact = new Uint8Array(w * h)
  const vLen = Math.hypot(v[0], v[1])
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    const X = x0 + ix + 0.5 - cx, Y = y0 + iy + 0.5 - cy
    const i = iy * w + ix
    if ((X / p.contact.rx) ** 2 + (Y / p.contact.ry) ** 2 <= 1) contact[i] = 1
    const qy = Y / GROUND_ASPECT
    for (const s of segs) {
      if (X < s.x0 || X > s.x1 || qy < s.y0 || qy > s.y1) continue
      const ex = s.bx - s.ax, ey = s.by - s.ay, ll = ex * ex + ey * ey
      const t = ll > 1e-9 ? Math.max(0, Math.min(1, ((X - s.ax) * ex + (qy - s.ay) * ey) / ll)) : 0
      const margin = s.r0 + (s.r1 - s.r0) * t - Math.hypot(X - s.ax - ex * t, qy - s.ay - ey * t)
      if (margin < 0) continue
      const pen = Math.min(2.5, 0.35 + 0.025 * (s.h0 + (s.h1 - s.h0) * t) * vLen)
      if (margin >= pen || dither(x0 + ix, y0 + iy) < margin / pen) { dir[i] = 1; break }
    }
  }
  return { x0, y0, w, h, dir, contact }
}

/**
 * How dark one shadow pixel is (0 none, 1 black). The directional part needs
 * the caster's foot and the pixel both in sun: terrain shade already removed
 * that light, so it never darkens twice. The contact shadow (occluded sky
 * under the footprint) stays, faint, in shade.
 */
export function shadowDarkness(dir: number, contact: number, footVisible: number, pixelVisible: number, strength: number, daylight = 1): number {
  const a = shadowOpacity(1, strength, daylight), lit = footVisible * pixelVisible
  return Math.max(dir * a * lit, contact * a * CONTACT_TONE * (CONTACT_SHADE + (1 - CONTACT_SHADE) * lit))
}
/** Shadows keep the cool sky fill: they take less blue than red. */
export const SHADOW_KEEP: readonly [number, number, number] = [1, 0.94, 0.8]
export function shadeMultiply(dark: number): [number, number, number] {
  return SHADOW_KEEP.map(k => 1 - dark * k) as [number, number, number]
}
/** A mover's shadow over a still caster's: the darker wins, not the sum. */
export function overShadow(under: number, over: number): number {
  return over <= under ? 0 : 1 - (1 - over) / (1 - under)
}

export interface Caster { x: number; y: number; proxy: ShadowProxy; flip: boolean; v: readonly [number, number]; visible: number }

/**
 * One chunk's still shadows (trees, rocks), max-combined (never summed),
 * in world pixels from (x, y). Per-pixel terrain visibility comes from the
 * chunk's own sun map, quantised by the ordered dither so a fade at a
 * terrain-shadow edge reads as pixels, not a blur.
 */
export function* buildShadowLayer(map: SunMap | null, x: number, y: number, w: number, h: number, casters: readonly Caster[], strength: number, daylight: number): Generator<void, { dark: Float32Array; px: Uint8ClampedArray }> {
  const dark = new Float32Array(w * h)
  let n = 0
  for (const c of casters) {
    const cast = castProxy(c.proxy, c.x, c.y, c.v, c.flip, { x, y, w, h })
    if (!cast.w || !cast.h) continue
    for (let iy = 0; iy < cast.h; iy++) {
      const wy = cast.y0 + iy, ly = wy - y
      if (ly < 0 || ly >= h) continue
      for (let ix = 0; ix < cast.w; ix++) {
        const j = iy * cast.w + ix
        if (!cast.dir[j] && !cast.contact[j]) continue
        const wx = cast.x0 + ix, lx = wx - x
        if (lx < 0 || lx >= w) continue
        const vis = map ? (sampleVisibility(map, wx + 0.5, wy + 0.5) >= dither(wx, wy) ? 1 : 0) : 1
        const d = shadowDarkness(cast.dir[j]!, cast.contact[j]!, c.visible, vis, strength, daylight)
        const i = ly * w + lx
        if (d > dark[i]!) dark[i] = d
      }
    }
    if (++n % 4 === 0) yield
  }
  const px = new Uint8ClampedArray(w * h * 4).fill(255)
  for (let i = 0; i < w * h; i++) {
    const d = dark[i]!
    if (!d) continue
    px[i * 4] = (1 - d * SHADOW_KEEP[0]) * 255; px[i * 4 + 1] = (1 - d * SHADOW_KEEP[1]) * 255; px[i * 4 + 2] = (1 - d * SHADOW_KEEP[2]) * 255
  }
  return { dark, px }
}
