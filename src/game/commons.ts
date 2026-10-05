/**
 * Hearthwick Commons — the map. A clearing of tall grass and stumps past the
 * east gate, where carters once staged for the lantern road; now it is being
 * taken up as homesteads, and Silas builds the houses.
 *
 * Layout (16 px tiles), read like the village itself, left to right:
 *
 *   - West edge: the Commons gate, where a polished hame hangs on the north
 *     post. The way back to Hearthwick.
 *   - The heart: an old cobbled staging square at the crossing of two lanes,
 *     with the carters' well, a notice board, benches and lamps.
 *   - The plot lane runs north–south through the square. Plots sit in two
 *     columns either side of it, hedged at the back and the outer side, open
 *     to the lane where each has its sign. More plots continue down the lane
 *     (the map grows a row at a time) — content/homestead.json "commons" is
 *     the one source of plot geometry, shared with the server.
 *   - East edge: Silas's work yard: his own cottage, a sawhorse, timber, his
 *     toolbox and firebox, and skids laid out for the next house.
 *   - North: the lane runs out under a leafy arch toward the Wilds.
 *
 * Pure data (no Phaser): the scene renders it through src/game/area/ and the
 * homestead layer (src/game/entities/homesteads.ts) adds what changes —
 * camps, cottages, decorations, signs.
 */
import { HOMESTEAD_DATA, plotRows, plotTile } from '../lib/homestead.ts'
import { TERRAIN, TILE } from './textures.ts'
import type { ExitDef, ForegroundSpot, PropSpot, ScenerySpot, WorldData } from './worlds.ts'

/** One plot slot on the map, in Commons tiles. */
export interface PlotSlot {
  index: number
  /** Top-left tile of the plot's placement grid. */
  tx: number
  ty: number
  /** The lane side (where the sign and the walk are). */
  side: 'east' | 'west'
  /** Sign post on the lane verge, outside the grid. */
  sign: { tx: number; ty: number }
  /** Front door tile (cottage) / bedroll (camp), in Commons tiles. */
  door: { tx: number; ty: number }
  /** Where you stand when you come out of the cottage. */
  doorstep: { tx: number; ty: number }
}

/** Fixed things in the Commons the homestead layer talks about. */
export interface CommonsFeatures {
  gate: { tx: number; ty: number }
  hame: { tx: number; ty: number }
  well: { tx: number; ty: number }
  board: { tx: number; ty: number }
  silas: { tx: number; ty: number }
  toolbox: { tx: number; ty: number }
  firebox: { tx: number; ty: number }
  skids: { tx: number; ty: number }
  /** Commons lamps (always kept lit: named and tended). */
  lamps: { tx: number; ty: number }[]
}

export interface CommonsWorld extends WorldData {
  plots: PlotSlot[]
  features: CommonsFeatures
  rows: number
}

export const COMMONS_W = 62
/** The plot lane between the two columns: verges and a packed-dirt walk. */
export const LANE = { x0: 20, x1: 27, path0: 22, path1: 25 }
/** The heart band between plot rows 0 and 1. */
const BAND = { y0: 16, y1: 25 }
/** The east–west lane through the heart: gate to Silas's yard. */
const CROSS = { y0: 19, y1: 22 }
/** Silas's work yard (fenced), east of the plots. */
const YARD = { x0: 46, x1: 59, y0: 12, y1: 28 }

/** Arriving from Hearthwick (just inside the gate). */
export const COMMONS_FROM_VILLAGE = { tx: 2, ty: 21 }
/** Arriving back from the Wilds (just inside the north arch). */
export const COMMONS_FROM_WILDS = { tx: 23, ty: 2 }
/**
 * The Wilds' entry chunk spawn by its south `commons` gap (src/lib/wilds/gen-v1.ts:
 * inward.commons). The Wilds client owns where a 'wilds' exit really lands.
 */
