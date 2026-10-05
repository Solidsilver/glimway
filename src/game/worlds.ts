/**
 * World builder for the three demo areas. Maps are generated deterministically
 * from code (seeded) — part of the original, code-native asset set.
 */
import type { AreaId } from '../lib/state.ts'
import { TERRAIN, TILE } from './textures.ts'
import { buildCommons, commonsForeground, COMMONS_FROM_VILLAGE } from './commons.ts'
import { buildRoom } from './cottage.ts'

export type NpcId = 'mara' | 'pip' | 'orrin'
/** Ember spots: the hearth lantern (warm rest), road lanterns, the chest. */
export type EmberSpotId = 'hearth' | 'road-1' | 'road-2' | 'road-3' | 'chest'
/** 'library': the Hearthwick Library door; `paper:<id>`: a found-text pickup (content/papers.ts). */
export type InteractId = NpcId | 'clue' | 'lantern' | EmberSpotId | 'library' | `paper:${string}` | `home:${string}`
/** wisp: hopping slime/mushroom; beetle: telegraphed straight-line charger. */
export type EnemyType = 'wisp' | 'beetle' | 'guardian'

export interface NpcSpot {
  id: NpcId
  tx: number
  ty: number
}

export interface EnemySpot {
  id: string
  type: EnemyType
  tx: number
  ty: number
}

export interface ExitDef {
  tx: number
  ty: number
  tw: number
  th: number
  to: AreaId
  entry: { tx: number; ty: number }
  /** Sign text (default: the destination's name); null hides the sign (a doorway). */
  label?: string | null
}

/** Supplied atlas props placed in the world at a consistent small-world scale. */
export interface PropSpot {
  frame: string
  tx: number
  ty: number
  /** Deliberate display height in px, chosen for the 16px-avatar world. */
  h: number
  /** Explicit collision box [w, h] in px at the prop's base. */
  body: [number, number]
  /** Light-capable prop: which flame this is ('village', 'shrine', or a road lantern id). */
  light?: string
}

/**
 * Code-drawn scenery (src/game/commons-art.ts): hedges, fences, the Commons
 * gate and well, Silas's yard. Visual only — collision is the solid grid.
 */
export interface ScenerySpot {
  /** Texture key. */
  key: string
  /** Anchor in px (bottom-centre unless `originX` says otherwise). */
  x: number
  y: number
  originX?: number
  /** Fixed depth, or 'y' to sort by the anchor (the default). */
  depth?: number | 'y'
}

export interface WorldData {
  areaId: AreaId
  width: number
  height: number
  widthPx: number
  heightPx: number
  ground: number[][]
  solid: boolean[][]
  trees: { tx: number; ty: number }[]
  bushes: { tx: number; ty: number }[]
  rocks: { tx: number; ty: number }[]
  npcs: NpcSpot[]
  enemies: EnemySpot[]
  exits: ExitDef[]
  props: PropSpot[]
  discoverySpots: { id: string; label: string; tx: number; ty: number }[]
  well: { tx: number; ty: number } | null
  mural: { tx: number; ty: number } | null
  shrine: { tx: number; ty: number } | null
  villageLantern: { tx: number; ty: number } | null
  /** Places where embers are spent (each sits on a solid prop). */
  emberSpots: { id: EmberSpotId; tx: number; ty: number }[]
  spawn: { tx: number; ty: number }
  /** The Hearthwick Library's door tile (village only): opens the reading room. */
  library?: { tx: number; ty: number }
  /** Code-drawn scenery sprites (the Commons). */
  scenery?: ScenerySpot[]
}

