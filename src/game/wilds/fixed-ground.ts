/**
 * Fixed ground through the Wilds' painter (docs/design/hearthwick-2.md 4,
 * 5, 9 #2): the town and the lots are painted per chunk, in the paint
 * worker, like generated chunks (./ground-paint.ts), so their grass, lanes
 * and fields share the Wilds' look and follow the year, and their edges
 * blend into the outskirts with no seam.
 *
 * A layout names curated terrains (src/lib/tile.ts TERRAIN), and a curated
 * terrain means one thing in the town and another in the Wilds: `grass_a`
 * is the town's grass and the Tangle's moss. So each fixed place paints by
 * its own style (`FIXED_GROUNDS`), and the painter reads a fixed tile under
 * an id of its own (`fixedPaintId`: the style and the terrain), next to the
 * generated land's TERRAIN ids. One table (./ground-table.ts paintTable)
 * covers both, so a chunk on either side of a seam reads the same tiles the
 * same way. The mapping is data: a new layout's grid (H1's 72×96 town) needs
 * no code here, only a row for any terrain it adds.
 */
import { lotAt } from '../../lib/lots.ts'
import { TERRAIN } from '../../lib/tile.ts'
import { fnv1a32Bytes } from '../../lib/hash.ts'
import type { FixedPlace } from '../../lib/places.ts'
import { CHUNK_TILES } from './coords.ts'
import { fixedPlaceOf, fixedSolidAt, footprintAt, sceneryOf, type FixedFootprint } from './fixed.ts'
import type { GroundCat, GroundSource, PaintTable } from './ground-paint.ts'
import { groundAt, solidAt } from './ground-view.ts'

type TerrainName = keyof typeof TERRAIN

/** How a curated terrain paints: its category, and how much trodden line it carries. */
type FixedPaint = GroundCat | readonly [GroundCat, number]

/**
 * What every fixed style shares: the built ground, in the curated names
 * the town and lot layouts use (scripts/export-hearthwick.ts): `path_a`
 * trodden lanes and yards, `path_b` the old broken road (the Lot Rows, the
 * ring lane), `cobble` setts (the spokes), `stone_a` the square's
 * flagstones, `tilled` fields, `water_b` the pond. `dirt` is bare earth:
 * a lot's cleared site and paths (the plot generator's), a placeholder
 * building's footprint box. The older curated names (roofs, walls, planks)
 * paint as what they would stand on.
 */
const BUILT: Partial<Record<TerrainName, FixedPaint>> = {
  path_a: 'trodden',
  path_b: 'road',
  dirt: 'trodden',
  sand: 'bank',
  water_a: 'water',
  water_b: 'water',
  bridge: 'laid',
  planks: 'laid',
  planks_dark: 'laid',
  stone_a: 'flags',
  stone_b: 'flags',
  stone_crack: 'flags',
  wall_stone: 'cobble',
  wall_moss: 'cobble',
  cobble: 'cobble',
  cobble_moss: 'road',
  roof: 'trodden',
  roof_edge: 'trodden',
  wall_house: 'trodden',
  door: 'trodden',
  window: 'trodden',
  tilled: 'tilled',
}

/**
 * Each fixed style's terrains (unlisted ones paint as `base`):
 * - the town: meadow grass, the woods' floor under its border trees;
 * - the west lots, toward the Tangle: moss, dark woods under the trees;
 * - the east lots, toward Lantern Road: meadow, woods under the few trees.
 * A lot's layout is its side's ground (`lots-west` woods, `lots-east`
 * meadow) under the plot generator's (server/internal/chunks/plots.go):
 * open land `grass_a`, trees `grass_b`, the cleared site and paths `dirt`.
 * A lot's side is H1's: lot `g` is west when `g` is even (`lotAt`).
 */
export const FIXED_GROUNDS = {
  town: { base: 'meadow', terrains: { ...BUILT, grass_a: 'meadow', grass_b: 'woods', grass_c: 'meadow', flowers: 'meadow', fence: 'meadow' } },
  'lot-west': { base: 'moss', terrains: { ...BUILT, grass_a: 'moss', grass_b: 'woods', grass_c: 'meadow', flowers: 'meadow', fence: 'moss' } },
  'lot-east': { base: 'meadow', terrains: { ...BUILT, grass_a: 'meadow', grass_b: 'woods', grass_c: 'meadow', flowers: 'meadow', fence: 'meadow' } },
} as const satisfies Record<string, { base: GroundCat; terrains: Partial<Record<TerrainName, FixedPaint>> }>

export type FixedStyle = keyof typeof FIXED_GROUNDS
const STYLES = Object.keys(FIXED_GROUNDS) as FixedStyle[]

/** Fixed paint ids sit above every TERRAIN id: style (from 1) × this, plus the terrain. */
const FIXED_ID_STRIDE = 64

/** The id the painter reads a fixed tile under. */
export function fixedPaintId(style: FixedStyle, terrain: number): number {
  return (STYLES.indexOf(style) + 1) * FIXED_ID_STRIDE + terrain
}

/** Does a paint id name fixed ground? */
export function isFixedPaintId(id: number): boolean {
  return id >= FIXED_ID_STRIDE
}

