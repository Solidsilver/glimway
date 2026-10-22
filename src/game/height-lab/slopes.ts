/**
 * Height lab (dev only): the slopes round's area, "Slopes, hills and
 * passes", 6×6 chunks (144×144 tiles). Pure data, like ./area.ts and
 * ./mountain.ts, but authored as a smooth height field rather than whole
 * levels: each tile has its own four corner heights (1/256 level, the wire's
 * edge precision), shared with its neighbours, so the land is continuous,
 * except where a cliff is meant (an outcrop's edge, the sea cliff, the
 * spire, the plateau patch): there the tiles on either side disagree.
 *
 * The field is ground: where things are on the land, seen from above. Two
 * maps are built from it, the walk layer the scene uses:
 *  - flat (the shading, contour and terrace styles): a map tile is a field
 *    tile; slopes are drawn where they lie, and a cliff's face takes
 *    ROWS_PER_LEVEL rows a level off the lower land south of it (the local
 *    face rule, as the other areas), so a level still lifts by 3 rows.
 *  - lifted (the true ¾ style): everything is drawn 3 rows a level further
 *    north as it rises (screen row = field row − 3z, plus a margin). A slope
 *    facing you stretches, one facing away squashes (and past 1/3 level a
 *    tile it hides), a cliff opens into its face by the same 3 rows a level,
 *    and nothing walkable hides: the steepness limit is under 1/3.
 *
 * Walking: a tile is walkable when its slope is at most MAX_WALK_SLOPE;
 * steeper is "too steep" (KIND.steep: scree, bare rock); crags near the tops
 * are KIND.crag. Both are closed, and their own kinds, so climbing gear can
 * open them later.
 *
 * The map (north up, field tiles; z in levels, the sea at 0):
 *
 *   rows   0–12   the far side, upland at about 3.
 *   rows  12–80   the range: a ridge near row 30, peaks 9–12, smooth lower
 *                 sides that steepen into a too-steep band, crags at the
 *                 tops; the pass, a saddle at about 6, at column 72; the
 *                 spire (15) at column 40, row 36; the range ends at column
 *                 ~118, so you can go round it to the east.
 *   rows  70–110  the valley (about 1): rolling hills to the west, the
 *                 outcrop (col 96–110, row 80–96: up from the north, a cliff
 *                 to the south), the plateau patch (cols 122–142, rows 66–104,
 *                 whole levels 2–4 with cliffs and three ramps).
 *   rows 100–123  the coast rises to about 2.7; the sea cliff along it, the
 *                 gully (cols 44–47) the one way down.
 *   rows 123–143  the sea (flat sand at 0, no water yet).
 */
import { G, hash, lightArea, type AreaOptions, type LabArea, type PropSpot } from './area.ts'
import { CAVE, DX, DY, KIND, ROWS_PER_LEVEL, SURFACE, newLayer, setClosed, step, type Dir, type Kind, type Node, type Stack } from './levels.ts'

export const SLOPES_W = 144
export const SLOPES_H = 144

/**
 * The walking limit, in levels a tile: one level over four tiles (12 px of
 * rise in 16). Every hill is gentler (≤ 0.2); the generator's built ramps
 * are steeper (1/3), as built stone steps may be. It stays under 1/3, the
 * slope at which ground facing away from you would vanish in the true ¾
 * lift, so nothing walkable ever hides behind a hill.
 */
export const MAX_WALK_SLOPE = 0.25

/** Heights are kept at the wire's edge precision. */
export const Q = 256
const q = (z: number) => Math.round(z * Q) / Q

/** Fog by height difference here: a "level" of fog for every FOG_LEVELS levels (the range is 15 tall). */
export const FOG_LEVELS = 4

/** The drawing styles (./slopes-art.ts). */
export type SlopeStyle = 'shade' | 'contours' | 'terraces' | 'lift'
export const SLOPE_STYLE_NAME: Record<SlopeStyle, string> = { shade: 'Shading by facing', contours: 'Contour hints', terraces: 'Small terraces', lift: 'True ¾ lift' }

/** The ground: per tile its corners, kind and ground. */
export interface Field {
  w: number
  h: number
  /** Four a tile: nw, ne, se, sw (levels, at 1/256). */
  corner: Float32Array
  /** KIND.flat or slope (walkable), steep, crag, prop (a tree or boulder stands here). */
  kind: Uint8Array
  ground: Uint8Array
  /** Slope per tile, levels a tile (the corners' gradient). */
  slope: Float32Array
}

