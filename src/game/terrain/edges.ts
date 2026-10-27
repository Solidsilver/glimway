/**
 * Slopes lab 2e (dev only): stylized edge shading wherever the ground
 * drops, independent of the sun, in every look.
 *
 * What counts is the field's height, never the lift: an edge is a step of
 * at least `threshold` levels between two neighbouring drawn pixels (a
 * cliff's lip, a plateau's rim, the top of a face; never a smooth slope,
 * which rises at most a few hundredths of a level a pixel). Where the edge
 * is drawn follows the look: unlifted, the low ground next to it in the
 * field; lifted, the low ground next to it on screen, which is the ground
 * seen behind a higher lip, or at the foot of a face.
 *
 * The low side gets a hard band, one dark tone near the edge and a
 * dithered lighter tone past it; the high lip optionally a one-pixel light
 * rim. Where walkable ground meets ground nobody walks (steep, crag), the
 * walkable side gets a narrower, lighter band whatever the heights, so a
 * range's border reads even where its foot rises gently. Values here are amounts (0–1), turned into colour by ./sun-view.ts,
 * which also caps them against cast shadows.
 */
import { TILE_PX as T, VIEW_FACE, fieldZ, liftColumn, type TerrainView } from './field.ts'

export interface EdgeSettings {
  /** 0–1: the band's strength (0 off). */
  strength: number
  /** The band's width, px, for a drop of a level (or every drop, unscaled). */
  width: number
  /** Bigger drops get a darker, wider band. */
  scale: boolean
  /** The smallest step that counts as an edge, levels. */
  threshold: number
  /** A thin light rim on the high lip. */
  rim: boolean
}

/** Defaults (the owner's spiral ramp: whole-level steps read, gentle hills untouched). */
export const EDGE_DEFAULT: EdgeSettings = { strength: 0.6, width: 4, scale: true, threshold: 0.5, rim: true }

/** At 100% strength: the inner tone's darkening, the outer dithered tone's, and the rim's lightening, before scaling. */
export const EDGE_TONE = { inner: 0.75, outer: 0.4, rim: 0.12 } as const
/** The closed border's band, of the drop band's tones. */
export const BORDER_TONE = 0.9
/** Field kinds nobody walks (the lab's KIND.steep and KIND.crag; ./bake.ts FIELD_STEEP, FIELD_CRAG). */
const closedKind = (k: number) => k === 8 || k === 9
/** The most an edge darkens one pixel (strong, a big drop): dark, never black. */
export const EDGE_MAX_DARK = 0.7

/** The widest band any setting can make (px): the margin a chunk reads past its edges. */
export const EDGE_MAX_WIDTH = 8
export const EDGE_MARGIN = Math.ceil(EDGE_MAX_WIDTH * 2.5) + 1

/** A drop's band: its width (px) and how strong (1: the unscaled band). */
export function edgeBand(drop: number, s: EdgeSettings): { width: number; k: number } {
  if (!s.scale) return { width: Math.max(1, Math.round(s.width)), k: 1 }
  const width = Math.max(1, Math.round(s.width * Math.min(2.5, Math.max(0.5, 0.5 + drop * 0.5))))
  const k = Math.min(1.3, Math.max(0.55, 0.55 + drop * 0.3))
  return { width, k }
}

/**
 * The height drawn at each pixel of a view rectangle (world px): ground's
 * own height, a face's top (a face is the high side of its edge), NaN for
 * nothing; and which pixels are faces.
 */