/** How a fixed place's chunk paints: a lot by its side of the town (lot `g` is west when `g` is even), anything else as the town. */
export function fixedStyle(place: Pick<FixedPlace, 'kind'>, cx: number, cy: number): FixedStyle {
  if (place.kind !== 'plots') return 'town'
  const g = lotAt(cx, cy)
  return g !== null && g % 2 === 1 ? 'lot-east' : 'lot-west'
}

let table: PaintTable | null = null

/** Every fixed style's rows for the painter's table (settled ground: the white quiet's drifts thin out over it). */
export function fixedPaintTable(): PaintTable {
  if (table) return table
  const rows: [number, GroundCat, number, number][] = []
  for (const style of STYLES) {
    const { base, terrains } = FIXED_GROUNDS[style] as { base: GroundCat; terrains: Partial<Record<TerrainName, FixedPaint>> }
    for (const [name, id] of Object.entries(TERRAIN) as [TerrainName, number][]) {
      const p = terrains[name] ?? base
      const [cat, trail] = typeof p === 'string' ? [p, 0] : p
      rows.push([fixedPaintId(style, id), cat, trail, 1])
    }
  }
  return (table = rows)
}

/** A footprint's tiles as the painter reads them (footprint-local, row-major), worked out once per footprint. */
const grids = new WeakMap<FixedFootprint, Int32Array>()

/**
 * A footprint's paint ids. The ground under a drawn building or stall is
 * its grass (as the old tileset laid it: ../area/terrain.ts groundUnder),
 * and a lot's cleared tiles are trodden earth, feathered by the painter.
 */
export function fixedPaintGrid(fp: FixedFootprint): Int32Array {
  const had = grids.get(fp)
  if (had) return had
  const grid = new Int32Array(fp.w * fp.h)
  const styleAt = (lx: number, ly: number) => fixedStyle(fp.place, Math.floor((fp.tx + lx) / CHUNK_TILES), Math.floor((fp.ty + ly) / CHUNK_TILES))
  for (let y = 0; y < fp.h; y++) for (let x = 0; x < fp.w; x++) grid[y * fp.w + x] = fixedPaintId(styleAt(x, y), fp.ground[y]![x]!)
  for (const list of fp.objects.values())
    for (const o of list) {
      const under = sceneryOf(o)?.groundUnder
      if (!under) continue
      for (let y = under.ty; y < under.ty + under.th; y++)
        for (let x = under.tx; x < under.tx + under.tw; x++) {
          const lx = x - fp.tx
          const ly = y - fp.ty
          if (lx >= 0 && ly >= 0 && lx < fp.w && ly < fp.h) grid[ly * fp.w + lx] = fixedPaintId(styleAt(lx, ly), under.tile)
        }
    }
  for (const [lx, ly] of fp.cleared ?? []) grid[ly * fp.w + lx] = fixedPaintId(styleAt(lx, ly), TERRAIN.dirt)
  grids.set(fp, grid)
  return grid
}

/** The paint id at a fixed world tile, or null (not fixed, or its chunks aren't here yet). */
export function fixedPaintAt(tx: number, ty: number): number | null {
  const fp = footprintAt(Math.floor(tx / CHUNK_TILES), Math.floor(ty / CHUNK_TILES))
  if (!fp) return null
  return fixedPaintGrid(fp)[(ty - fp.ty) * fp.w + (tx - fp.tx)]!
}

const onFixed = (tx: number, ty: number) => fixedPlaceOf(Math.floor(tx / CHUNK_TILES), Math.floor(ty / CHUNK_TILES)) !== null

/**
 * The open map's ground as the painter reads it: fixed tiles by their
 * style, generated ones by their TERRAIN id (null where nothing is known,
 * which paints as deep woods). Generated and fixed chunks both paint from
 * it, so a seam between them is painted the same from either side.
 */
export const paintSource: GroundSource = {
  ground: (tx, ty) => (onFixed(tx, ty) ? fixedPaintAt(tx, ty) : groundAt(tx, ty)),
  solid: (tx, ty) => (onFixed(tx, ty) ? fixedSolidAt(tx, ty) : solidAt(tx, ty)),
}

const hashes = new WeakMap<FixedFootprint, Map<string, number>>()

/** A hash of what a fixed chunk paints from (its paint ids and solids): a lot whose clearing changed is repainted. */
export function fixedChunkHash(fp: FixedFootprint, cx: number, cy: number): number {
  let byChunk = hashes.get(fp)
  if (!byChunk) hashes.set(fp, (byChunk = new Map()))
  const key = `${cx},${cy}`
  const had = byChunk.get(key)
  if (had !== undefined) return had
  const grid = fixedPaintGrid(fp)
  const lx0 = cx * CHUNK_TILES - fp.tx
  const ly0 = cy * CHUNK_TILES - fp.ty
  const bytes = new Uint8Array(CHUNK_TILES * CHUNK_TILES * 2)
  for (let y = 0; y < CHUNK_TILES; y++)
    for (let x = 0; x < CHUNK_TILES; x++) {
      const i = y * CHUNK_TILES + x
      bytes[i * 2] = grid[(ly0 + y) * fp.w + lx0 + x]! & 255
      bytes[i * 2 + 1] = ((grid[(ly0 + y) * fp.w + lx0 + x]! >> 8) & 127) | (fp.solid[ly0 + y]![lx0 + x] ? 128 : 0)
    }
  const h = fnv1a32Bytes(bytes)
  byChunk.set(key, h)
  return h
}
