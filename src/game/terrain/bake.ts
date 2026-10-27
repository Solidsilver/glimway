/**
 * One Wilds chunk's height terrain, baked into one image (the paint
 * worker's job, ./terrain-worker.ts): its painted ground (the window's own
 * albedo) with the terrain's materials (height's tint, scree, crags, talus,
 * cliff faces), lit by the one sun (./sun-map.ts: shading by facing and
 * terrain shadows), with 2e edge shading (./edges.ts) and the rim light,
 * exactly as the height lab composes them (./sun-view.ts SunChunk).
 *
 * Top-down: the image is the chunk's own square. ¾ lift: the chunk's tiles
 * drawn 3 rows a level further north (./field.ts liftColumn), faces opened
 * where the ground in front is lower; a taller image, placed at its world
 * px. Only the chunk's own tiles are drawn: what lies behind a nearer
 * chunk's rise is covered by that chunk's image, drawn later (north first).
 *
 * The window is the chunk and a halo round it, so seams, edges and the
 * sun's rays read across chunks; ground not loaded is flat at 0.
 */
import { TILE_PX as T, VIEW_FACE, fieldZ, liftColumn, liftPad, spanGround, type Span, type TerrainView } from './field.ts'
import { buildSunMap, sampleSunMap, sampleVisibility, type SunMap } from './sun-map.ts'
import { EDGE_KEEP, EDGE_MAX_DARK, chunkEdges, combineShade, type EdgeSettings } from './edges.ts'
import { dither } from './sun-shadow.ts'
import type { DaySun } from './sun.ts'
import { cliffMaterial, cragMaterial, heightTint, steepMaterial, type RGB } from './material.ts'

/** Field kinds in a window (the lab's ../height-lab/levels.ts KIND values, so the shared code reads them alike). */
export const FIELD_NONE = 0
export const FIELD_SLOPE = 2
export const FIELD_STEEP = 8
export const FIELD_CRAG = 9

export const CHUNK_TILES = 24
export const CHUNK_PX = CHUNK_TILES * T

/** A window of the field: tiles (w × h) from world tile (ox, oy); corners in levels, NW NE SE SW. */
export interface BakeWindow {
  ox: number
  oy: number
  w: number
  h: number
  corner: Float32Array
  kind: Uint8Array
  /** Cliff tiles: their face's top level, row and rows (0 rows: no face). */
  faceTop: Float32Array
  faceRow: Int8Array
  faceRows: Int8Array
}

export interface BakeJob {
  win: BakeWindow
  cx: number
  cy: number
  /** The chunk's painted ground, CHUNK_PX², RGBA. */
  albedo: Uint8ClampedArray
  lift: boolean
  sun: DaySun
  sunStrength: number
  edges: EdgeSettings
}

export interface Baked {
  rgba: Uint8ClampedArray
  /** Where the image goes, world px, and its size. */
  x: number
  y: number
  w: number
  h: number
  /** Edge pixels found (for the state readout). */
  edges: number
}

/** The window as the shared drawing code takes it. */
export function windowView(win: BakeWindow, lift: boolean): TerrainView {
  const n = win.w * win.h
  const field = { w: win.w, h: win.h, corner: win.corner, kind: win.kind, ground: new Uint8Array(n), slope: new Float32Array(n) }
  const kind = new Uint8Array(n)
  if (!lift) for (let i = 0; i < n; i++) if (win.faceRows[i]! > 0) kind[i] = VIEW_FACE
  const k = lift ? 3 : 0
  return { lift, k, field, pad: lift ? liftPad(field, k) : 0, view: { w: win.w, h: win.h, kind, faceTop: win.faceTop, faceRow: win.faceRow, faceRows: win.faceRows } }
}

