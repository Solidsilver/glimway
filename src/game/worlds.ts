/**
 * World builder: the first areas (village, woodland, ruin), generated
 * deterministically from code (seeded), and the area-kind registry every
 * area resolves through (those three, the Commons, homestead land by
 * `home:<gate>`, the rooms by `in:…` (./room-kind.ts: the village rooms and
 * the cottages), and the Wilds chunks registered at runtime).
 */
import type { AreaId } from '../lib/state.ts'
import { repairFor } from '../lib/repairs.ts'
import { calendarAt } from '../lib/calendar.ts'
import { TERRAIN, TILE, tileBottom, tileMid } from '../lib/tile.ts'
import { buildCommons, commonsForeground, COMMONS_FROM_VILLAGE } from './commons.ts'
import { homeLandKind } from './homeland.ts'
import { residentSpotsIn, roomKind, type RoomScene } from './room-kind.ts'
import { gameNow } from './clock.ts'
import { rng01 } from '../lib/hash.ts'

/** Quest NPCs, then the residents (src/content/residents.ts), who talk around the quest. */
export type NpcId = 'mara' | 'pip' | 'orrin' | 'elara' | 'finn' | 'hazel' | 'ada'
/** Ember spots: the hearth lantern (warm rest), road lanterns, the chest. */
export type EmberSpotId = 'hearth' | 'road-1' | 'road-2' | 'road-3' | 'chest'
/**
 * What can be used (src/game/entities/interactables.ts), by the feature that
 * owns it: 'library' is the Hearthwick Library door, `paper:<id>` a
 * found-text pickup (content/papers.ts), `gather:<tx,ty>` a workable piece,
 * `wilds:<id>` a claim in a Wilds chunk, 'warden' the naming spoken to it.
 */
export type InteractId =
  | NpcId
  | 'clue'
  | 'lantern'
  | EmberSpotId
  | 'library'
  | 'warden'
  | RoomSpotId
  | `paper:${string}`
  | `door:${string}`
  | `home:${string}`
  | `village:${string}`
  | `touch:${string}`
  | `pickup:${string}`
  | `repair:${string}`
  | `gather:${string}`
  | `wilds:${string}`
/** A room's spot (the rooms data's `spots`): one id across all content, the quest `use` trigger's. */
export type RoomSpotId =
  | 'kitchen-hearth'
  | 'sponge-bowl'
  | 'tallow-pot'
  | 'millstones'
  | 'counting-stool'
  | 'mill-hoist'
  | 'library-shelf'
  | 'shelf-histories'
  | 'shelf-recipes'
  | 'shelf-field-notes'
  | 'reading-table'
  | 'reading-lamp'
  | 'reading-nook'
/** wisp: hopping slime/mushroom; beetle: telegraphed straight-line charger. */
export type EnemyType = 'wisp' | 'beetle' | 'guardian'

export interface NpcSpot {
  id: NpcId
  tx: number
  ty: number
  /** A resident's cycle spot (src/game/resident-cycle.ts): they stand here only while the cycle says so. */
  spot?: string
  /** They sit here, at the furniture on this tile (Elara at her desk). */
  seated?: boolean
}

export interface EnemySpot {
  id: string
  type: EnemyType
  tx: number
  ty: number
  /** Its own health, when not the type's (the opening's finger-wisp: a Slash or two). */
  hp?: number
}

export interface ExitDef {
  tx: number
  ty: number
  tw: number
  th: number
  to: AreaId
  entry: { tx: number; ty: number }
  /** Sign text (default: the destination's name); '' shows the chevron alone (a room's doorway); null hides the sign (the cottage's door). */
  label?: string | null
  /** The side you step out of (the chevron, and which way you face arriving). Edge exits infer it. */
  side?: 'north' | 'south' | 'east' | 'west'
  /** A map edge (the default), a room's doorway, or a stair to another floor. */
  kind?: 'edge' | 'door' | 'stair'
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
  /** Frame within the texture (an atlas such as the Tangle's decor). */
  frame?: string
  /** Anchor in px (bottom-centre unless `originX` says otherwise). */
  x: number
  y: number
  originX?: number
  /** Fixed depth, or 'y' to sort by the anchor (the default). */
  depth?: number | 'y'
  /** Mirror the art. */
  flipX?: boolean
  /** Multiply tint (deep woods sit in their own shade). */
  tint?: number
  /**
   * Delivered building art that stands in for tiles drawn into the ground:
   * when the texture exists, these tiles are painted as `tile` instead
   * (the solid grid is unchanged), so nothing of the tile house shows
   * around the art's edges. Without the art the tile house stays.
   */
  groundUnder?: { tx: number; ty: number; tw: number; th: number; tile: number }
  /** A canopy someone can walk beneath: drawn by the foreground pass so it fades. */
  fade?: boolean
  /** The anchor tile, when the piece stands for a map tile (gathering removals). */
  tx?: number
  ty?: number
}