/** Somewhere worth walking to, in field tiles, with what to look at. */
export interface SlopeSpot {
  name: string
  tx: number
  ty: number
  note: string
}

/** What the slopes area knows beyond a hand-made one. */
export interface SlopesInfo {
  style: SlopeStyle
  shade: boolean
  lift: boolean
  field: Field
  /** Lifted: rows the map is moved down by, so the highest ground still fits (0 flat). */
  pad: number
  /** Per map tile: the field tile shown there (-1: a face, or nothing), and the ground's height at its middle (NaN: nothing). */
  source: Int32Array
  z: Float32Array
  spots: SlopeSpot[]
}

// ---------------------------------------------------------------- the field

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export const PASS_X = 72
const ridgeY = (x: number) => 30 + 3 * Math.sin(x / 23)
const passK = (x: number) => Math.exp(-(((x - PASS_X) / 10) ** 2))

/** The ridge's height over the land below it. */
function ridgeH(x: number): number {
  const ends = smoothstep(-6, 10, x) * (1 - smoothstep(102, 120, x))
  // Two massifs, west and east, the pass between them.
  const peaks = 7.2 + 3.2 * Math.exp(-(((x - 34) / 17) ** 2)) + 3 * Math.exp(-(((x - 100) / 12) ** 2)) + 0.4 * Math.sin(x / 5.1)
  return Math.max(0, (peaks - 3.4 * passK(x)) * ends)
}

/** The range: gentle low down, steepening toward the ridge; an even climb through the pass. */
function range(x: number, y: number): number {
  const r = ridgeH(x)
  if (r <= 0) return 0
  const ry = ridgeY(x)
  const p = passK(x)
  const L = y >= ry ? 54 : 34 + 12 * p
  const t = 1 - Math.min(1, Math.abs(y - ry) / L)
  const a = 0.55 + 0.45 * p
  return r * (a * t + (1 - a) * t ** 5)
}

/** The land under the range: the valley at 1, the far side at 3. */
const low = (x: number, y: number) => 1 + 2 * smoothstep(ridgeY(x) + 8, ridgeY(x) - 14, y)

/** Rolling hills in the valley's west. */
function hills(x: number, y: number): number {
  const m = smoothstep(ridgeY(x) + 34, ridgeY(x) + 48, y) * (1 - smoothstep(58, 76, x)) * (1 - smoothstep(94, 104, y))
  const h = (Math.sin(x / 8.5 + Math.sin(y / 10)) * Math.cos(y / 9.5 - x / 23) + 1) / 2
  return 1.8 * h * m
}

/** The smooth land, before cliffs. */
function base(x: number, y: number): number {
  const coast = 2 * smoothstep(98, 116, y)
  const roll = 0.25 * Math.sin(x / 13) * Math.sin(y / 11)
  return low(x, y) + range(x, y) + hills(x, y) + coast + roll
}

/** The sea cliff's line: the last land row in each column. */
export const coastRow = (tx: number) => 121 + Math.round(1.6 * Math.sin(tx / 7))

export const GULLY = { x0: 44, x1: 47, y0: 104 } as const
export const SPIRE = { x: 40.5, y: 36.5, r: 2.3, top: 15 } as const
export const OUTCROP = { x0: 96, x1: 110, y0: 80, y1: 96, rise: 3.2 } as const
export const PLATEAU = { a: [124, 68, 141, 102], b: [127, 72, 139, 96], c: [130, 76, 136, 88] } as const
/** The plateau patch's ramps: columns, rows, and the levels they join (low at the south end). */
const PLATEAU_RAMPS = [
  { x0: 131, x1: 133, y0: 103, y1: 107, lo: Number.NaN, hi: 2 },
  { x0: 131, x1: 133, y0: 97, y1: 100, lo: 2, hi: 3 },
  { x0: 131, x1: 133, y0: 89, y1: 92, lo: 3, hi: 4 }
] as const

