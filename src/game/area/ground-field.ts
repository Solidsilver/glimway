/**
 * The village and Commons ground, worked out per tile (no Phaser, no DOM:
 * tests run it). ./terrain.ts lays the result out as a tilemap over a
 * tileset built at boot.
 *
 *  - Base tiles: the playtest-1 ground (src/game/atlas-plan.ts GROUND_FAMILIES),
 *    a variant picked by a stable hash of the tile's position. Flowered grass
 *    stays where the map puts flowers; moss only in small clumps of the
 *    map's darker grass, so both read as accents, never a checkerboard.
 *  - Transitions, in the Tangle's manner (src/game/wilds/tangle-art.ts):
 *    where grass meets a path, the road, the square's flagstones, sand or
 *    water, the boundary is a ragged painted edge with a dark outline on the
 *    lower ground and a shadow cast down-right from the higher, lit from
 *    the upper left. Every texel's ground is decided by one field over the
 *    tile's 3×3 neighbourhood (distance to each kind of ground, roughened
 *    by noise over world position), so a tile and its neighbour agree on
 *    every texel near their shared border: the edge runs across tile
 *    borders without a seam and never repeats. Each edge tile gets its own
 *    overlay cell (a few hundred in the Commons).
 */
import { TERRAIN } from '../textures.ts'
import { GROUND_WATER_BEDS, GROUND_WATER_FRAMES, bedFrame } from '../atlas-plan.ts'

export type GroundClass = 'grass' | 'dirt' | 'road' | 'flag' | 'sand' | 'water'
/** Ground drawn with the old expansion cells (walls, roofs, fences, bridge planks, the ruin's stone). */
export type Ground = GroundClass | null

/** Which ground each terrain id is. */
export const GROUND_CLASS: Readonly<Record<number, GroundClass>> = {
  [TERRAIN.grass_a]: 'grass',
  [TERRAIN.grass_b]: 'grass',
  [TERRAIN.grass_c]: 'grass',
  [TERRAIN.flowers]: 'grass',
  [TERRAIN.path_a]: 'dirt',
  [TERRAIN.path_b]: 'dirt',
  [TERRAIN.dirt]: 'dirt',
  [TERRAIN.sand]: 'sand',
  [TERRAIN.water_a]: 'water',
  [TERRAIN.water_b]: 'water',
  // The banks run on under a bridge; its planks are drawn over the water.
  [TERRAIN.bridge]: 'water',
  [TERRAIN.cobble_moss]: 'road',
  [TERRAIN.cobble]: 'flag',
}

export function classOf(id: number): Ground {
  return GROUND_CLASS[id] ?? null
}

/**
 * Every tile's ground, tidied: the Commons lays its lane in mossy cobbles
 * with the odd clean one (and its square in clean cobbles with mossy
 * holes) for variety. Here that variety is the road's own texture: a clean
 * cobble with fewer than two clean neighbours is road, and a mossy one
 * with three or four clean neighbours is part of the square's flagstones.
 */
export function classGrid(ground: number[][]): Ground[][] {
  const h = ground.length
  const w = ground[0]?.length ?? 0
  const flagAround = (x: number, y: number) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => {
      const tx = x + dx
      const ty = y + dy
      return tx >= 0 && ty >= 0 && tx < w && ty < h && ground[ty][tx] === TERRAIN.cobble
    }).length
  return ground.map((row, y) =>
    row.map((id, x) => {
      if (id === TERRAIN.cobble && flagAround(x, y) < 2) return 'road'
      if (id === TERRAIN.cobble_moss && flagAround(x, y) >= 3) return 'flag'
      return classOf(id)
    }),
  )
}

/** Which ground sits higher: the higher one's edge lips over the lower, outlined and casting shade. */
export const RANK: Readonly<Record<GroundClass, number>> = { water: 0, sand: 1, dirt: 2, road: 3, flag: 4, grass: 5 }

/** The tile drawn on each ground (frame names in the playtest-1 ground pack). */
export const BASE_TILES: Readonly<Record<GroundClass | 'flowers' | 'moss', readonly string[]>> = {
  grass: ['ground-grass-01', 'ground-grass-02', 'ground-grass-03', 'ground-grass-04'],
  flowers: ['ground-flowered-grass-01', 'ground-flowered-grass-02'],
  moss: ['ground-forest-moss-01', 'ground-forest-moss-02'],
  dirt: ['ground-packed-dirt-01', 'ground-packed-dirt-02', 'ground-packed-dirt-03'],
  road: ['ground-old-cobbled-road-01', 'ground-old-cobbled-road-02', 'ground-old-cobbled-road-03'],
  flag: ['ground-village-flagstones-01', 'ground-village-flagstones-03', 'ground-village-flagstones-04'],
  sand: ['ground-sand-by-water-01', 'ground-sand-by-water-03'],
  // Each water tile is the first frame of one of WATER_SETS.
  water: GROUND_WATER_BEDS.map((b) => bedFrame(b, 0)),
}
/**
 * Every water tile's frames: the three water beds, animated in step with
 * the gentle water's light (src/game/atlas-plan.ts GROUND_WATER_BEDS). The
 * gentle water itself isn't drawn: it is darker than the beds and read as a
 * checkerboard among them.
 */