// ---------------------------------------------------------------- utilities

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Grid {
  width: number
  height: number
  ground: number[][]
  solid: boolean[][]

  constructor(width: number, height: number, base: number) {
    this.width = width
    this.height = height
    this.ground = Array.from({ length: height }, () => Array.from({ length: width }, () => base))
    this.solid = Array.from({ length: height }, () => Array.from({ length: width }, () => false))
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height
  }

  set(tx: number, ty: number, tile: number, solid = false): void {
    if (!this.inBounds(tx, ty)) return
    this.ground[ty][tx] = tile
    this.solid[ty][tx] = solid
  }

  rect(tx: number, ty: number, w: number, h: number, tile: number, solid = false): void {
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) this.set(x, y, tile, solid)
  }

  row(tx: number, ty: number, w: number, tile: number, solid = false): void {
    this.rect(tx, ty, w, 1, tile, solid)
  }

  col(tx: number, ty: number, h: number, tile: number, solid = false): void {
    this.rect(tx, ty, 1, h, tile, solid)
  }

  /** House: two roof rows + wall rows with door and window, all solid. */
  house(tx: number, ty: number, w: number): void {
    this.row(tx, ty, w, TERRAIN.roof_edge, true)
    this.row(tx, ty + 1, w, TERRAIN.roof, true)
    for (let x = tx; x < tx + w; x++) this.set(x, ty + 2, TERRAIN.wall_house, true)
    for (let x = tx; x < tx + w; x++) this.set(x, ty + 3, TERRAIN.wall_house, true)
    this.set(tx + Math.floor(w / 2) - 1, ty + 3, TERRAIN.door, true)
    this.set(tx + Math.floor(w / 2) + 1, ty + 2, TERRAIN.window, true)
  }
}

function isGrassLike(tile: number): boolean {
  return tile === TERRAIN.grass_a || tile === TERRAIN.grass_b || tile === TERRAIN.grass_c
}

/** True if a tile sits on or beside an area exit — props must never block one. */
function nearExit(world: Pick<WorldData, 'exits'>, tx: number, ty: number): boolean {
  return world.exits.some((e) => tx >= e.tx - 1 && tx <= e.tx + e.tw && ty >= e.ty - 1 && ty <= e.ty + e.th)
}

/** Scatter props on free grass tiles, keeping clearings around kept spots. */
function scatter(grid: Grid, rng: () => number, count: number, kept: Array<{ tx: number; ty: number }>): { tx: number; ty: number }[] {
  const out: { tx: number; ty: number }[] = []
  let attempts = 0
  while (out.length < count && attempts < count * 60) {
    attempts++
    const tx = Math.floor(rng() * grid.width)
    const ty = Math.floor(rng() * grid.height)
    if (!isGrassLike(grid.ground[ty][tx]) || grid.solid[ty][tx]) continue
    if (kept.some((p) => Math.abs(p.tx - tx) < 4 && Math.abs(p.ty - ty) < 4)) continue
    if (out.some((p) => Math.abs(p.tx - tx) < 2 && Math.abs(p.ty - ty) < 2)) continue
    out.push({ tx, ty })
  }
  return out
}

// ---------------------------------------------------------------- village