const inRect = (r: readonly number[], tx: number, ty: number) => tx >= r[0]! && tx <= r[2]! && ty >= r[1]! && ty <= r[3]!
const inOutcrop = (tx: number, ty: number) => tx >= OUTCROP.x0 && tx <= OUTCROP.x1 && ty <= OUTCROP.y1 && ty >= OUTCROP.y0 + Math.abs(tx - (OUTCROP.x0 + OUTCROP.x1) / 2) * 0.7
const inSpire = (tx: number, ty: number) => Math.hypot(tx + 0.5 - SPIRE.x, ty + 0.5 - SPIRE.y) <= SPIRE.r

/** Which authored piece a tile belongs to, and its height at a corner (cx, cy) of it. */
export type Region = 'sea' | 'gully' | 'spire' | 'outcrop' | 'ramp' | 'plateau' | 'land'
export function regionOf(tx: number, ty: number): Region {
  if (ty > coastRow(tx)) return 'sea'
  if (tx >= GULLY.x0 && tx <= GULLY.x1 && ty >= GULLY.y0) return 'gully'
  if (inSpire(tx, ty)) return 'spire'
  if (inOutcrop(tx, ty)) return 'outcrop'
  if (PLATEAU_RAMPS.some((r) => tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1)) return 'ramp'
  if (inRect(PLATEAU.a, tx, ty)) return 'plateau'
  return 'land'
}

function heightAt(region: Region, tx: number, ty: number, cx: number, cy: number): number {
  switch (region) {
    case 'sea':
      return 0
    case 'gully': {
      // From the land at its head down to the sea at the cliff's foot.
      // One foot row for all its columns (the coast wiggles), so the gully is one smooth piece; flat sand past it.
      let foot = Infinity
      for (let x = GULLY.x0; x <= GULLY.x1; x++) foot = Math.min(foot, coastRow(x) + 1)
      const t = clamp((cy - GULLY.y0) / (foot - GULLY.y0), 0, 1)
      return base(cx, cy) * (1 - t)
    }
    case 'spire':
      return SPIRE.top
    case 'outcrop':
      return base(cx, cy) + OUTCROP.rise * clamp((cy - OUTCROP.y0) / (OUTCROP.y1 + 1 - OUTCROP.y0), 0, 1)
    case 'ramp': {
      const r = PLATEAU_RAMPS.find((rr) => tx >= rr.x0 && tx <= rr.x1 && ty >= rr.y0 && ty <= rr.y1)!
      const t = clamp((r.y1 + 1 - cy) / (r.y1 + 1 - r.y0), 0, 1)
      const lo = Number.isNaN(r.lo) ? base(cx, cy) : r.lo
      return lo + (r.hi - lo) * t
    }
    case 'plateau':
      return inRect(PLATEAU.c, tx, ty) ? 4 : inRect(PLATEAU.b, tx, ty) ? 3 : 2
    default:
      return base(cx, cy)
  }
}

const CORNER: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1]
]

/** A field tile's height at (fx, fy) across it (bilinear between its corners). */
export function fieldZ(f: Field, tx: number, ty: number, fx: number, fy: number): number {
  const i = (ty * f.w + tx) * 4
  const c = f.corner
  const n = c[i]! + (c[i + 1]! - c[i]!) * fx
  const s = c[i + 3]! + (c[i + 2]! - c[i + 3]!) * fx
  return n + (s - n) * fy
}

/** Edge heights (n, e, s, w) of a field tile: its corners' means, so neighbours agree but across a cliff. */
export function fieldEdges(f: Field, i: number): [number, number, number, number] {
  const c = f.corner
  const o = i * 4
  return [q((c[o]! + c[o + 1]!) / 2), q((c[o + 1]! + c[o + 2]!) / 2), q((c[o + 2]! + c[o + 3]!) / 2), q((c[o + 3]! + c[o]!) / 2)]
}

export const walkableKind = (k: number) => k === KIND.flat || k === KIND.slope

/** Levels run 0–15 (shared with the generator lane, exp/slopes-gen). */
export const MAX_LEVEL = 15

/**
 * The ground kinds by the names shared with the generator lane: `slope`
 * (walkable, flat included), `steep` (too steep: scree or bare rock,
 * climbable later), `crag` (jagged rock, climbable later), `cliff` (a
 * south face by the local rule). Trees, boulders and the rest are null:
 * cover, not ground.
 */