const WILDS_ENTRY = { tx: 2, ty: 22 }

// ---------------------------------------------------------------- noise

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise on a coarse lattice: patches, not salt and pepper. */
function patch(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell)
  const gy = Math.floor(y / cell)
  const fx = (x % cell) / cell
  const fy = (y % cell) / cell
  const s = (t: number) => t * t * (3 - 2 * t)
  const a = hash(gx, gy, seed)
  const b = hash(gx + 1, gy, seed)
  const c = hash(gx, gy + 1, seed)
  const d = hash(gx + 1, gy + 1, seed)
  const top = a + (b - a) * s(fx)
  const bottom = c + (d - c) * s(fx)
  return top + (bottom - top) * s(fy)
}

// ---------------------------------------------------------------- plots

/** Slot geometry for plot `index` (shared layout, plus the lane-side details). */
export function plotSlot(index: number): PlotSlot {
  const { tx, ty } = plotTile(index)
  const side = tx < LANE.x0 ? 'east' : 'west'
  const r = HOMESTEAD_DATA.outdoorReserved[0]
  // The door is the middle of the reserved strip's bottom wall row.
  const doorX = tx + r.x + Math.floor(r.w / 2) - 1
  const doorY = ty + r.y + r.h - 2
  return {
    index,
    tx,
    ty,
    side,
    sign: { tx: side === 'east' ? LANE.x0 + 1 : LANE.x1 - 1, ty: ty + 4 },
    door: { tx: doorX, ty: doorY },
    doorstep: { tx: doorX, ty: doorY + 1 }
  }
}

/** Rows of plots a Commons needs for `plotCount` plots. */
export function commonsRows(plotCount: number): number {
  return plotRows(plotCount)
}

// ---------------------------------------------------------------- builder