/**
 * A place to work (docs/items/crafting-and-repair.md, "Gathering"): what the
 * piece is for the server's target ids, said in words for the prompt, and
 * where it stands. Trees are client scenery: the server validates the tool,
 * area, caps and yields, not individual pieces.
 */
export interface GatherSpot {
  /** A content/gathering.json target id (tree, boulder, stump…). */
  target: string
  label: string
  tx: number
  ty: number
  /** The piece's own art, so a felled tree can leave its stump. */
  art?: { key: string; frame?: string }
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
  /** A notice board (village, Commons): Turning notices and village projects. */
  board?: { tx: number; ty: number }
  /**
   * The Tolley mill (village): its footprint, the waterwheel's centre in px
   * (it turns on the pond's edge; src/game/entities/village-life.ts draws and
   * turns it), and the hopper beside it.
   */
  mill?: { tx: number; ty: number; tw: number; th: number; door: { tx: number; ty: number }; wheel: { x: number; y: number }; hopper: { tx: number; ty: number } }
  /** Code-drawn scenery sprites (the Commons, the Tangle's woods). */
  scenery?: ScenerySpot[]
  /** Places to work: trees, boulders, stumps and patches (gathering). */
  gathering?: GatherSpot[]
  /**
   * Ground painter: the Wilds paint their woods floor per pixel
   * (src/game/wilds/tangle-art.ts) — 'tangle', or 'outer' (the deep drift)
   * coloured by `groundMark`, the Mark its wick falls in.
   */
  groundStyle?: 'tangle' | 'outer'
  groundMark?: string | null
  /** Wilds story sites in this chunk (Echo camps, given-back finds): src/game/wilds/sites.ts. */
  storySites?: { id: string; kind: string; tx: number; ty: number }[]
  /** A village room: its row, footprints and arrival (./room-kind.ts; drawn by ./area/room-art.ts). */
  room?: RoomScene
  /**
   * Collision boxes in px besides the solid grid: a room's pieces block
   * only where they touch the floor (their base), never their picture.
   */
  bodies?: { x: number; y: number; w: number; h: number }[]
}

// ---------------------------------------------------------------- utilities

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