export type GroundKind = 'slope' | 'steep' | 'crag' | 'cliff'
export function groundKind(k: number): GroundKind | null {
  return k === KIND.flat || k === KIND.slope ? 'slope' : k === KIND.steep ? 'steep' : k === KIND.crag ? 'crag' : k === KIND.face ? 'cliff' : null
}

/** The slopes area's ground, as authored. */
export function buildField(): Field {
  const w = SLOPES_W
  const h = SLOPES_H
  const f: Field = { w, h, corner: new Float32Array(w * h * 4), kind: new Uint8Array(w * h), ground: new Uint8Array(w * h), slope: new Float32Array(w * h) }
  const region: Region[] = []
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++) {
      const i = ty * w + tx
      const r = regionOf(tx, ty)
      region[i] = r
      for (let c = 0; c < 4; c++) f.corner[i * 4 + c] = q(heightAt(r, tx, ty, tx + CORNER[c]![0], ty + CORNER[c]![1]))
      const o = i * 4
      const k = f.corner
      const gx = (k[o + 1]! - k[o]! + k[o + 2]! - k[o + 3]!) / 2
      const gy = (k[o + 3]! - k[o]! + k[o + 2]! - k[o + 1]!) / 2
      f.slope[i] = Math.hypot(gx, gy)
    }
  const zMid = (i: number) => (f.corner[i * 4]! + f.corner[i * 4 + 1]! + f.corner[i * 4 + 2]! + f.corner[i * 4 + 3]!) / 4
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++) {
      const i = ty * w + tx
      const r = region[i]!
      const s = f.slope[i]!
      const z = zMid(i)
      const ridge = range(tx + 0.5, ty + 0.5)
      // Crags: rough knobs near the tops, the spire's foot, the outcrop's raised sides.
      const nearSpire = Math.hypot(tx + 0.5 - SPIRE.x, ty + 0.5 - SPIRE.y) <= SPIRE.r + 1.2
      const outcropSide = r === 'outcrop' && (!inOutcrop(tx - 1, ty) || !inOutcrop(tx + 1, ty)) && z - base(tx + 0.5, ty + 0.5) > 0.5
      const crag = r !== 'spire' && (nearSpire || outcropSide || (r === 'land' && ((z > 9.2 && hash(tx >> 1, ty >> 1, 71) < 0.6) || s > 0.8)))
      let kind: number = s <= 0.02 ? KIND.flat : KIND.slope
      if (crag) kind = KIND.crag
      else if (s > MAX_WALK_SLOPE) kind = KIND.steep
      f.kind[i] = kind
      let g: number = G.meadow
      if (r === 'sea') g = G.bank
      else if (r === 'gully') g = G.path
      else if (r === 'spire') g = G['wq-stone']
      else if (kind === KIND.crag) g = G['tops-crag']
      else if (kind === KIND.steep) g = G['tops-scree']
      else if (r === 'outcrop') g = G.trodden
      else if (r === 'plateau' || r === 'ramp') g = r === 'ramp' ? G.trodden : G.moss
      else if (ridge > 0.6 && Math.abs(tx + 0.5 - PASS_X) < 1.6 && ty < 76 && ty > 12) g = G['tops-path']
      else if (ridge > 0.6) g = z > 8 ? G['wq-stone'] : z > 5.5 ? G['tops-turf'] : G['tops-moor']
      else if (ty > 104 && ty <= coastRow(tx)) g = G.moss
      f.ground[i] = g
    }
  return f
}

// ---------------------------------------------------------------- props and spots