function buildVillage(): WorldData {
  const W = 42
  const H = 26
  const rng = mulberry32(20261002)
  const g = new Grid(W, H, TERRAIN.grass_a)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const r = rng()
      g.ground[y][x] = r < 0.55 ? TERRAIN.grass_a : r < 0.85 ? TERRAIN.grass_b : TERRAIN.grass_c
    }

  // Flower patches
  g.rect(28, 15, 5, 3, TERRAIN.flowers)
  g.rect(7, 18, 4, 3, TERRAIN.flowers)
  g.set(24, 8, TERRAIN.flowers)
  g.set(36, 14, TERRAIN.flowers)

  // Pond with sandy rim
  g.rect(33, 19, 6, 4, TERRAIN.water_a, true)
  g.col(33, 19, 4, TERRAIN.water_b, true)
  g.row(33, 18, 6, TERRAIN.sand)
  g.col(32, 19, 4, TERRAIN.sand)

  // Houses
  g.house(5, 4, 6)
  g.house(17, 3, 7)
  g.house(31, 4, 6)

  // Paths
  g.row(3, 10, W - 3, TERRAIN.path_a)
  g.col(8, 7, 3, TERRAIN.path_a)
  g.col(20, 7, 3, TERRAIN.path_a)
  g.col(33, 8, 2, TERRAIN.path_a)
  g.col(13, 10, 3, TERRAIN.path_a)
  // A lane off the road down to the Commons gate (east edge, below the road).
  g.col(39, 11, 5, TERRAIN.path_a)
  g.row(39, 15, 3, TERRAIN.path_a)

  // Garden fence with a gap
  g.row(24, 13, 7, TERRAIN.fence, true)
  g.row(24, 18, 7, TERRAIN.fence, true)
  g.col(24, 13, 6, TERRAIN.fence, true)
  g.col(30, 13, 6, TERRAIN.fence, true)
  g.set(27, 18, TERRAIN.grass_a)
  g.solid[18][27] = false

  // Unbroken border trees, with one gap on the east edge to the woodland
  // (the journey reads left to right: village → woodland → ruin).
  for (let x = 0; x < W; x++) {
    scatterOne(g, x, 0)
    scatterOne(g, x, H - 1)
  }
  for (let y = 0; y < H; y++) {
    scatterOne(g, 0, y)
    if ((y < 9 || y > 11) && (y < 14 || y > 16)) scatterOne(g, W - 1, y)
  }

  const well = { tx: 13, ty: 12 }
  const villageLantern = { tx: 11, ty: 12 }

  const npcs: NpcSpot[] = [
    { id: 'mara', tx: 16, ty: 13 },
    { id: 'orrin', tx: 21, ty: 9 },
    { id: 'pip', tx: 28, ty: 17 }
  ]

  const villageExits: ExitDef[] = [
    { tx: W - 1, ty: 9, tw: 1, th: 3, to: 'woodland', entry: { tx: 2, ty: 15 } },
    { tx: W - 1, ty: 14, tw: 1, th: 3, to: 'commons', entry: { ...COMMONS_FROM_VILLAGE } }
  ]
  const trees = collectTrees(g)
  const scatteredBushes = scatter(g, rng, 6, [...npcs, well, villageLantern]).filter((b) => !nearExit({ exits: villageExits }, b.tx, b.ty))
  const scatteredRocks = scatter(g, rng, 3, [...npcs, well, villageLantern]).filter((r) => !nearExit({ exits: villageExits }, r.tx, r.ty))

  // The Hearthwick Library: a small reading house on the square's quiet
  // south-west corner, off the quest route. Raised after the scatter so the
  // rest of the village keeps its seeded layout; nothing may crowd its door.
  const libraryAt = { tx: 2, ty: 14, w: 5 }
  g.house(libraryAt.tx, libraryAt.ty, libraryAt.w)
  const library = { tx: libraryAt.tx + Math.floor(libraryAt.w / 2) - 1, ty: libraryAt.ty + 3 }
  const clearOfLibrary = (p: { tx: number; ty: number }) =>
    !(p.tx >= libraryAt.tx - 1 && p.tx <= libraryAt.tx + libraryAt.w && p.ty >= libraryAt.ty - 1 && p.ty <= libraryAt.ty + 5)
  const bushes = scatteredBushes.filter(clearOfLibrary)
  const rocks = scatteredRocks.filter(clearOfLibrary)

  // Supplied atlas props, consistent small-world display heights
  const props: PropSpot[] = [
    { frame: 'lantern-post', tx: 11, ty: 12, h: 32, body: [8, 6], light: 'village' },
    { frame: 'patched-bench', tx: 9, ty: 13, h: 18, body: [16, 6] },
    { frame: 'bread-basket', tx: 6, ty: 8, h: 12, body: [12, 6] },
    { frame: 'flower-planter', tx: 22, ty: 7, h: 16, body: [14, 6] },
    { frame: 'tool-crate', tx: 24, ty: 8, h: 16, body: [12, 8] },
    { frame: 'stone-milestone', tx: 38, ty: 12, h: 18, body: [10, 6] }
  ]

  return {
    areaId: 'village',
    width: W,
    height: H,
    widthPx: W * TILE,
    heightPx: H * TILE,
    ground: g.ground,
    solid: g.solid,
    trees,
    bushes,
    rocks,
    npcs,
    enemies: [],
    exits: villageExits,
    props,
    discoverySpots: [],
    well,
    mural: null,
    shrine: null,
    villageLantern,
    emberSpots: [{ id: 'hearth', tx: villageLantern.tx, ty: villageLantern.ty }],
    spawn: { tx: 7, ty: 11 },
    library
  }
}

// ---------------------------------------------------------------- woodland