export function buildCommons(plotCount = 0): CommonsWorld {
  const rows = commonsRows(plotCount)
  const slots = Array.from({ length: rows * HOMESTEAD_DATA.commons.columns.length }, (_, i) => plotSlot(i))
  const lastRowY = Math.max(...slots.map((p) => p.ty))
  const W = COMMONS_W
  const H = lastRowY + HOMESTEAD_DATA.outdoor.height + 4
  const ground: number[][] = []
  const solid: boolean[][] = []
  const seed = 1150
  for (let y = 0; y < H; y++) {
    const g: number[] = []
    const s: boolean[] = []
    for (let x = 0; x < W; x++) {
      // Meadow: grass, with drifts of moss in the shade and wildflowers.
      const moss = patch(x, y, 6, seed)
      const bloom = patch(x + 40, y + 17, 5, seed + 1)
      g.push(moss > 0.72 ? TERRAIN.grass_b : bloom > 0.8 ? TERRAIN.flowers : (hash(x, y, seed) < 0.5 ? TERRAIN.grass_a : TERRAIN.grass_c))
      s.push(false)
    }
    ground.push(g)
    solid.push(s)
  }
  const set = (x: number, y: number, t: number, block = false) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    ground[y][x] = t
    if (block) solid[y][x] = true
  }
  const fill = (x0: number, y0: number, x1: number, y1: number, t: number, block = false) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, t, block)
  }
  const block = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < W && y < H) solid[y][x] = true
  }
  const open = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < W && y < H) solid[y][x] = false
  }

  const trees: { tx: number; ty: number }[] = []
  const bushes: { tx: number; ty: number }[] = []
  const rocks: { tx: number; ty: number }[] = []
  const props: PropSpot[] = []
  const scenery: ScenerySpot[] = []
  /** Scenery anchored bottom-centre on a tile's bottom edge. */
  const put = (key: string, tx: number, ty: number, opts: Partial<ScenerySpot> = {}) =>
    scenery.push({ key, x: tx * TILE + TILE / 2, y: ty * TILE + TILE, ...opts })

  // ---- plots: tended grass inside, hedges at the back and the outer side
  for (const p of slots) {
    fill(p.tx, p.ty, p.tx + 15, p.ty + 11, TERRAIN.grass_a)
    for (let y = p.ty; y < p.ty + 12; y++) for (let x = p.tx; x < p.tx + 16; x++) if (hash(x, y, 77) < 0.35) ground[y][x] = TERRAIN.grass_c
    // A worn flagstone apron at the door, a soft clover drift in the far
    // corner, a flower border down the outer hedge: ground only, so every
    // tile stays free to furnish.
    for (let y = p.doorstep.ty; y <= p.doorstep.ty + 1; y++)
      for (let x = p.door.tx - 1; x <= p.door.tx + 2; x++) if (hash(x, y, 23) < 0.8) set(x, y, TERRAIN.cobble_moss)
    for (let y = p.ty + 7; y < p.ty + 11; y++)
      for (let x = p.tx; x < p.tx + 16; x++) if (patch(x, y, 3, 29) > 0.68) set(x, y, TERRAIN.grass_b)
    const borderX = p.side === 'east' ? p.tx : p.tx + 15
    for (let y = p.ty + 6; y < p.ty + 11; y++) if (hash(borderX, y, 27) < 0.7) set(borderX, y, TERRAIN.flowers)
    // Stepping stones from the doorstep to the lane.
    const walkY = p.doorstep.ty + 1
    const stepX = p.door.tx + (p.side === 'east' ? 1 : 0)
    set(stepX, p.doorstep.ty, TERRAIN.cobble_moss)
    const [wx0, wx1] = p.side === 'east' ? [stepX, LANE.path0 - 1] : [LANE.path1 + 1, stepX]
    for (let x = wx0; x <= wx1; x++) set(x, walkY, hash(x, walkY, 3) < 0.7 ? TERRAIN.cobble_moss : TERRAIN.grass_a)
    // Hedges at the back (north) and the outer side, a post-and-rail fence
    // along the front and the lane side with a gap for the walk: all one
    // tile outside the grid, so every grid tile stays free to furnish.
    const backY = p.ty - 1
    const outerX = p.side === 'east' ? p.tx - 1 : p.tx + 16
    const laneX = p.side === 'east' ? p.tx + 16 : p.tx - 1
    const hx0 = Math.min(outerX, p.tx)
    const hx1 = Math.max(outerX, p.tx + 15)
    for (let x = hx0; x <= hx1; x++) block(x, backY)
    // The back hedge turns down the outer side at its outer end.
    scenery.push({ key: `hedge-h-${hx1 - hx0 + 1}-${p.side === 'east' ? 'turnw' : 'turne'}`, x: hx0 * TILE, y: (backY + 1) * TILE, originX: 0 })
    for (let y = backY + 1; y <= p.ty + 11; y++) block(outerX, y)
    scenery.push({ key: `hedge-v-${p.ty + 11 - backY}`, x: outerX * TILE, y: (p.ty + 12) * TILE, originX: 0 })
    const frontY = p.ty + 12
    const fx0 = Math.min(outerX, laneX)
    const fx1 = Math.max(outerX, laneX)
    for (let x = fx0; x <= fx1; x++) block(x, frontY)
    scenery.push({ key: `fence-h-${fx1 - fx0 + 1}`, x: fx0 * TILE, y: (frontY + 1) * TILE, originX: 0 })
    // Lane side: fence above and below the gateway (the walk's row and the one above it).
    const gate0 = walkY - 1
    for (let y = backY; y < gate0; y++) block(laneX, y)
    for (let y = walkY + 1; y < frontY; y++) block(laneX, y)
    scenery.push({ key: `fence-v-${gate0 - backY}`, x: laneX * TILE, y: gate0 * TILE, originX: 0 })
    scenery.push({ key: `fence-v-${frontY - walkY - 1}`, x: laneX * TILE, y: frontY * TILE, originX: 0 })
    set(laneX, walkY, TERRAIN.cobble_moss)
    set(laneX, gate0, TERRAIN.grass_a)
    put('gatepost-small', laneX, gate0 - 1, { x: laneX * TILE + 8 })
    put('gatepost-small', laneX, walkY + 1, { x: laneX * TILE + 8, y: (walkY + 1) * TILE + 6 })
    // A cottage-garden border along the front fence: flowers, nothing in the way.
    for (let x = p.tx; x < p.tx + 16; x++) if (hash(x, frontY - 1, 19) < 0.55) set(x, frontY - 1, TERRAIN.flowers)
  }

  // ---- the plot lane, north to south: the old carting lane, worn cobbles
  // gone to moss, with grass creeping in at the edges.
  const ragged = (x: number, y: number, edge: boolean, seedN: number) => {
    const r = hash(x, y, seedN)
    set(x, y, edge && r < 0.35 ? (r < 0.15 ? TERRAIN.grass_b : TERRAIN.grass_a) : r > 0.93 ? TERRAIN.cobble : TERRAIN.cobble_moss)
  }
  for (let y = 0; y <= H - 4; y++) for (let x = LANE.path0; x <= LANE.path1; x++) ragged(x, y, x === LANE.path0 || x === LANE.path1, 5)
  // Turning circle at the lane's southern end.
  for (let y = H - 5; y <= H - 4; y++) for (let x = LANE.path0 - 1; x <= LANE.path1 + 1; x++) ragged(x, y, x === LANE.path0 - 1 || x === LANE.path1 + 1, 6)

  // ---- the heart: the old staging square at the crossing
  for (let y = CROSS.y0; y <= CROSS.y1; y++) for (let x = 0; x <= YARD.x0 + 1; x++) ragged(x, y, y === CROSS.y0 || y === CROSS.y1, 7)
  fill(19, BAND.y0 + 1, 28, BAND.y1 - 1, TERRAIN.cobble_moss)
  fill(20, BAND.y0 + 2, 27, BAND.y1 - 2, TERRAIN.cobble)
  for (let y = BAND.y0 + 2; y <= BAND.y1 - 2; y++)
    for (let x = 20; x <= 27; x++) if (hash(x, y, 21) < 0.18) set(x, y, TERRAIN.cobble_moss)
  // The gate mouth: the carters' old staging ground, cobbles worn bare.
  fill(0, CROSS.y0, 4, CROSS.y1, TERRAIN.cobble_moss)

  const well = { tx: 23, ty: 21 }
  fill(23, 20, 24, 21, TERRAIN.cobble, true)
  put('commons-well', 23, 21, { x: 24 * TILE, y: 22 * TILE })
  const board = { tx: 26, ty: 17 }
  block(26, 17)
  put('notice-board', 26, 17)
  props.push({ frame: 'patched-bench', tx: 21, ty: 18, h: 18, body: [16, 6] })
  props.push({ frame: 'patched-bench', tx: 26, ty: 23, h: 18, body: [16, 6] })
  props.push({ frame: 'flower-planter', tx: 21, ty: 23, h: 14, body: [12, 6] })
  props.push({ frame: 'bread-basket', tx: 27, ty: 18, h: 11, body: [10, 5] })

  // Lamps on the square's corners and along the lane, each named and kept.
  const lamps: { tx: number; ty: number }[] = [{ tx: 20, ty: 17 }, { tx: 27, ty: 24 }]
  for (const p of slots) if (p.side === 'east') lamps.push({ tx: LANE.x0 + 1, ty: p.ty + 1 })
  for (const p of slots) if (p.side === 'west') lamps.push({ tx: LANE.x1 - 1, ty: p.ty + 9 })
  for (const l of lamps) props.push({ frame: 'lantern-post', tx: l.tx, ty: l.ty, h: 28, body: [8, 6], light: 'commons' })

  // Two old oaks frame the square (their canopies are foreground).
  const oaks = [{ tx: 17, ty: 17 }, { tx: 30, ty: 24 }]
  for (const o of oaks) {
    block(o.tx, o.ty)
    trees.push(o)
  }

  // ---- the Commons gate (west), with the hame on its north post
  const gate = { tx: 3, ty: CROSS.y0 - 1 }
  const hame = { tx: 3, ty: CROSS.y0 - 1 }
  block(3, CROSS.y0 - 1)
  block(3, CROSS.y1 + 1)
  // Fence from the posts to the plot hedges, and the gate leaf swung open.
  for (let y = BAND.y0; y < CROSS.y0 - 1; y++) block(3, y)
  for (let y = CROSS.y1 + 2; y <= BAND.y1 - 1; y++) block(3, y)
  scenery.push({ key: `fence-v-${CROSS.y0 - 1 - BAND.y0}`, x: 3 * TILE, y: (CROSS.y0 - 1) * TILE, originX: 0 })
  scenery.push({ key: `fence-v-${BAND.y1 - 1 - (CROSS.y1 + 2) + 1}`, x: 3 * TILE, y: BAND.y1 * TILE, originX: 0 })
  put('gatepost', 3, CROSS.y0 - 1)
  put('gatepost', 3, CROSS.y1 + 1)
  // The gate leaf, swung open inward against the north side of the lane.
  block(4, CROSS.y0 - 1)
  block(5, CROSS.y0 - 1)
  scenery.push({ key: 'gate-leaf', x: 4 * TILE + 3, y: CROSS.y0 * TILE - 1, originX: 0 })
  put('commons-board', 3, CROSS.y1 + 1, { x: 3 * TILE + 8, y: (CROSS.y1 + 2) * TILE - 30 })
  props.push({ frame: 'lantern-post', tx: 4, ty: CROSS.y1 + 1, h: 28, body: [8, 6], light: 'commons' })
  lamps.push({ tx: 4, ty: CROSS.y1 + 1 })

  // ---- Silas's work yard (east)
  // Worked ground: trodden dirt round the bench and the skids, grass at the edges.
  for (let y = YARD.y0 + 1; y <= YARD.y1 - 1; y++)
    for (let x = YARD.x0 + 1; x <= YARD.x1 - 1; x++) {
      const d = Math.min(Math.hypot((x - 50) / 3.2, (y - 20) / 2.6), Math.hypot((x - 53.5) / 4.5, (y - 26) / 2.2), Math.hypot((x - 53) / 1.6, (y - 18.5) / 1.4))
      if (d + (hash(x, y, 41) - 0.5) * 0.5 < 1) set(x, y, TERRAIN.dirt)
      else set(x, y, hash(x, y, 42) < 0.3 ? TERRAIN.grass_b : TERRAIN.grass_a)
    }
  for (let x = 52; x <= 53; x++) set(x, 18, TERRAIN.dirt)
  // Fence round the yard, open to the cross lane on the west.
  const fenceH = (x0: number, x1: number, y: number) => {
    for (let x = x0; x <= x1; x++) block(x, y)
    scenery.push({ key: `fence-h-${x1 - x0 + 1}`, x: x0 * TILE, y: (y + 1) * TILE, originX: 0 })
  }
  const fenceV = (x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) block(x, y)
    scenery.push({ key: `fence-v-${y1 - y0 + 1}`, x: x * TILE, y: (y1 + 1) * TILE, originX: 0 })
  }
  fenceH(YARD.x0, YARD.x1, YARD.y0)
  fenceH(YARD.x0, YARD.x1, YARD.y1)
  fenceV(YARD.x0, YARD.y0 + 1, CROSS.y0 - 1)
  fenceV(YARD.x0, CROSS.y1 + 1, YARD.y1 - 1)
  fenceV(YARD.x1, YARD.y0 + 1, YARD.y1 - 1)
  // Silas's own cottage: finished, with a fox over the lintel.
  fill(50, 14, 55, 17, TERRAIN.dirt, true)
  put('cottage-silas', 52, 17, { x: 53 * TILE, y: 18 * TILE })
  props.push({ frame: 'lantern-post', tx: 56, ty: 17, h: 28, body: [8, 6], light: 'commons' })
  lamps.push({ tx: 56, ty: 17 })
  const silas = { tx: 51, ty: 21 }
  const toolbox = { tx: 49, ty: 24 }
  props.push({ frame: 'tool-crate', tx: toolbox.tx, ty: toolbox.ty, h: 14, body: [12, 7] })
  const firebox = { tx: 57, ty: 20 }
  block(firebox.tx, firebox.ty)
  put('firebox', firebox.tx, firebox.ty)
  block(48, 18)
  put('sawhorse', 48, 18)
  for (const [x, y] of [[56, 23], [57, 23], [56, 24], [57, 24]]) block(x, y)
  put('timber-stack', 56, 24, { x: 57 * TILE })
  // Skids laid out for the next house: Orrin's way, on the dirt, no footings.
  const skids = { tx: 51, ty: 26 }
  put('skids', 51, 26, { x: 53 * TILE, depth: -4 })
  put('woodpile', 58, 26)
  block(58, 26)

  // ---- meadow details: stumps, tall grass, wildflowers (not on paths or plots)
  const inPlot = (x: number, y: number) => slots.some((p) => x >= p.tx - 1 && x <= p.tx + 16 && y >= p.ty - 1 && y <= p.ty + 12)
  const free = (x: number, y: number) =>
    !solid[y][x] && (ground[y][x] === TERRAIN.grass_a || ground[y][x] === TERRAIN.grass_b || ground[y][x] === TERRAIN.grass_c || ground[y][x] === TERRAIN.flowers) && !inPlot(x, y)
  for (let y = 3; y < H - 2; y++) {
    for (let x = 3; x < W - 2; x++) {
      if (!free(x, y)) continue
      if (x >= YARD.x0 - 1 && x <= YARD.x1 && y >= YARD.y0 && y <= YARD.y1) continue
      const r = hash(x, y, 91)
      // A stump never pinches a walkway: all four neighbours stay open.
      const roomy = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => !solid[y + dy][x + dx])
      if (r < 0.025 && roomy) {
        block(x, y)
        put('stump', x, y)
      } else if (r < 0.2) {
        put(r < 0.11 ? 'tall-grass-a' : 'tall-grass-b', x, y, { x: x * TILE + 4 + Math.floor(hash(x, y, 3) * 8), depth: 'y' })
      } else if (r < 0.24 && ground[y][x] === TERRAIN.flowers) {
        put('wildflowers', x, y, { depth: 'y' })
      }
    }
  }

  // ---- framing trees: a thick border, gaps only for the gate and the arch
  const exits: ExitDef[] = [
    { tx: 0, ty: CROSS.y0, tw: 1, th: CROSS.y1 - CROSS.y0 + 1, to: 'village', entry: { tx: 39, ty: 15 } },
    { tx: LANE.path0, ty: 0, tw: LANE.path1 - LANE.path0 + 1, th: 1, to: 'wilds', entry: { ...WILDS_ENTRY } }
  ]
  const laneGap = (x: number, y: number) => x >= LANE.path0 && x <= LANE.path1 && y <= 3
  const gateGap = (x: number, y: number) => y >= CROSS.y0 && y <= CROSS.y1 && x <= 2
  const tree = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H || solid[y][x] || laneGap(x, y) || gateGap(x, y)) return
    if (ground[y][x] !== TERRAIN.grass_a && ground[y][x] !== TERRAIN.grass_b && ground[y][x] !== TERRAIN.grass_c && ground[y][x] !== TERRAIN.flowers) set(x, y, TERRAIN.grass_b)
    block(x, y)
    trees.push({ tx: x, ty: y })
  }
  for (let x = 0; x < W; x++) {
    tree(x, 0)
    tree(x, 1)
    if (hash(x, 2, 7) < 0.55) tree(x, 2)
    tree(x, H - 1)
    tree(x, H - 2)
    if (hash(x, H - 3, 8) < 0.4) tree(x, H - 3)
  }
  for (let y = 0; y < H; y++) {
    tree(0, y)
    tree(1, y)
    if (hash(2, y, 9) < 0.5 && (y < BAND.y0 - 1 || y > BAND.y1 + 1)) tree(2, y)
    tree(W - 1, y)
    tree(W - 2, y)
    if (hash(W - 3, y, 10) < 0.5 && !(y >= YARD.y0 && y <= YARD.y1)) tree(W - 3, y)
  }
  // Keep the gate mouth and the arch mouth open whatever the border did.
  for (const e of exits) for (let y = e.ty; y < e.ty + e.th; y++) for (let x = e.tx; x < e.tx + e.tw; x++) open(x, y)
  for (let y = CROSS.y0; y <= CROSS.y1; y++) for (let x = 0; x <= 2; x++) open(x, y)
  for (let y = 0; y <= 3; y++) for (let x = LANE.path0; x <= LANE.path1; x++) open(x, y)

  // A few bushes against the hedges, rocks by the yard.
  for (const b of [{ tx: 45, ty: 9 }, { tx: 45, ty: 33 }, { tx: 15, ty: 24 }]) if (b.ty < H - 3 && !solid[b.ty][b.tx]) bushes.push(b)
  for (const r of [{ tx: 45, ty: 23 }, { tx: 33, ty: 18 }]) if (!solid[r.ty][r.tx]) rocks.push(r)

  const world: CommonsWorld = {
    areaId: 'commons',
    width: W,
    height: H,
    widthPx: W * TILE,
    heightPx: H * TILE,
    ground,
    solid,
    trees,
    bushes,
    rocks,
    npcs: [],
    enemies: [],
    exits,
    props,
    scenery,
    discoverySpots: [],
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    emberSpots: [],
    spawn: { ...COMMONS_FROM_VILLAGE },
    board: { ...board },
    plots: slots,
    features: { gate, hame, well, board, silas, toolbox, firebox, skids, lamps },
    rows
  }
  return world
}

