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
 *  - lifted (lift strength 24 or 48 px a level; 48 is round 1's true ¾
 *    style): everything is drawn k rows a level further north as it rises
 *    (k = 1.5 or 3; screen row = field row − k z, plus a margin). A slope
 *    facing you stretches, one facing away squashes (and past 1/k level a
 *    tile it hides), a cliff opens into its face by k rows a level, and
 *    nothing walkable hides: the steepness limit is under 1/3. The lifted
 *    view is drawing only: collision is the flat map's in every setting.
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
import { CAVE, DX, DY, KIND, ROWS_PER_LEVEL, SURFACE, TILE_PX, move, newLayer, setClosed, step, type Dir, type Kind, type Layer, type Node, type Stack, type Walker } from './levels.ts'
import { COVER_PX, HIDE_ABOVE, MAX_LEVEL, MAX_WALK_Q, MAX_WALK_SLOPE, Q, UPHILL_CAP, coverRects, coveredPixels, display, fieldGradient, fieldZ, liftColumn, liftPad, slopeFactor, spanAt, spanGround, steepest, uphillFactor, type Field, type Span, type TerrainView } from '../terrain/field.ts'

// The field core is shared with the game (../terrain/field.ts); the lab's importers still find it here.
export { COVER_PX, HIDE_ABOVE, MAX_LEVEL, MAX_WALK_Q, MAX_WALK_SLOPE, Q, UPHILL_CAP, coverRects, coveredPixels, display, fieldGradient, fieldZ, liftColumn, liftPad, slopeFactor, spanAt, spanGround, steepest, uphillFactor, type Field, type Span }

export const SLOPES_W = 144
export const SLOPES_H = 144

const q = (z: number) => Math.round(z * Q) / Q

/** Fog by height difference here: a "level" of fog for every FOG_LEVELS levels (the range is 15 tall). */
export const FOG_LEVELS = 4

/** Round 1's four drawing styles (now shortcuts to settings, ./look.ts styleSettings). */
export type SlopeStyle = 'shade' | 'contours' | 'terraces' | 'lift'

/** Shading by facing: none, restrained (palette shifts that keep the grass's colour), or round 1's (brightness multiplied). */
export type FacingShade = 'off' | 'restrained' | 'current'
/** Contours: none, sparse (broken accents every level), or round 1's (a line every half level). */
export type ContourDetail = 'off' | 'sparse' | 'current'
/** Lift strength, px a level: none, moderate, full (round 1's true ¾ lift, ROWS_PER_LEVEL rows). */
export type LiftPx = 0 | 24 | 48

/** How the slopes area is drawn (./slopes-paint.ts): every combination walks the same field. */
export interface SlopesLook {
  sunlight?: boolean
  sunStrength?: number
  facing: FacingShade
  contours: ContourDetail
  terraces: boolean
  lift: LiftPx
}

/** Round 1's styles as looks (the tests; ./look.ts styleSettings for the panel). */
export function styleLook(style: SlopeStyle, shade = true): SlopesLook {
  const facing: FacingShade = style === 'shade' || shade ? 'current' : 'off'
  return { facing, contours: style === 'contours' ? 'current' : 'off', terraces: style === 'terraces', lift: style === 'lift' ? 48 : 0 }
}

/** The settings in a few words (the HUD). */
export function lookName(l: SlopesLook): string {
  const parts = [l.facing === 'off' ? 'no facing shade' : `${l.facing} shade`]
  if (l.contours !== 'off') parts.push(`${l.contours} contours`)
  if (l.terraces) parts.push('terraces')
  parts.push(l.lift ? `lift ${l.lift} px` : 'no lift')
  return parts.join(' · ')
}

/** Somewhere worth walking to, in field tiles, with what to look at. */
export interface SlopeSpot {
  name: string
  tx: number
  ty: number
  note: string
  /** A field tile to frame the view on (the feature), when it isn't where you stand. */
  look?: [number, number]
}