const SPOTS: SlopeSpot[] = [
  { name: 'spawn', tx: 70, ty: 96, note: 'low ground in the valley; the range north, the hills west, the sea south' },
  { name: 'hills', tx: 30, ty: 88, note: 'rolling hills: walkable anywhere, no cliffs' },
  { name: 'pass-foot', tx: 72, ty: 70, note: 'where the climb to the pass starts (path ground)' },
  { name: 'pass-mid', tx: 72, ty: 48, note: 'halfway up: the too-steep band closes in on both sides' },
  { name: 'pass-top', tx: 72, ty: 31, note: 'the saddle, about level 6; shoulders too steep either side' },
  { name: 'pass-north', tx: 72, ty: 10, note: 'down the far side to the upland' },
  { name: 'steep-band', tx: 56, ty: 46, note: 'below the scree band on the range’s south side, looking north' },
  { name: 'crags', tx: 90, ty: 40, note: 'under the crags near the eastern peaks' },
  { name: 'spire', tx: 40, ty: 52, note: 'below the spire (level 15): its face, crags round its foot; no way up' },
  { name: 'outcrop-slope', tx: 103, ty: 82, note: 'the outcrop’s gentle side: walk south up onto it' },
  { name: 'outcrop-top', tx: 103, ty: 95, note: 'the outcrop’s edge, about 3 levels over the valley' },
  { name: 'outcrop-cliff', tx: 103, ty: 108, note: 'below the outcrop’s cliff, looking north at its face' },
  { name: 'sea-cliff', tx: 30, ty: 118, note: 'the sea cliff’s top, the sand flats below' },
  { name: 'gully', tx: 45, ty: 112, note: 'the one way down to the sea' },
  { name: 'sea', tx: 45, ty: 134, note: 'on the sand flats under the cliff' },
  { name: 'plateau', tx: 132, ty: 110, note: 'the plateau patch: whole levels, cliffs, ramps (like the generator)' },
  { name: 'around-east', tx: 128, ty: 40, note: 'round the range’s east end: the long way north' }
]

function fieldProps(f: Field): PropSpot[] {
  const props: PropSpot[] = []
  const keep = SPOTS.map((s) => [s.tx, s.ty] as const)
  const open = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < f.w && ty < f.h && walkableKind(f.kind[ty * f.w + tx]!)
  for (let ty = 2; ty < f.h - 2; ty++)
    for (let tx = 2; tx < f.w - 2; tx++) {
      const i = ty * f.w + tx
      if (!open(tx, ty) || f.ground[i] === G.path || f.ground[i] === G['tops-path'] || f.ground[i] === G.bank || f.ground[i] === G.trodden) continue
      if (keep.some(([x, y]) => Math.abs(x - tx) <= 2 && Math.abs(y - ty) <= 2)) continue
      // Not by a cliff or a closed tile: trees there hide the edge.
      const e = fieldEdges(f, i)
      let ok = true
      for (let d = 0; d < 4 && ok; d++) {
        const x = tx + DX[d]
        const y = ty + DY[d]
        if (!open(x, y)) ok = false
        else if (Math.abs(fieldEdges(f, y * f.w + x)[(d + 2) & 3]! - e[d]!) > 0.01) ok = false
      }
      if (!ok) continue
      const r = hash(tx, ty, 61)
      const v = Math.floor(hash(tx, ty, 62) * 8)
      const z = f.corner[i * 4]!
      const mountain = range(tx + 0.5, ty + 0.5) > 0.6
      const woods = ty < 12 || (tx > 112 && ty < 62)
      let kind: PropSpot['kind'] | null = null
      if (mountain) {
        if (r < (z > 6 ? 0.02 : 0.045)) kind = z > 6 || hash(tx, ty, 63) < 0.3 ? 'boulder' : 'pine'
      } else if (r < (woods ? 0.12 : 0.03)) kind = hash(tx, ty, 63) < (woods ? 0.3 : 0.55) ? 'oak' : hash(tx, ty, 64) < 0.5 ? 'pine' : 'birch'
      else if (r > 0.975) kind = 'fern'
      if (!kind) continue
      props.push({ kind, tx, ty, variant: v, blocks: kind !== 'fern' })
      if (kind !== 'fern') f.kind[i] = KIND.prop
    }
  return props
}

// ---------------------------------------------------------------- the lifted view

/**
 * One run of a lifted map column (screen rows s0 ≤ s < s1, in tiles):
 * ground of field tile `ty` (its north and south edges at screen rows sN, sS
 * and heights zN, zS along this column), or a face, from its top `zS` down
 * to the land in front (`zBot`).
 */
export interface Span {
  s0: number
  s1: number
  face: boolean
  ty: number
  sN: number
  sS: number
  zN: number
  zS: number
  zBot: number
}

/**
 * A lifted column at field x = tx + fx: from the near (south) edge back,
 * each tile shows where it rises above everything nearer (a horizon);
 * where a tile's near edge stands above the land in front, the gap is its
 * face.
 */