/** The village's three homes (4 tiles deep), and the building art each is drawn with (src/game/buildings.ts). */
export const VILLAGE_HOUSES = [
  { tx: 5, ty: 4, w: 6, frame: 'house-west' },
  { tx: 17, ty: 3, w: 7, frame: 'house-middle' },
  { tx: 31, ty: 4, w: 6, frame: 'house-ada' }
] as const

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
  const rng = rng01(20261002)
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

  // Houses: tile houses, each drawn by its delivered building when that art
  // loaded (scenery below, `groundUnder`): the footprint stays solid, the
  // door on its bottom row, the window above (Ada's is the east one,
  // village-life.ts ADA_HOUSE_WINDOW).
  for (const h of VILLAGE_HOUSES) g.house(h.tx, h.ty, h.w)

  // Paths
  g.row(3, 10, W - 3, TERRAIN.path_a)
  g.col(8, 7, 3, TERRAIN.path_a)
  g.col(20, 7, 3, TERRAIN.path_a)
  g.col(33, 8, 2, TERRAIN.path_a)
  g.col(13, 10, 3, TERRAIN.path_a)
  // A lane off the road down to the Commons gate (east edge, below the road).
  g.col(39, 11, 5, TERRAIN.path_a)
  g.row(39, 15, 3, TERRAIN.path_a)

  // Garden fence with a gap: solid tiles on grass, drawn as fence runs from
  // the Commons pass's pieces (as round Silas's yard), not plank tiles.
  const gardenFence: ScenerySpot[] = []
  const fenceH = (x0: number, x1: number, y: number) => {
    for (let x = x0; x <= x1; x++) g.set(x, y, TERRAIN.grass_a, true)
    gardenFence.push({ key: `fence-h-${x1 - x0 + 1}`, x: x0 * TILE, y: tileBottom(y), originX: 0 })
  }
  const fenceV = (x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) g.set(x, y, TERRAIN.grass_a, true)
    gardenFence.push({ key: `fence-v-${y1 - y0 + 1}`, x: x * TILE, y: tileBottom(y1), originX: 0 })
  }
  fenceH(24, 30, 13)
  fenceV(24, 14, 17)
  fenceV(30, 14, 17)
  // The gap at 27,18 (a rail fallen out of it: content/repairs.json fence-rail).
  fenceH(24, 26, 18)
  fenceH(28, 30, 18)

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

  // The well stands where the repairs data puts it (shared with the
  // server's draw-water and mend checks); the village lantern beside it.
  const wellPos = repairFor('well-rope')?.pos ?? { tx: 13, ty: 12 }
  const well = { tx: wellPos.tx, ty: wellPos.ty }
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
  // The door in the middle, under the open-book gable (where the delivered
  // building has it).
  const library = { tx: libraryAt.tx + Math.floor(libraryAt.w / 2), ty: libraryAt.ty + 3 }
  g.set(library.tx - 1, library.ty, TERRAIN.wall_house, true)
  g.set(library.tx, library.ty, TERRAIN.door, true)
  const clearOfLibrary = (p: { tx: number; ty: number }) =>
    !(p.tx >= libraryAt.tx - 1 && p.tx <= libraryAt.tx + libraryAt.w && p.ty >= libraryAt.ty - 1 && p.ty <= libraryAt.ty + 5)
  // The village notice board, by the road at the square: raised after the
  // scatter too, so the seeded layout stays as it was.
  const board = { tx: 15, ty: 9 }
  g.solid[board.ty][board.tx] = true
  const clearOfBoard = (p: { tx: number; ty: number }) => Math.abs(p.tx - board.tx) > 1 || Math.abs(p.ty - board.ty) > 1
  const bushes = scatteredBushes.filter(clearOfLibrary).filter(clearOfBoard)
  const rocks = scatteredRocks.filter(clearOfLibrary).filter(clearOfBoard)
  // The Tolley mill: a small watermill on the pond's west edge, below the
  // garden fence (its gap at 27,18 still opens onto the grass), its wheel
  // on the east wall dipping into the pond the Wend feeds. Raised after the
  // scatter too, so the seeded layout stays; its art is the items pass's (src/game/items-pass.ts).
  const millAt = { tx: 28, ty: 19, tw: 4, th: 4 }
  g.rect(millAt.tx, millAt.ty, millAt.tw, millAt.th, TERRAIN.grass_a, true)
  // The wheel turns in a short mill-race cut through the pond's sandy rim.
  for (let y = 20; y <= 22; y++) g.set(32, y, TERRAIN.water_b, true)
  const millHopper = { tx: 27, ty: 22 }
  g.solid[millHopper.ty][millHopper.tx] = true
  const mill = {
    ...millAt,
    door: { tx: 29, ty: 22 },
    // The wheel's stone support (the west edge of its art) against the mill's east wall.
    wheel: { x: 32 * TILE + 7, y: 21 * TILE + 4 },
    hopper: millHopper
  }
  // The residents' outdoor spots, placed after the scatter too (the seeded
  // layout stays): Hazel in the square below the well with her basket, Finn
  // at his mill door, Ada under her window on the east house (village-life.ts
  // ADA_HOUSE_WINDOW). All off the quest route. Each stands there only while
  // their cycle says so (the residents data; the server checks against it).
  npcs.push(...residentSpotsIn('village'))

  // Supplied atlas props, consistent small-world display heights
  const props: PropSpot[] = [
    { frame: 'lantern-post', tx: 11, ty: 12, h: 32, body: [8, 6], light: 'village' },
    { frame: 'patched-bench', tx: 9, ty: 13, h: 18, body: [16, 6] },
    { frame: 'bread-basket', tx: 6, ty: 8, h: 12, body: [12, 6] },
    { frame: 'flower-planter', tx: 22, ty: 7, h: 16, body: [14, 6] },
    { frame: 'tool-crate', tx: 24, ty: 8, h: 16, body: [12, 8] },
    { frame: 'stone-milestone', tx: 38, ty: 12, h: 18, body: [10, 6] },
    // The square's signpost: Orrin resets it every spring to the same lean.
    { frame: 'trail-sign', tx: 15, ty: 11, h: 24, body: [10, 6] }
  ]

  // The seasons at the village water — the pond the Wend feeds
  // (docs/items/crafting-and-repair.md, "Seasonal materials"). In Mudrise
  // the freshet leaves walnut shells on the shore; in the Quiet the pond
  // freezes over and carries frost-glass. The spots stay all season (the
  // day's caps hold you); the server re-checks the season from its own
  // clock and calendar, so a stale map can only be refused.
  const mark = calendarAt(gameNow()).mark
  const seasonalScenery: ScenerySpot[] = []
  const gathering: GatherSpot[] = []
  if (mark === 'Mudrise') {
    for (const [tx, ty, v] of [[34, 18, 0], [36, 18, 1], [38, 18, 2]] as const) {
      const frame = `pebbles-${v}`
      seasonalScenery.push({ key: 'tangle-decor', frame, x: tileMid(tx), y: tileBottom(ty), tx, ty })
      gathering.push({ target: 'freshet-shore', label: 'Sweep the freshet shore', tx, ty, art: { key: 'tangle-decor', frame } })
    }
  }
  if (mark === 'Quiet') {
    for (const [tx, ty] of [[34, 19], [37, 19], [38, 21]] as const) {
      seasonalScenery.push({ key: 'pond-ice', x: tileMid(tx), y: tileBottom(ty), tx, ty })
      gathering.push({ target: 'pond-ice', label: 'Break the pond ice', tx, ty, art: { key: 'pond-ice' } })
    }
  }

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
    library,
    board,
    mill,
    scenery: [
      ...seasonalScenery,
      ...gardenFence,
      ...VILLAGE_HOUSES.map((h) => ({
        key: `p1:${h.frame}`,
        x: (h.tx + h.w / 2) * TILE,
        y: (h.ty + 4) * TILE,
        groundUnder: { tx: h.tx, ty: h.ty, tw: h.w, th: 4, tile: TERRAIN.grass_a }
      })),
      { key: 'notice-board', x: tileMid(board.tx), y: tileBottom(board.ty) },
      { key: 'mill-house', x: (millAt.tx + millAt.tw / 2) * TILE, y: (millAt.ty + millAt.th) * TILE },
      { key: 'mill-hopper', x: tileMid(millHopper.tx), y: tileBottom(millHopper.ty) },
      {
        key: 'commons-art:hearthwick-library',
        x: (libraryAt.tx + libraryAt.w / 2) * TILE,
        y: (libraryAt.ty + 4) * TILE,
        groundUnder: { tx: libraryAt.tx, ty: libraryAt.ty, tw: libraryAt.w, th: 4, tile: TERRAIN.grass_a }
      }
    ],
    gathering
  }
}