export const WATER_SETS: readonly (readonly string[])[] = GROUND_WATER_BEDS.map((b) => GROUND_WATER_FRAMES.map((_, f) => bedFrame(b, f)))
/** The frames the banks' water is painted from (the first bed's), at WATER_FPS. */
export const WATER_FRAMES = WATER_SETS[0]
export const WATER_FPS = 3

/** The texture each ground's transitions are painted from (its family's reference tile). */
export const EDGE_TEXTURE: Readonly<Record<GroundClass, string>> = {
  grass: 'ground-grass-01',
  dirt: 'ground-packed-dirt-01',
  road: 'ground-old-cobbled-road-01',
  flag: 'ground-village-flagstones-01',
  sand: 'ground-sand-by-water-01',
  water: 'ground-water-bed-variant-01@0',
}

/** Deterministic 0..1 for integer inputs. */
export function hash01(x: number, y: number, s = 0): number {
  let v = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791)) | 0
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise on a lattice; `period` (cells) wraps it, so it repeats every period. */
function lattice(seed: number, period: number): (x: number, y: number) => number {
  const at = (x: number, y: number) => hash01(((x % period) + period) % period, ((y % period) + period) % period, seed)
  return (x, y) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
    return a + (b - a) * sy
  }
}

/** Moss grows in clumps (cells of this many tiles) where the map has its darker grass. */
const MOSS_CLUMP = 3
const MOSS_SHARE = 0.72
const mossNoise = lattice(0x6d055, 1 << 20)

/** The base tile for a terrain id of ground `c` at a tile position (null: an old expansion cell is drawn instead). */
export function baseTile(id: number, c: Ground, x: number, y: number): string | null {
  if (!c) return null
  const pick = (list: readonly string[]) => list[Math.floor(hash01(x, y, 7) * list.length)]
  if (c === 'grass') {
    if (id === TERRAIN.flowers) return pick(BASE_TILES.flowers)
    if (id === TERRAIN.grass_b && mossNoise(x / MOSS_CLUMP, y / MOSS_CLUMP) > MOSS_SHARE) return pick(BASE_TILES.moss)
    return pick(BASE_TILES.grass)
  }
  return pick(BASE_TILES[c])
}

/**
 * A tile's neighbourhood: the 3×3 grounds around it (row-major, centre at
 * 4). Ground drawn with old cells, and the map's outside, count as the
 * centre's own: no transition is drawn towards them.
 */
export function neighbourhood(grid: Ground[][], x: number, y: number): GroundClass[] | null {
  const centre = grid[y][x]
  if (!centre) return null
  const h = grid.length
  const w = grid[0].length
  const out: GroundClass[] = []
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const tx = Math.max(0, Math.min(w - 1, x + dx))
      const ty = Math.max(0, Math.min(h - 1, y + dy))
      out.push(grid[ty][tx] ?? centre)
    }
  return out
}

/** The overlay cell a tile needs, as a key (null: none, its neighbourhood is all one ground). */
export function edgeKey(n: GroundClass[] | null, x: number, y: number): string | null {
  if (!n || n.every((c) => c === n[4])) return null
  return `${n.join(',')}@${x},${y}`
}

export function parseEdgeKey(key: string): { n: GroundClass[]; tx: number; ty: number } {
  const [list, at] = key.split('@')
  const [tx, ty] = at.split(',').map(Number)
  return { n: list.split(',') as GroundClass[], tx, ty }
}

/** How each ground's edge is roughened (world px): `bias` < 0 spreads it over its neighbours. */
const EDGE_SHAPE: Readonly<Record<GroundClass, { bias: number; amp: number }>> = {
  grass: { bias: -1, amp: 5.5 },
  dirt: { bias: 0, amp: 5 },
  road: { bias: 0.25, amp: 4.5 },
  flag: { bias: 0.5, amp: 2.5 },
  sand: { bias: 0, amp: 5 },
  water: { bias: 0.75, amp: 4.5 },
}
/** Per-texel roughness on top of the wobble (world px). */
const JITTER = 0.9

const SEEDS: Readonly<Record<GroundClass, number>> = { grass: 11, dirt: 23, road: 37, flag: 41, sand: 53, water: 67 }
/** The wobble, in world px like the Tangle's: a broad sway and a finer ripple. */
const broad = Object.fromEntries((Object.keys(SEEDS) as GroundClass[]).map((c) => [c, lattice(SEEDS[c], 1 << 20)])) as Record<GroundClass, (x: number, y: number) => number>
const fine = Object.fromEntries((Object.keys(SEEDS) as GroundClass[]).map((c) => [c, lattice(SEEDS[c] * 31 + 7, 1 << 20)])) as Record<GroundClass, (x: number, y: number) => number>

/**
 * The ground at every texel of tile (tx, ty) and a `margin`-texel ring
 * around it (`k` texels per world px), as indices into `classes`. The
 * wobble is a function of world position, so the tile and its neighbours
 * agree on every texel they both look at. Exported for tests.
 */