export function liftColumn(f: Field, tx: number, fx: number, pad: number): Span[] {
  const out: Span[] = []
  let horizon = Infinity
  let nearN = 0
  const c = f.corner
  for (let ty = f.h - 1; ty >= 0; ty--) {
    const i = (ty * f.w + tx) * 4
    const zN = c[i]! + (c[i + 1]! - c[i]!) * fx
    const zS = c[i + 3]! + (c[i + 2]! - c[i + 3]!) * fx
    const sN = ty - ROWS_PER_LEVEL * zN + pad
    const sS = ty + 1 - ROWS_PER_LEVEL * zS + pad
    if (horizon !== Infinity && sS < horizon - 1e-4) out.push({ s0: sS, s1: horizon, face: true, ty, sN, sS, zN, zS, zBot: nearN })
    if (sN < sS && sN < horizon) out.push({ s0: sN, s1: Math.min(sS, horizon), face: false, ty, sN, sS, zN, zS, zBot: zN })
    horizon = Math.min(horizon, sN, sS)
    nearN = zN
  }
  return out
}

/** The run a screen row falls in (null: nothing there). */
export function spanAt(col: Span[], s: number): Span | null {
  for (const sp of col) if (s >= sp.s0 && s < sp.s1) return sp
  return null
}

/** A ground run's field row at screen row s (fractional, 0–1 across the tile), and its height there. */
export function spanGround(sp: Span, s: number): { fy: number; z: number } {
  const fy = clamp((s - sp.sN) / (sp.sS - sp.sN), 0, 1)
  return { fy, z: sp.zN + (sp.zS - sp.zN) * fy }
}

/** The margin a lifted map needs on top: the highest ground's lift, and a little. */
export function liftPad(f: Field): number {
  let zmax = 0
  for (const z of f.corner) zmax = Math.max(zmax, z)
  return Math.ceil(ROWS_PER_LEVEL * zmax) + 2
}

// ---------------------------------------------------------------- the maps

const D = 1e-3

/** The flat map: a map tile is a field tile; cliffs take their faces off the land south of them. */
function flatMap(f: Field, surface: ReturnType<typeof newLayer>, source: Int32Array, zs: Float32Array): void {
  const { w, h } = f
  for (let i = 0; i < w * h; i++) {
    const k = f.kind[i]!
    const tx = i % w
    const ty = (i - tx) / w
    surface.ground[i] = f.ground[i]!
    source[i] = i
    zs[i] = fieldZ(f, tx, ty, 0.5, 0.5)
    if (walkableKind(k)) {
      surface.kind[i] = k
      surface.edge.set(fieldEdges(f, i), i * 4)
    } else setClosed(surface, tx, ty, k as Kind)
  }
  // Faces: where land drops to the south, ROWS_PER_LEVEL rows a level of the land in front.
  for (let tx = 0; tx < w; tx++)
    for (let ty = 0; ty < h - 1; ty++) {
      const hi = fieldEdges(f, ty * w + tx)[2]
      const lo = fieldEdges(f, (ty + 1) * w + tx)[0]
      if (hi - lo <= 0.05) continue
      const rows = Math.max(1, Math.round((hi - lo) * ROWS_PER_LEVEL))
      for (let r = 1; r <= rows && ty + r < h; r++) {
        const j = (ty + r) * w + tx
        if (Math.max(...f.corner.subarray(j * 4, j * 4 + 4)) >= hi) break
        setClosed(surface, tx, ty + r, KIND.face)
        surface.faceTop[j] = hi
        surface.faceRow[j] = r - 1
        surface.faceRows[j] = rows
        source[j] = -1
        zs[j] = lo
      }
    }
}