/** What the slopes area knows beyond a hand-made one. */
export interface SlopesInfo extends TerrainView {
  look: SlopesLook
  /** What's drawn, per view tile: kinds and faces (the collision map itself in the flat styles; the projected view in the lift, field width × (height + pad)). Never walked. */
  view: Layer
  /** Per view tile: the field tile shown there (-1: a face, or nothing), and the ground's height at its middle (NaN: nothing). */
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

/**
 * The knoll: a cone in the open valley, the same slope (0.2 level a tile)
 * every way round, its top rounded. Uphill, downhill and across it are the
 * same in every direction (the uphill slowdown's runs, ./slopes.ts uphillFactor).
 */
export const KNOLL = { x: 86, y: 91, r: 7, rc: 1.5, slope: 0.2 } as const
function knoll(x: number, y: number): number {
  const r = Math.hypot(x - KNOLL.x, y - KNOLL.y)
  if (r >= KNOLL.r) return 0
  return KNOLL.slope * (r >= KNOLL.rc ? KNOLL.r - r : KNOLL.r - KNOLL.rc / 2 - (r * r) / (2 * KNOLL.rc))
}

/** The smooth land, before cliffs. */
function base(x: number, y: number): number {
  const coast = 2 * smoothstep(98, 116, y)
  const roll = 0.25 * Math.sin(x / 13) * Math.sin(y / 11)
  return low(x, y) + range(x, y) + hills(x, y) + coast + roll + knoll(x, y)
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

/** Edge heights (n, e, s, w) of a field tile: its corners' means, so neighbours agree but across a cliff. */
export function fieldEdges(f: Field, i: number): [number, number, number, number] {
  const c = f.corner
  const o = i * 4
  return [q((c[o]! + c[o + 1]!) / 2), q((c[o + 1]! + c[o + 2]!) / 2), q((c[o + 2]! + c[o + 3]!) / 2), q((c[o + 3]! + c[o]!) / 2)]
}

export const walkableKind = (k: number) => k === KIND.flat || k === KIND.slope

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
      f.slope[i] = Math.sqrt(steepest(k, o)) / Q
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
      else if (steepest(f.corner, i * 4) > MAX_WALK_Q * MAX_WALK_Q) kind = KIND.steep
      f.kind[i] = kind
      let g: number = G.meadow
      if (r === 'sea') g = G.bank
      else if (r === 'gully') g = G.path
      else if (r === 'spire') g = G['wq-stone']
      else if (kind === KIND.crag) g = G['tops-crag']
      else if (kind === KIND.steep) g = G['tops-scree']
      else if (r === 'outcrop') g = G.meadow
      else if (r === 'plateau' || r === 'ramp') g = r === 'ramp' ? G.trodden : G.moss
      else if (ridge > 0.6 && Math.abs(tx + 0.5 - PASS_X) < 1.6 && ty < 76 && ty > 12) g = G.path
      else if (ridge > 0.6) g = z > 8 ? G['wq-stone'] : z > 5.5 ? G.trodden : G.meadow
      else if (ty > 104 && ty <= coastRow(tx)) g = G.moss
      f.ground[i] = g
    }
  // The rocky path: the walkable strip along the scree at the pass bowl's west side, stone like the scree beside it
  // (./slopes-paint.ts draws it as laid slabs): what's open has to read by its shape, not its colour.
  for (let ty = ROCKY.y0; ty <= ROCKY.y1; ty++)
    for (let tx = ROCKY.x0; tx <= ROCKY.x1; tx++) {
      const i = ty * w + tx
      if (!walkableKind(f.kind[i]!)) continue
      // Two tiles wide: within two tiles of the scree.
      let steep = false
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 2 && f.kind[(ty + dy) * w + tx + dx] === KIND.steep) steep = true
      if (steep) f.ground[i] = G['tops-path']
    }
  return f
}

/** Where the rocky path runs (tiles, inclusive): beside the scree, from the pass bowl's west side down toward the hills. */
export const ROCKY = { x0: 44, y0: 36, x1: 60, y1: 48 } as const

// ---------------------------------------------------------------- props and spots