function buildWoodland(): WorldData {
  const W = 56
  const H = 30
  const rng = mulberry32(73191)
  const g = new Grid(W, H, TERRAIN.grass_a)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const r = rng()
      g.ground[y][x] = r < 0.6 ? TERRAIN.grass_a : r < 0.9 ? TERRAIN.grass_b : TERRAIN.grass_c
    }
  g.set(9, 12, TERRAIN.flowers)
  g.set(30, 24, TERRAIN.flowers)
  g.set(47, 8, TERRAIN.flowers)

  // Winding path, village (left) to ruin (right)
  g.row(1, 15, 12, TERRAIN.path_a)
  g.col(12, 15, 6, TERRAIN.path_a)
  g.row(12, 20, 15, TERRAIN.path_a)
  g.col(26, 12, 9, TERRAIN.path_a)
  g.row(26, 12, 15, TERRAIN.path_a)
  g.col(40, 12, 11, TERRAIN.path_a)
  g.row(40, 22, 15, TERRAIN.path_a)

  // Stream with a bridge where the path crosses
  g.col(20, 4, 22, TERRAIN.water_a, true)
  g.col(21, 4, 22, TERRAIN.water_b, true)
  g.row(19, 3, 4, TERRAIN.sand)
  g.row(19, 26, 4, TERRAIN.sand)
  g.set(20, 20, TERRAIN.bridge)
  g.set(21, 20, TERRAIN.bridge)

  // Dense border trees
  for (let x = 0; x < W; x++) {
    scatterOne(g, x, 0)
    scatterOne(g, x, H - 1)
    if (rng() < 0.8) scatterOne(g, x, 1)
    if (rng() < 0.8) scatterOne(g, x, H - 2)
  }
  for (let y = 0; y < H; y++) {
    if (y < 14 || y > 16) scatterOne(g, 0, y)
    if (y < 21 || y > 23) scatterOne(g, W - 1, y)
  }
  // Interior groves (keep the path corridor clear)
  for (let i = 0; i < 46; i++) {
    const tx = 2 + Math.floor(rng() * (W - 4))
    const ty = 2 + Math.floor(rng() * (H - 4))
    if (!isGrassLike(g.ground[ty][tx]) || g.solid[ty][tx]) continue
    if (onPathCorridor(tx, ty)) continue
    scatterOne(g, tx, ty)
  }

  // Road lanterns beside the path, one per leg; kept clear of groves.
  const roadLanterns = [
    { id: 'road-1' as const, tx: 10, ty: 14 },
    { id: 'road-2' as const, tx: 27, ty: 16 },
    { id: 'road-3' as const, tx: 41, ty: 17 }
  ]
  for (const l of roadLanterns) g.solid[l.ty][l.tx] = false

  const marker = { tx: 25, ty: 13 }
  const npcs: NpcSpot[] = []
  const enemies: EnemySpot[] = [
    { id: 'wisp-a', type: 'wisp', tx: 17, ty: 18 },
    { id: 'wisp-b', type: 'wisp', tx: 31, ty: 11 },
    { id: 'wisp-c', type: 'wisp', tx: 45, ty: 19 },
    // Beetles guard the two long straight stretches, where a charge has
    // room to build and a sidestep has room to land.
    { id: 'beetle-a', type: 'beetle', tx: 35, ty: 13 },
    { id: 'beetle-b', type: 'beetle', tx: 50, ty: 23 }
  ]

  const woodlandExits: ExitDef[] = [
    { tx: 0, ty: 14, tw: 1, th: 3, to: 'village', entry: { tx: 39, ty: 10 } },
    { tx: W - 1, ty: 21, tw: 1, th: 3, to: 'ruin', entry: { tx: 2, ty: 13 } }
  ]
  const trees = collectTrees(g)
  const bushes = scatter(g, rng, 10, [...npcs, marker, ...roadLanterns]).filter((b) => !nearExit({ exits: woodlandExits }, b.tx, b.ty))
  const rocks = scatter(g, rng, 8, [...npcs, marker, ...roadLanterns]).filter((r) => !nearExit({ exits: woodlandExits }, r.tx, r.ty))

  const props: PropSpot[] = [
    { frame: 'trail-sign', tx: 25, ty: 13, h: 24, body: [10, 6] },
    { frame: 'stone-milestone', tx: 39, ty: 13, h: 18, body: [10, 6] },
    { frame: 'mushroom-cluster', tx: 9, ty: 17, h: 12, body: [12, 6] },
    { frame: 'mushroom-cluster', tx: 33, ty: 24, h: 12, body: [12, 6] },
    { frame: 'grappling-rope', tx: 44, ty: 21, h: 14, body: [12, 6] },
    ...roadLanterns.map((l): PropSpot => ({ frame: 'lantern-post', tx: l.tx, ty: l.ty, h: 28, body: [8, 6], light: l.id }))
  ]

  return {
    areaId: 'woodland',
    width: W,
    height: H,
    widthPx: W * TILE,
    heightPx: H * TILE,
    ground: g.ground,
    solid: g.solid,
    trees,
    bushes,
    rocks,
    npcs,
    enemies,
    exits: woodlandExits,
    props,
    discoverySpots: [
      { id: 'route-marker', label: 'the faded route marker', tx: 25, ty: 13 }
    ],
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    emberSpots: roadLanterns,
    spawn: { tx: 3, ty: 15 }
  }
}