/** The lifted map: each map tile shows what the lifted columns put there (./slopes.ts liftColumn). */
function liftMap(f: Field, surface: ReturnType<typeof newLayer>, source: Int32Array, zs: Float32Array, pad: number): void {
  const w = surface.w
  const H = surface.h
  for (let tx = 0; tx < w; tx++) {
    const mid = liftColumn(f, tx, 0.5, pad)
    const west = liftColumn(f, tx, D, pad)
    const east = liftColumn(f, tx, 1 - D, pad)
    // An edge is open where it lands on walkable ground: its height there.
    const edgeZ = (col: Span[], s: number) => {
      const sp = spanAt(col, s)
      if (!sp || sp.face || !walkableKind(f.kind[sp.ty * f.w + tx]!)) return Number.NaN
      return spanGround(sp, s).z
    }
    for (let sy = 0; sy < H; sy++) {
      const i = sy * w + tx
      const sp = spanAt(mid, sy + 0.5)
      source[i] = -1
      zs[i] = Number.NaN
      if (!sp) {
        setClosed(surface, tx, sy, KIND.none)
        continue
      }
      if (sp.face) {
        setClosed(surface, tx, sy, KIND.face)
        const rows = Math.max(1, Math.round(sp.s1 - sp.s0))
        surface.faceTop[i] = sp.zS
        surface.faceRows[i] = Math.min(127, rows)
        surface.faceRow[i] = Math.min(rows - 1, Math.max(0, Math.floor(sy + 0.5 - sp.s0)))
        surface.ground[i] = G['tops-crag']
        zs[i] = sp.zBot
        continue
      }
      const j = sp.ty * f.w + tx
      source[i] = j
      zs[i] = spanGround(sp, sy + 0.5).z
      surface.ground[i] = f.ground[j]!
      const k = f.kind[j]!
      if (!walkableKind(k)) {
        setClosed(surface, tx, sy, k as Kind)
        continue
      }
      surface.kind[i] = k
      const e = [edgeZ(mid, sy + D), edgeZ(east, sy + 0.5), edgeZ(mid, sy + 1 - D), edgeZ(west, sy + 0.5)]
      for (let d = 0; d < 4; d++) surface.edge[i * 4 + d] = e[d]!
      if (e.every((z) => Number.isNaN(z))) setClosed(surface, tx, sy, KIND.steep)
    }
  }
  // Neighbours on the same ground meet within a hair: make them meet exactly (at 1/256).
  for (let sy = 0; sy < H; sy++)
    for (let tx = 0; tx < w; tx++) {
      const i = sy * w + tx
      for (const d of [1, 2] as Dir[]) {
        const x = tx + DX[d]
        const y = sy + DY[d]
        if (x >= w || y >= H) continue
        const j = y * w + x
        const a = surface.edge[i * 4 + d]!
        const b = surface.edge[j * 4 + ((d + 2) & 3)]!
        if (Number.isNaN(a) || Number.isNaN(b)) continue
        if (Math.abs(a - b) < 0.05) surface.edge[i * 4 + d] = surface.edge[j * 4 + ((d + 2) & 3)] = q((a + b) / 2)
      }
    }
}

/** A field tile in the map (the lifted map: where its middle shows; null where it's hidden). */
export function toMap(info: SlopesInfo, tx: number, ty: number): { tx: number; ty: number } | null {
  if (!info.lift) return { tx, ty }
  const col = liftColumn(info.field, tx, 0.5, info.pad)
  const sp = col.find((s) => !s.face && s.ty === ty)
  if (!sp) return null
  const s = clamp((sp.sN + sp.sS) / 2, sp.s0, sp.s1 - 1e-3)
  return { tx, ty: Math.floor(s) }
}

/** The field tile a map tile shows (null: a face or nothing). */
export function toField(info: SlopesInfo, tx: number, ty: number): { tx: number; ty: number } | null {
  const j = info.source[ty * info.field.w + tx] ?? -1
  if (j < 0) return null
  return { tx: j % info.field.w, ty: Math.floor(j / info.field.w) }
}

/** The nearest walkable map tile to (tx, ty), by rings. */
export function nearestWalkable(stack: Stack, tx: number, ty: number): Node {
  const l = stack.layers[SURFACE]!
  for (let r = 0; r < Math.max(l.w, l.h); r++)
    for (let y = ty - r; y <= ty + r; y++)
      for (let x = tx - r; x <= tx + r; x++) {
        if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) !== r || x < 0 || y < 0 || x >= l.w || y >= l.h) continue
        if (walkableKind(l.kind[y * l.w + x]!)) return { layer: SURFACE, tx: x, ty: y }
      }
  return { layer: SURFACE, tx, ty }
}