export function viewHeights(info: TerrainView, x0: number, y0: number, w: number, h: number): { z: Float32Array; face: Uint8Array; closed?: Uint8Array } {
  return run(viewHeightsSteps(info, x0, y0, w, h))
}
function run<T>(it: Generator<void, T>): T {
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}
/** viewHeights a few columns (lifted) or rows (flat) a step. */
export function* viewHeightsSteps(info: TerrainView, x0: number, y0: number, w: number, h: number): Generator<void, { z: Float32Array; face: Uint8Array; closed?: Uint8Array }> {
  const f = info.field
  const z = new Float32Array(w * h).fill(Number.NaN)
  const face = new Uint8Array(w * h)
  const closed = new Uint8Array(w * h)
  if (info.lift) {
    for (let x = 0; x < w; x++) {
      const wx = x0 + x
      if (wx < 0 || wx >= f.w * T) continue
      const col = liftColumn(f, wx >> 4, ((wx & 15) + 0.5) / T, info.pad, info.k, info.curve)
      let k = col.length - 1
      for (let y = 0; y < h; y++) {
        const s = (y0 + y + 0.5) / T
        while (k >= 0 && col[k]!.s1 <= s) k--
        const sp = k >= 0 && col[k]!.s0 <= s ? col[k]! : null
        if (!sp) continue
        const i = y * w + x
        if (sp.face) {
          z[i] = sp.zS
          face[i] = 1
        } else {
          const fy = Math.max(0, Math.min(1, (s - sp.sN) / (sp.sS - sp.sN)))
          z[i] = sp.zN + (sp.zS - sp.zN) * fy
          if (closedKind(f.kind[sp.ty * f.w + (wx >> 4)]!)) closed[i] = 1
        }
      }
      if ((x + 1) % 48 === 0) yield
    }
    return { z, face, closed }
  }
  const v = info.view
  for (let y = 0; y < h; y++) {
    const wy = y0 + y
    if (wy < 0 || wy >= f.h * T) continue
    const ty = wy >> 4
    for (let x = 0; x < w; x++) {
      const wx = x0 + x
      if (wx < 0 || wx >= f.w * T) continue
      const tx = wx >> 4
      const i = y * w + x
      const vi = ty * v.w + tx
      if (v.kind[vi] === VIEW_FACE) {
        z[i] = v.faceTop[vi]!
        face[i] = 1
      } else {
        z[i] = fieldZ(f, tx, ty, ((wx & 15) + 0.5) / T, ((wy & 15) + 0.5) / T)
        if (closedKind(f.kind[ty * f.w + tx]!)) closed[i] = 1
      }
    }
    if ((y + 1) % 96 === 0) yield
  }
  return { z, face, closed }
}

/**
 * Edge amounts over a rectangle (world px) from heights read over it and a
 * margin round it (`m` px each way, so bands cross chunk seams): `dark`,
 * 0–1, the band's darkening at full strength scaling included; `rim`, 0–1,
 * the lip's lightening. Pixel-art: two hard tones, the outer one on a world
 * checkerboard.
 */