/** Canopies over the framing trees and the old oaks; an arch over the Wilds lane. */
export function commonsForeground(world: WorldData): ForegroundSpot[] {
  const spots: ForegroundSpot[] = []
  const c = world as CommonsWorld
  for (const [i, t] of world.trees.entries()) {
    const oak = c.features && (t.tx === 17 || t.tx === 30) && (t.ty === 17 || t.ty === 24)
    if (oak) {
      spots.push({ frame: 'oak-canopy', tx: t.tx, ty: t.ty, w: 64 })
      continue
    }
    // Border trees: the inner edge always gets a canopy (no bare stick trees
    // facing the meadow); deeper in, about half do, alternating oak and pine.
    const inner = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const x = t.tx + dx
      const y = t.ty + dy
      return x >= 0 && y >= 0 && x < world.width && y < world.height && !world.solid[y][x]
    })
    if (inner || hash(t.tx, t.ty, 13) < 0.3) spots.push({ frame: i % 2 === 0 ? 'oak-canopy' : 'pine-canopy', tx: t.tx, ty: t.ty, w: 48 + Math.floor(hash(t.tx, t.ty, 14) * 16) })
  }
  spots.push({ frame: 'leafy-arch', tx: LANE.path0 + 1, ty: 1, w: 74 })
  spots.push({ frame: 'fern-cluster', tx: 4, ty: 24, w: 22 })
  spots.push({ frame: 'fern-cluster', tx: 45, ty: 13, w: 22 })
  return spots
}