/** A field tile as a map node, on walkable ground near it. */
export function mapNode(info: SlopesInfo, stack: Stack, tx: number, ty: number): Node {
  const m = toMap(info, tx, ty) ?? { tx, ty: info.lift ? Math.max(0, Math.round(ty + info.pad - ROWS_PER_LEVEL * fieldZ(info.field, tx, ty, 0.5, 0.5))) : ty }
  return nearestWalkable(stack, m.tx, m.ty)
}

export interface SlopesOptions {
  style: SlopeStyle
  shade: boolean
}

/** The slopes area in a style: the lifted map for the true ¾ lift, the flat one for the rest. */
export function buildSlopes(opts: AreaOptions, look: SlopesOptions = { style: 'shade', shade: true }): LabArea {
  const field = buildField()
  const props = fieldProps(field)
  const lift = look.style === 'lift'
  const pad = lift ? liftPad(field) : 0
  const w = field.w
  const h = field.h + pad
  const surface = newLayer('surface', w, h)
  const cave = newLayer('cave', w, h)
  const stack: Stack = { w, h, layers: [surface, cave], portals: new Map() }
  const source = new Int32Array(w * h).fill(-1)
  const zs = new Float32Array(w * h).fill(Number.NaN)
  if (lift) liftMap(field, surface, source, zs, pad)
  else flatMap(field, surface, source, zs)
  const top = new Int8Array(w * h)
  for (let i = 0; i < w * h; i++) top[i] = Number.isNaN(zs[i]!) ? 0 : Math.floor(zs[i]! + 1e-3)
  const info: SlopesInfo = { style: look.style, shade: look.shade, lift, field, pad, source, z: zs, spots: SPOTS }
  // Props stand where their tile shows; crags get a rock each, so they read as standing rock in every style.
  const shown: PropSpot[] = []
  const place = (p: PropSpot, z: number) => {
    if (!lift) {
      shown.push({ ...p, z })
      return
    }
    const col = liftColumn(field, p.tx, 0.5, pad)
    const sp = col.find((s) => !s.face && s.ty === p.ty)
    if (!sp) return
    // Its foot: the tile's south edge, lifted; never below what shows of it.
    const foot = Math.min(sp.s1, sp.sS)
    shown.push({ ...p, ty: Math.max(0, Math.round(foot) - 1), z })
  }
  for (const p of props) place(p, fieldZ(field, p.tx, p.ty, 0.5, 1))
  for (let i = 0; i < field.w * field.h; i++) {
    if (field.kind[i] !== KIND.crag) continue
    const tx = i % field.w
    const ty = (i - tx) / field.w
    if (!lift && surface.kind[i] !== KIND.crag) continue
    place({ kind: 'crag', tx, ty, variant: Math.floor(hash(tx, ty, 65) * 4), blocks: true }, fieldZ(field, tx, ty, 0.5, 1))
  }
  // Lifted, a prop's tile closes wherever it shows.
  if (lift) for (let i = 0; i < w * h; i++) if (source[i]! >= 0 && field.kind[source[i]!] === KIND.prop) setClosed(surface, i % w, Math.floor(i / w), KIND.prop)
  const spot = (name: string) => SPOTS.find((s) => s.name === name)!
  const at = (name: string) => mapNode(info, stack, spot(name).tx, spot(name).ty)
  return {
    ...lightArea(
      {
        name: 'slopes',
        stack,
        top,
        props: shown,
        mouths: [],
        glows: [],
        spawn: at('spawn'),
        // Wren walks over the pass and back.
        route: [at('pass-foot'), at('pass-top'), at('pass-north'), at('pass-top'), at('spawn')],
        homes: [{ ...at('hills'), art: 'slime' }]
      },
      opts
    ),
    slopes: info
  }
}

/** For the tests: every map tile reachable from a node. */
export function reach(stack: Stack, from: Node): Uint8Array {
  const { w, h } = stack
  const seen = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let n = 0
  seen[from.ty * w + from.tx] = 1
  queue[n++] = from.ty * w + from.tx
  for (let k = 0; k < n; k++) {
    const i = queue[k]!
    const tx = i % w
    const ty = (i - tx) / w
    for (let d = 0; d < 4; d++) {
      if (step(stack, SURFACE, tx, ty, d as Dir) !== SURFACE) continue
      const j = (ty + DY[d]) * w + tx + DX[d]
      if (seen[j]) continue
      seen[j] = 1
      queue[n++] = j
    }
  }
  return seen
}

export { CAVE }