function run<R>(it: Generator<void, R>): R {
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

const walkableField = (k: number) => k === FIELD_SLOPE

export function bakeChunk(job: BakeJob): Baked {
  const { win } = job
  const view = windowView(win, job.lift)
  const f = view.field
  const tx0 = job.cx * CHUNK_TILES - win.ox
  const ty0 = job.cy * CHUNK_TILES - win.oy
  const X = tx0 * T
  const W = CHUNK_PX
  // The image's rows in view px, and per pixel column its runs (lifted).
  let Y = ty0 * T
  let H = CHUNK_PX
  let cols: Span[][] | null = null
  if (job.lift) {
    cols = []
    let smin = Infinity
    let smax = -Infinity
    for (let x = 0; x < W; x++) {
      const vx = X + x
      const all = liftColumn(f, vx >> 4, ((vx & 15) + 0.5) / T, view.pad, view.k)
      const mine = all.filter((sp) => sp.ty >= ty0 && sp.ty < ty0 + CHUNK_TILES)
      for (const sp of mine) {
        smin = Math.min(smin, sp.s0)
        smax = Math.max(smax, sp.s1)
      }
      cols.push(mine)
    }
    if (smin === Infinity) smin = smax = ty0
    Y = Math.floor(smin * T)
    H = Math.max(1, Math.ceil(smax * T) - Y)
  }
  const sun: SunMap = run(buildSunMap(view, X, Y, W, H, job.sun, job.sunStrength, true))
  const on = job.edges.strength > 0
  const e = on ? chunkEdges(view, X, Y, W, H, job.edges) : null
  const lit = job.sun.daylight > 0
  const rgba = new Uint8ClampedArray(W * H * 4)
  const c: RGB = [0, 0, 0]
  const wx0 = win.ox * T + X
  const albedo = (lx: number, ly: number) => {
    const o = (Math.min(CHUNK_PX - 1, Math.max(0, ly)) * CHUNK_PX + lx) * 4
    c[0] = job.albedo[o]!
    c[1] = job.albedo[o + 1]!
    c[2] = job.albedo[o + 2]!
  }
  // The ground of field tile (tx, ty) at fractions (fx, fy): albedo, then the terrain's material.
  const ground = (x: number, tx: number, ty: number, fx: number, fy: number) => {
    const ly = (ty - ty0) * T + Math.min(15, Math.floor(fy * T))
    albedo(x, ly)
    const wx = wx0 + x
    const wy = (win.oy + ty) * T + Math.min(15, Math.floor(fy * T))
    const i = ty * f.w + tx
    const kind = f.kind[i]!
    heightTint(c, fieldZ(f, tx, ty, fx, fy), wx, wy)
    if (kind === FIELD_STEEP) {
      const o = i * 4
      const gx = (f.corner[o + 1]! - f.corner[o]!) * (1 - fy) + (f.corner[o + 2]! - f.corner[o + 3]!) * fy
      const gy = (f.corner[o + 3]! - f.corner[o]!) * (1 - fx) + (f.corner[o + 2]! - f.corner[o + 1]!) * fx
      const px = Math.floor(fx * T)
      const py = Math.floor(fy * T)
      let rim = -1
      for (const [d, nx, ny] of [[py, tx, ty - 1], [15 - px, tx + 1, ty], [15 - py, tx, ty + 1], [px, tx - 1, ty]] as const) {
        if (nx < 0 || ny < 0 || nx >= f.w || ny >= f.h) continue
        const j = ny * f.w + nx
        if (!walkableField(f.kind[j]!) || win.faceRows[j]! > 0) continue
        if (rim < 0 || d < rim) rim = d
      }
      steepMaterial(c, wx, wy, gx, gy, win.faceRows[i]! > 0, rim)
    } else if (kind === FIELD_CRAG) cragMaterial(c, wx, wy)
  }
  let edges = 0
  for (let y = 0; y < H; y++) {
    const vy = Y + y
    for (let x = 0; x < W; x++) {
      const vx = X + x
      const o = (y * W + x) * 4
      if (cols) {
        const s = (vy + 0.5) / T
        let sp: Span | null = null
        for (const r of cols[x]!) if (s >= r.s0 && s < r.s1) { sp = r; break }
        if (!sp) continue
        if (sp.face) {
          const down = (s - sp.s0) / Math.max(1e-6, sp.s1 - sp.s0)
          const m = cliffMaterial(wx0 + x, sp.zS - down * (sp.zS - sp.zBot), sp.zS)
          c[0] = m[0]; c[1] = m[1]; c[2] = m[2]
        } else {
          const g = spanGround(sp, s)
          ground(x, vx >> 4, sp.ty, ((vx & 15) + 0.5) / T, g.fy)
        }
      } else {
        const tx = vx >> 4
        const ty = vy >> 4
        const i = ty * f.w + tx
        const fy = ((vy & 15) + 0.5) / T
        if (win.faceRows[i]! > 0) {
          const m = cliffMaterial(wx0 + x, win.faceTop[i]! - (win.faceRow[i]! + fy) / 3, win.faceTop[i]!)
          c[0] = m[0]; c[1] = m[1]; c[2] = m[2]
        } else ground(x, tx, ty, ((vx & 15) + 0.5) / T, fy)
      }
      // The one sun, then the edge band (weaker in terrain shade) and the rim.
      const light = sampleSunMap(sun, vx + 0.5, vy + 0.5).rgb
      let r = c[0] * light[0]
      let g = c[1] * light[1]
      let b = c[2] * light[2]
      if (e) {
        const i = y * W + x
        const ed = Math.min(EDGE_MAX_DARK, e.dark[i]! * job.edges.strength)
        if (ed > 0) {
          const vis = lit ? (sampleVisibility(sun, vx + 0.5, vy + 0.5) >= dither(wx0 + x, vy) ? 1 : 0) : 1
          r *= combineShade(1, ed * EDGE_KEEP[0], vis)
          g *= combineShade(1, ed * EDGE_KEEP[1], vis)
          b *= combineShade(1, ed * EDGE_KEEP[2], vis)
        }
        const rim = e.rim[i]! * job.edges.strength
        if (rim > 0) {
          r += rim * 255
          g += rim * 245
          b += rim * 210
        }
      }
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = 255
    }
  }
  if (e) edges = e.edges
  return { rgba, x: wx0, y: (win.oy - view.pad) * T + Y, w: W, h: H, edges }
}