const SPOTS: SlopeSpot[] = [
  { name: 'spawn', tx: 70, ty: 96, note: 'low ground in the valley; the range north, the hills west, the sea south' },
  { name: 'hills', tx: 30, ty: 88, note: 'rolling hills: walkable anywhere, no cliffs' },
  { name: 'pass-foot', tx: 72, ty: 70, note: 'where the climb to the pass starts (path ground)' },
  { name: 'pass-mid', tx: 72, ty: 48, note: 'halfway up: the too-steep band closes in on both sides' },
  { name: 'pass-top', tx: 72, ty: 31, note: 'the saddle, about level 6; shoulders too steep either side' },
  { name: 'pass-north', tx: 72, ty: 10, note: 'down the far side to the upland' },
  { name: 'steep-band', tx: 56, ty: 46, note: 'below the scree band on the range’s south side, looking north', look: [56, 40] },
  { name: 'crags', tx: 90, ty: 40, note: 'under the crags near the eastern peaks', look: [92, 31] },
  { name: 'spire', tx: 40, ty: 52, note: 'below the spire (level 15): its face, crags round its foot; no way up', look: [40, 40] },
  { name: 'outcrop-slope', tx: 103, ty: 82, note: 'the outcrop’s gentle side: walk south up onto it' },
  { name: 'outcrop-top', tx: 103, ty: 95, note: 'the outcrop’s edge, about 3 levels over the valley' },
  { name: 'outcrop-cliff', tx: 103, ty: 108, note: 'below the outcrop’s cliff, looking north at its face', look: [103, 100] },
  { name: 'sea-cliff', tx: 30, ty: 118, note: 'the sea cliff’s top, the sand flats below', look: [30, 123] },
  { name: 'gully', tx: 45, ty: 112, note: 'the one way down to the sea' },
  { name: 'sea', tx: 45, ty: 134, note: 'on the sand flats under the cliff' },
  { name: 'plateau', tx: 132, ty: 110, note: 'the plateau patch: whole levels, cliffs, ramps (like the generator)' },
  { name: 'behind-plateau', tx: 132, ty: 66, note: 'just north of the plateau patch: in the lift, hidden behind it (drawn as a silhouette)' },
  { name: 'around-east', tx: 128, ty: 40, note: 'round the range’s east end: the long way north' },
  { name: 'knoll', tx: 86, ty: 100, note: 'the knoll: a cone, 0.2 level a tile every way round (the uphill runs)', look: [86, 92] },
  { name: 'rocky-path', tx: 53, ty: 42, note: 'the rocky path beside the scree: walkable stone next to too-steep stone', look: [51, 40] },
  { name: 'spiral-ramp', tx: 130, ty: 93, note: 'the owner’s spot (2e): level 3 of the stepped plateau, its ramps and whole-level edges round you' },
  { name: 'legs-behind-ridge', tx: 132, ty: 65, note: 'just north of the plateau’s rim: in the full lift, only the legs are behind it (2e partial see-through)' }
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
      // Nothing on the knoll: its runs go straight up it.
      if (Math.hypot(tx + 0.5 - KNOLL.x, ty + 0.5 - KNOLL.y) < KNOLL.r + 1) continue
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

// ---------------------------------------------------------------- the maps

/**
 * The collision map, the same in every style: a map tile is a field tile,
 * and cliffs take their faces off the land south of them (the local face
 * rule, 3 rows a level). In the flat styles the face is drawn there; in the
 * lift the face is drawn lifted above it and its footprint is drawn as
 * talus, closed either way.
 */
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

/**
 * The lifted view (drawing only): each view tile shows what the lifted
 * columns put at its middle (./slopes.ts liftColumn): field ground, a face,
 * or nothing. Nobody walks it; the collision map stays the field's.
 */
function liftView(f: Field, view: ReturnType<typeof newLayer>, source: Int32Array, zs: Float32Array, pad: number, k: number): void {
  const w = view.w
  const H = view.h
  for (let tx = 0; tx < w; tx++) {
    const mid = liftColumn(f, tx, 0.5, pad, k)
    for (let sy = 0; sy < H; sy++) {
      const i = sy * w + tx
      const sp = spanAt(mid, sy + 0.5)
      source[i] = -1
      zs[i] = Number.NaN
      if (!sp) {
        setClosed(view, tx, sy, KIND.none)
        continue
      }
      if (sp.face) {
        setClosed(view, tx, sy, KIND.face)
        const rows = Math.max(1, Math.round(sp.s1 - sp.s0))
        view.faceTop[i] = sp.zS
        view.faceRows[i] = Math.min(127, rows)
        view.faceRow[i] = Math.min(rows - 1, Math.max(0, Math.floor(sy + 0.5 - sp.s0)))
        view.ground[i] = G['tops-crag']
        zs[i] = sp.zBot
        continue
      }
      const j = sp.ty * f.w + tx
      source[i] = j
      zs[i] = spanGround(sp, sy + 0.5).z
      view.ground[i] = f.ground[j]!
      setClosed(view, tx, sy, f.kind[j]! as Kind)
    }
  }
}

/** The nearest walkable tile to (tx, ty), by rings. */
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

/** Where a field tile's middle is drawn in the view (hidden or not): the lift moves it north k rows a level. */
export function mapPoint(info: SlopesInfo, tx: number, ty: number): { tx: number; ty: number } {
  return info.lift ? { tx, ty: Math.max(0, Math.round(ty + info.pad - info.k * fieldZ(info.field, tx, ty, 0.5, 0.5))) } : { tx, ty }
}

/**
 * The slopes area drawn one way. Walking and collision are the field's in
 * every setting (the collision map above, in field tiles and px); a setting
 * changes only the drawing: unlifted, the view is the collision map itself;
 * lifted, a projected view (liftView) with a margin on top. Switching never
 * moves anyone.
 */
export function buildSlopes(opts: AreaOptions, look: SlopesLook = styleLook('shade')): LabArea {
  const field = buildField()
  const props = fieldProps(field)
  const lift = look.lift > 0
  const k = look.lift / TILE_PX
  const pad = lift ? liftPad(field, k) : 0
  const w = field.w
  const h = field.h
  const surface = newLayer('surface', w, h)
  const cave = newLayer('cave', w, h)
  const stack: Stack = { w, h, layers: [surface, cave], portals: new Map() }
  const flatSource = new Int32Array(w * h).fill(-1)
  const flatZ = new Float32Array(w * h).fill(Number.NaN)
  flatMap(field, surface, flatSource, flatZ)
  // A tree on a tile a cliff's face took goes (its ground is the cliff's footprint).
  for (let i = 0; i < w * h; i++) if (surface.kind[i] === KIND.face && field.kind[i] === KIND.prop) field.kind[i] = KIND.slope
  let view = surface
  let source = flatSource
  let zs = flatZ
  if (lift) {
    view = newLayer('surface', w, h + pad)
    source = new Int32Array(w * (h + pad)).fill(-1)
    zs = new Float32Array(w * (h + pad)).fill(Number.NaN)
    liftView(field, view, source, zs, pad, k)
  }
  const top = new Int8Array(w * h)
  for (let i = 0; i < w * h; i++) top[i] = Number.isNaN(flatZ[i]!) ? 0 : Math.floor(flatZ[i]! + 1e-3)
  const info: SlopesInfo = { look, lift, k, field, pad, view, source, z: zs, spots: SPOTS }
  // Props are drawn where their tile shows (view tiles); crags get a rock each, so they read as standing rock in every style.
  const shown: PropSpot[] = []
  const place = (p: PropSpot, z: number) => {
    if (!lift) {
      // Not where a face took the tile.
      if (surface.kind[p.ty * w + p.tx] === KIND.face) return
      shown.push({ ...p, z, fieldX: p.tx * TILE_PX + 8, fieldY: (p.ty + 1) * TILE_PX - 0.01 })
      return
    }
    // Not on a cliff's footprint (talus in the lift), nor where it's hidden.
    if (surface.kind[p.ty * w + p.tx] === KIND.face) return
    const col = liftColumn(field, p.tx, 0.5, pad, k)
    const sp = col.find((s) => !s.face && s.ty === p.ty)
    if (!sp) return
    // Its foot: the tile's south edge, lifted; never below what shows of it.
    const foot = Math.min(sp.s1, sp.sS)
    shown.push({ ...p, ty: Math.max(0, Math.round(foot) - 1), z, fieldX: p.tx * TILE_PX + 8, fieldY: (p.ty + 1) * TILE_PX - 0.01 })
  }
  for (const p of props) place(p, fieldZ(field, p.tx, p.ty, 0.5, 1))
  for (let i = 0; i < field.w * field.h; i++) {
    if (field.kind[i] !== KIND.crag || surface.kind[i] !== KIND.crag) continue
    const tx = i % field.w
    const ty = (i - tx) / field.w
    place({ kind: 'crag', tx, ty, variant: Math.floor(hash(tx, ty, 65) * 4), blocks: true }, fieldZ(field, tx, ty, 0.5, 1))
  }
  const spot = (name: string) => SPOTS.find((s) => s.name === name)!
  const at = (name: string) => nearestWalkable(stack, spot(name).tx, spot(name).ty)
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

// ---------------------------------------------------------------- walking uphill

/** The slowdown is looked up again every this many px walked (so it doesn't jump at tile edges or depend on the frame rate). */
const UPHILL_STEP_PX = 2

/**
 * Walk the slopes area for dt seconds at `speed` px/s (full speed) going
 * (ux, uy) (a unit vector), sliding along what blocks (./levels.ts move);
 * with percentage uphill/downhill caps, looked up afresh every
 * UPHILL_STEP_PX. At most `most` px. What was asked of the walk (px, before
 * anything blocked it), the seconds that took (dt, or less when `most` came
 * first), and the last lookup.
 */
export function slopeWalk(stack: Stack, f: Field, w: Walker, ux: number, uy: number, speed: number, dt: number, uphill: number | boolean, most = Infinity, downhill = 0): { px: number; used: number; at: ReturnType<typeof uphillFactor> } {
  const len = Math.hypot(ux, uy)
  if (len) { ux /= len; uy /= len }
  const cap = typeof uphill === 'boolean' ? (uphill ? UPHILL_CAP : 0) : uphill / 100
  let left = dt
  let walked = 0
  let used = 0
  let at = uphillFactor(f, w.x, w.y - w.fh / 2, ux, uy, cap, downhill / 100)
  while (left > 1e-9 && walked < most - 1e-9 && speed > 0) {
    const h = Math.min(left, UPHILL_STEP_PX / (speed * 1.2))
    at = uphillFactor(f, w.x, w.y - w.fh / 2, ux, uy, cap, downhill / 100)
    const full = speed * at.k * h
    const d = Math.min(full, most - walked)
    move(stack, w, ux * d, uy * d)
    walked += d
    used += d < full ? d / (speed * at.k) : h
    left -= h
  }
  return { px: walked, used, at }
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