// ---------------------------------------------------------------- woodland

function buildWoodland(): WorldData {
  const W = 56
  const H = 30
  const rng = rng01(73191)
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
    // The opening (Three Fingers off Plumb): a weak wisp just inside the west
    // entry, sitting on the signpost's lost east finger. Low health, the
    // same telegraphed hops: the basic attack alone is enough.
    { id: 'finger-wisp', type: 'wisp', tx: 6, ty: 17, hp: 4 },
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
  // Gathering: the woods' trees (one ash in nine: its haft comes green),
  // and the scattered rocks are boulders a pick can break.
  const gathering: GatherSpot[] = [
    ...trees.map((t, i) => ({ target: i % 9 === 0 ? 'ash' : 'tree', label: i % 9 === 0 ? 'Chop the ash' : 'Chop the tree', tx: t.tx, ty: t.ty })),
    ...rocks.map((r) => ({ target: 'boulder', label: 'Break the boulder', tx: r.tx, ty: r.ty }))
  ]

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
    gathering,
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
  const rng = rng01(4413)
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
  // The lane's length follows the world's gate count (src/game/homestead.ts keeps it).
  commons: { build: () => buildCommons(commonsGateCount), foreground: commonsForeground }
}

/** How many gates the Commons lane must show (the roster's count, once known). */
let commonsGateCount = 0
export function setCommonsGateCount(n: number): void {
  commonsGateCount = Math.max(0, Math.floor(n))
}

/** Registered kinds, then families resolved by id (a homestead's land behind each gate: `home:<gate>`; the rooms: `in:…`). */
function resolveKind(id: string): AreaKind | null {
  if (Object.prototype.hasOwnProperty.call(AREA_KINDS, id)) return AREA_KINDS[id]
  return homeLandKind(id) ?? roomKind(id)
}

/** Look up an area kind (its data builder plus kind-specific decor). */
export function areaKind(id: string): AreaKind {
  const kind = resolveKind(id)
  if (!kind) throw new Error(`[glimway] unknown area kind: ${id}`)
  return kind
}

/** Whether this build can draw an area (an exit to anything else is closed). */
export function hasAreaKind(id: string): boolean {
  return resolveKind(id) !== null
}

/** Register an area kind at runtime (an epoch's Wilds chunks: src/game/wilds/areas.ts). */
export function registerAreaKind(id: string, kind: AreaKind): void {
  AREA_KINDS[id] = kind
}

export function buildArea(areaId: AreaId): WorldData {
  return areaKind(areaId).build()
}