function onPathCorridor(tx: number, ty: number): boolean {
  const near = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) <= 2 && Math.abs(ay - by) <= 2
  return (
    near(tx, ty, 12, 15) || near(tx, ty, 26, 12) || near(tx, ty, 40, 12) ||
    (tx >= 1 && tx <= 55 && ((ty >= 13 && ty <= 17 && tx <= 13) || (ty >= 18 && ty <= 22 && tx >= 12 && tx <= 27) || (ty >= 10 && ty <= 14 && tx >= 26 && tx <= 41) || (ty >= 20 && ty <= 24 && tx >= 40))))
}

// ---------------------------------------------------------------- ruin

function buildRuin(): WorldData {
  const W = 34
  const H = 24
  const rng = mulberry32(4413)
  const g = new Grid(W, H, TERRAIN.stone_a)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const r = rng()
      g.ground[y][x] = r < 0.7 ? TERRAIN.stone_a : r < 0.92 ? TERRAIN.stone_b : TERRAIN.stone_crack
    }
  // Moss creeping in at the edges
  for (let y = 1; y < H - 1; y++) {
    if (rng() < 0.5) g.ground[y][1] = TERRAIN.wall_moss
    if (rng() < 0.5) g.ground[y][W - 2] = TERRAIN.wall_moss
  }

  // Outer walls with a western breach (the entrance)
  for (let x = 0; x < W; x++) {
    g.set(x, 0, TERRAIN.wall_stone, true)
    g.set(x, 1, TERRAIN.wall_stone, true)
    g.set(x, H - 1, TERRAIN.wall_stone, true)
  }
  for (let y = 0; y < H; y++) {
    if (y < 12 || y > 14) g.set(0, y, TERRAIN.wall_stone, true)
    g.set(W - 1, y, TERRAIN.wall_stone, true)
  }

  // Broken inner walls
  g.col(8, 4, 6, TERRAIN.wall_stone, true)
  g.col(8, 12, 2, TERRAIN.wall_stone, true)
  g.row(8, 4, 10, TERRAIN.wall_stone, true)
  g.col(18, 4, 5, TERRAIN.wall_moss, true)
  g.row(20, 9, 8, TERRAIN.wall_stone, true)
  g.col(27, 9, 7, TERRAIN.wall_stone, true)
  g.row(14, 18, 9, TERRAIN.wall_moss, true)
  g.col(14, 18, 3, TERRAIN.wall_stone, true)
  // Doorway into the mural alcove so it stays reachable
  g.set(12, 4, TERRAIN.stone_a)
  g.set(13, 4, TERRAIN.stone_a)

  const mural = { tx: 16, ty: 3 }
  const shrine = { tx: 17, ty: 11 }
  const npcs: NpcSpot[] = []
  const enemies: EnemySpot[] = []

  const trees: { tx: number; ty: number }[] = []
  const bushes: { tx: number; ty: number }[] = []
  const rocks: { tx: number; ty: number }[] = [{ tx: 10, ty: 16 }, { tx: 24, ty: 6 }, { tx: 6, ty: 20 }]

  const props: PropSpot[] = [
    { frame: 'lantern-shrine', tx: 17, ty: 11, h: 40, body: [14, 8], light: 'shrine' },
    { frame: 'treasure-chest', tx: 29, ty: 3, h: 20, body: [14, 8] },
    { frame: 'mushroom-cluster', tx: 12, ty: 9, h: 12, body: [12, 6] },
    { frame: 'mushroom-cluster', tx: 6, ty: 20, h: 12, body: [12, 6] },
    { frame: 'grappling-rope', tx: 3, ty: 15, h: 14, body: [12, 6] }
  ]

  return {
    areaId: 'ruin',
    width: W,
    height: H,
    widthPx: W * TILE,
    heightPx: H * TILE,
    ground: g.ground,
    solid: g.solid,
    trees,
    bushes,
    rocks,
    npcs,
    enemies,
    exits: [{ tx: 0, ty: 12, tw: 1, th: 3, to: 'woodland', entry: { tx: 53, ty: 22 } }],
    props,
    discoverySpots: [],
    well: null,
    mural,
    shrine,
    villageLantern: null,
    emberSpots: [{ id: 'chest', tx: 29, ty: 3 }],
    spawn: { tx: 3, ty: 13 }
  }
}