export function groundField(n: GroundClass[], tx: number, ty: number, k: number, margin: number): { classes: GroundClass[]; size: number; at: Int8Array } {
  const classes = [...new Set(n)]
  const cell = 16 * k
  const size = cell + 2 * margin
  const at = new Int8Array(size * size)
  // Each square of the neighbourhood, in world px relative to the centre tile.
  const sq = n.map((_, i) => ({ x0: ((i % 3) - 1) * 16, y0: (Math.floor(i / 3) - 1) * 16 }))
  const dist = new Float64Array(9)
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const px = (ix - margin + 0.5) / k
      const py = (iy - margin + 0.5) / k
      for (let i = 0; i < 9; i++) {
        const dx = Math.max(sq[i].x0 - px, 0, px - (sq[i].x0 + 16))
        const dy = Math.max(sq[i].y0 - py, 0, py - (sq[i].y0 + 16))
        dist[i] = Math.hypot(dx, dy)
      }
      const wx = tx * 16 + px
      const wy = ty * 16 + py
      const jx = tx * 16 * k + ix - margin
      const jy = ty * 16 * k + iy - margin
      let best = 0
      let bestE = Infinity
      for (let c = 0; c < classes.length; c++) {
        const cls = classes[c]
        let inside = Infinity
        let outside = Infinity
        for (let i = 0; i < 9; i++) {
          if (n[i] === cls) inside = Math.min(inside, dist[i])
          else outside = Math.min(outside, dist[i])
        }
        // Signed distance to this ground (negative inside it).
        const sd = inside > 0 ? inside : -Math.min(outside, 16)
        const shape = EDGE_SHAPE[cls]
        const wobble = (broad[cls](wx / 9, wy / 9) - 0.5) * 2 + (fine[cls](wx / 3.5, wy / 3.5) - 0.5) * 0.8
        const e = sd + shape.bias + shape.amp * wobble + (hash01(jx, jy, SEEDS[cls]) - 0.5) * 2 * JITTER
        if (e < bestE) {
          bestE = e
          best = c
        }
      }
      at[iy * size + ix] = best
    }
  }
  return { classes, size, at }
}

/** Reads a texel of a ground's texture at frame `f` (tile-local texel coords, already wrapped). */
export type TexelSource = (c: GroundClass, f: number, x: number, y: number) => [number, number, number]

const OUTLINE: [number, number, number] = [0x24, 0x1a, 0x1c]

/**
 * Paint a transition overlay: `k`×16 texels a side, RGBA, transparent where
 * the tile's own base shows untouched. The lower ground gets a dark outline
 * where a higher one meets it (half a world px wide) and a shadow below and
 * right of it; the higher ground's edge facing the light is lit a little.
 */
export function paintEdge(n: GroundClass[], tx: number, ty: number, k: number, frame: number, tex: TexelSource): Uint8ClampedArray {
  const cell = 16 * k
  const ow = Math.max(1, Math.round(k / 2))
  const sw = ow * 3
  const margin = sw + 1
  const { classes, size, at } = groundField(n, tx, ty, k, margin)
  const centre = classes.indexOf(n[4])
  const rank = classes.map((c) => RANK[c])
  const out = new Uint8ClampedArray(cell * cell * 4)
  const cls = (x: number, y: number) => at[(y + margin) * size + x + margin]
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const c = cls(x, y)
      const r = rank[c]
      let outline = false
      let shade = false
      let lit = false
      for (let d = 1; d <= ow && !outline; d++) {
        if (rank[cls(x + d, y)] > r || rank[cls(x - d, y)] > r || rank[cls(x, y + d)] > r || rank[cls(x, y - d)] > r) outline = true
      }
      if (!outline) {
        // Shade from higher ground up and to the left.
        for (let d = 1; d <= sw && !shade; d++) if (rank[cls(x - d, y - d)] > r || rank[cls(x, y - d)] > r || rank[cls(x - d, y)] > r) shade = true
        // A lit lip on higher ground whose lower neighbour lies up or left.
        for (let d = 1; d <= ow && !lit; d++) if (rank[cls(x, y - d)] < r || rank[cls(x - d, y)] < r) lit = true
      }
      if (c === centre && !outline && !shade && !lit) continue
      let [R, G, B] = tex(classes[c], frame, x, y)
      if (outline) {
        R = R * 0.3 + OUTLINE[0] * 0.7
        G = G * 0.3 + OUTLINE[1] * 0.7
        B = B * 0.3 + OUTLINE[2] * 0.7
      } else if (shade) {
        R *= 0.74
        G *= 0.74
        B *= 0.8
      } else if (lit) {
        R = R + (255 - R) * 0.18
        G = G + (255 - G) * 0.18
        B = B + (255 - B) * 0.12
      }
      const o = (y * cell + x) * 4
      out[o] = R
      out[o + 1] = G
      out[o + 2] = B
      out[o + 3] = 255
    }
  }
  return out
}

/** Does an overlay show water anywhere (then it animates with the water)? */
export function edgeHasWater(n: GroundClass[]): boolean {
  return n.includes('water')
}