export function edgeAmounts(heights: { z: Float32Array; face: Uint8Array; closed?: Uint8Array }, x0: number, y0: number, w: number, h: number, m: number, s: EdgeSettings): { dark: Float32Array; rim: Float32Array; edges: number } {
  return run(edgeAmountsSteps(heights, x0, y0, w, h, m, s))
}
/** edgeAmounts a few rows a step. */
export function* edgeAmountsSteps(heights: { z: Float32Array; face: Uint8Array; closed?: Uint8Array }, x0: number, y0: number, w: number, h: number, m: number, s: EdgeSettings): Generator<void, { dark: Float32Array; rim: Float32Array; edges: number }> {
  const W = w + 2 * m
  const H = h + 2 * m
  const { z, face } = heights
  const closed = heights.closed
  const dark = new Float32Array(w * h)
  const rim = new Float32Array(w * h)
  let edges = 0
  if (s.strength <= 0) return { dark, rim, edges }
  const thr = Math.max(0.05, s.threshold)
  const put = (X: number, Y: number, amount: number, into: Float32Array) => {
    const x = X - m
    const y = Y - m
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = y * w + x
    if (amount > into[i]!) into[i] = amount
  }
  // Walkable ground beside closed ground: a band on the walkable side (from (lx, ly), away from (cx, cy)).
  const border = (lx: number, ly: number, cx: number, cy: number) => {
    edges++
    const width = Math.max(3, Math.round(s.width * 0.75))
    const dx = lx - cx
    const dy = ly - cy
    for (let k = 0; k < width; k++) {
      const X = lx + dx * k
      const Y = ly + dy * k
      if (X < 0 || Y < 0 || X >= W || Y >= H) break
      const j = Y * W + X
      if (face[j] || closed![j] || Number.isNaN(z[j]!)) break
      if (k < 2) put(X, Y, EDGE_TONE.inner * BORDER_TONE, dark)
      else if (((x0 - m + X + y0 - m + Y) & 1) === 0) put(X, Y, EDGE_TONE.outer * BORDER_TONE, dark)
    }
  }
  // Each neighbouring pair, across and down: a step up from `lo` to `hi` of at least the threshold is an edge.
  const pair = (a: number, b: number, ax: number, ay: number, bx: number, by: number) => {
    const za = z[a]!
    const zb = z[b]!
    if (Number.isNaN(za) || Number.isNaN(zb)) return
    if (closed && closed[a] !== closed[b] && !face[a] && !face[b]) border(...(closed[a] ? [bx, by, ax, ay] : [ax, ay, bx, by]) as [number, number, number, number])
    const d = zb - za
    if (Math.abs(d) < thr) return
    const [lo, lx, ly, hi, hx, hy] = d > 0 ? [a, ax, ay, b, bx, by] : [b, bx, by, a, ax, ay]
    const drop = Math.abs(d)
    edges++
    if (s.rim && !face[hi]) put(hx, hy, EDGE_TONE.rim * Math.min(1, s.scale ? 0.6 + drop * 0.2 : 1), rim)
    if (face[lo]) return
    const band = edgeBand(drop, s)
    const inner = Math.max(1, Math.ceil(band.width / 2))
    const dx = lx - hx
    const dy = ly - hy
    const zl = z[lo]!
    for (let k = 0; k < band.width; k++) {
      const X = lx + dx * k
      const Y = ly + dy * k
      if (X < 0 || Y < 0 || X >= W || Y >= H) break
      const j = Y * W + X
      // The band lies on the low ground: it stops at a face, at nothing, or where the ground rises again.
      if (face[j] || Number.isNaN(z[j]!) || z[j]! > zl + thr / 2) break
      if (k < inner) put(X, Y, EDGE_TONE.inner * band.k, dark)
      else if (((x0 - m + X + y0 - m + Y) & 1) === 0) put(X, Y, EDGE_TONE.outer * band.k, dark)
    }
  }
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      const i = Y * W + X
      if (X + 1 < W) pair(i, i + 1, X, Y, X + 1, Y)
      if (Y + 1 < H) pair(i, i + W, X, Y, X, Y + 1)
    }
    if ((Y + 1) % 96 === 0) yield
  }
  return { dark, rim, edges }
}

/** A chunk's edge amounts (heights read with the margin). */
export function chunkEdges(info: TerrainView, x: number, y: number, w: number, h: number, s: EdgeSettings): { dark: Float32Array; rim: Float32Array; edges: number } {
  return run(chunkEdgesSteps(info, x, y, w, h, s))
}
export function* chunkEdgesSteps(info: TerrainView, x: number, y: number, w: number, h: number, s: EdgeSettings): Generator<void, { dark: Float32Array; rim: Float32Array; edges: number }> {
  const m = EDGE_MARGIN
  const heights = yield* viewHeightsSteps(info, x - m, y - m, w + 2 * m, h + 2 * m)
  return yield* edgeAmountsSteps(heights, x, y, w, h, m, s)
}

/** The settings as a cache key. */
export const edgeKey = (s: EdgeSettings) => `${s.strength.toFixed(2)}:${s.width}:${s.scale ? 1 : 0}:${s.threshold.toFixed(2)}:${s.rim ? 1 : 0}`

/** The band's cool tint: what of a darkening each channel takes (blue least, so it reads as shade, not dirt). */
export const EDGE_KEEP = [1, 0.94, 0.8] as const

/**
 * One pixel's multiply factor (per channel, 0–1) from a cast shadow's
 * factor and the edge's darkening, capped: where a cast shadow or terrain
 * shade already falls the band is weaker, and together they never go more
 * than EDGE_CAP darker than the darker of the two alone.
 */
export const EDGE_CAP = 0.85
export function combineShade(cast: number, edge: number, terrainVisible: number): number {
  const e = 1 - edge * (0.7 + 0.3 * terrainVisible)
  return Math.max(Math.min(cast, e) * EDGE_CAP, cast * e)
}