// ---------------------------------------------------------------- shared

function scatterOne(g: Grid, tx: number, ty: number): void {
  if (!g.inBounds(tx, ty)) return
  if (g.solid[ty][tx] || !isGrassLike(g.ground[ty][tx])) return
  g.solid[ty][tx] = true
}

function collectTrees(g: Grid): { tx: number; ty: number }[] {
  const out: { tx: number; ty: number }[] = []
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++) if (g.solid[y][x] && isGrassLike(g.ground[y][x])) out.push({ tx: x, ty: y })
  return out
}

// ---------------------------------------------------------------- area kinds

/** Foreground occluder spot (canopy/arch/fern) — placed by game/area/foreground. */
export interface ForegroundSpot {
  frame: string
  tx: number
  ty: number
  /** Deliberate display width in px. */
  w: number
}

/**
 * One area kind: its data builder plus the small kind-specific builder
 * (foreground decor). Adding an area — a homestead Commons plot, a generated
 * Wilds chunk — means registering a kind (or calling registerAreaKind at
 * runtime for generated chunks); the generic construction in src/game/area/
 * renders any WorldData, so nothing else needs editing.
 */
export interface AreaKind {
  /** Deterministic data for this area. */
  build(): WorldData
  /** Kind-specific foreground occluder spots, given the built world. */
  foreground(world: WorldData): ForegroundSpot[]
}

function villageForeground(): ForegroundSpot[] {
  return [
    { frame: 'leafy-arch', tx: 1, ty: 12, w: 44 },
    { frame: 'fern-cluster', tx: 7, ty: 17, w: 26 }
  ]
}

function woodlandForeground(world: WorldData): ForegroundSpot[] {
  // Canopies over every 9th existing tree base (collisions stay the trees').
  const spots: ForegroundSpot[] = []
  for (let i = 0; i < world.trees.length; i += 9) {
    const t = world.trees[i]
    spots.push({ frame: i % 18 === 0 ? 'oak-canopy' : 'pine-canopy', tx: t.tx, ty: t.ty, w: 60 })
  }
  spots.push({ frame: 'leafy-arch', tx: 2, ty: 15, w: 48 })
  spots.push({ frame: 'fern-cluster', tx: 10, ty: 16, w: 28 })
  spots.push({ frame: 'fern-cluster', tx: 30, ty: 23, w: 28 })
  return spots
}

function ruinForeground(): ForegroundSpot[] {
  return [
    { frame: 'stone-arch', tx: 2, ty: 13, w: 48 },
    { frame: 'fern-cluster', tx: 12, ty: 19, w: 26 },
    { frame: 'fern-cluster', tx: 24, ty: 7, w: 26 }
  ]
}

const AREA_KINDS: Record<string, AreaKind> = {
  village: { build: buildVillage, foreground: villageForeground },
  woodland: { build: buildWoodland, foreground: woodlandForeground },
  ruin: { build: buildRuin, foreground: ruinForeground },
  // Rows follow the world's plot count (src/game/homestead.ts keeps it).
  commons: { build: () => buildCommons(commonsPlotCount), foreground: commonsForeground },
  // Inside a cottage (a view on the Commons save area; see cottage.ts).
  home: { build: () => buildRoom(), foreground: () => [] }
}

/** How many plots the Commons map must show (the roster's size, once known). */
let commonsPlotCount = 0
export function setCommonsPlotCount(n: number): void {
  commonsPlotCount = Math.max(0, Math.floor(n))
}

/** Look up an area kind (its data builder plus kind-specific decor). */
export function areaKind(id: string): AreaKind {
  const kind = AREA_KINDS[id]
  if (!kind) throw new Error(`[fingersnap] unknown area kind: ${id}`)
  return kind
}

/** Register an area kind — how the Commons and the Wilds will arrive. */
export function registerAreaKind(id: string, kind: AreaKind): void {
  AREA_KINDS[id] = kind
}

export function buildArea(areaId: AreaId): WorldData {
  return areaKind(areaId).build()
}
