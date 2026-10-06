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
 *   - The lane runs north–south through the square, fenced on both sides.
 *     In the fences are the homestead gates, each with a signpost on the
 *     verge: walk through a gate and you are on that homestead's own land
 *     (src/game/homeland.ts). Woods stand behind the fences. More gates
 *     continue down the lane (the map grows a row at a time) —
 *     content/homestead.json "commons" is the one source of gate geometry,
 *     shared with the server.
 *   - East edge: Silas's work yard: his own cottage, a sawhorse, timber, his
 *     toolbox and firebox, and skids laid out for the next house.
 *   - North: the lane runs out under a leafy arch toward the Wilds. Elara
 *     Quill camps on its east verge, just inside the arch.
 *
 * Pure data (no Phaser): the scene renders it through src/game/area/ and the
 * homestead layer (src/game/entities/homesteads.ts) adds what changes —
 * the signs on the gates, Silas, the way to your own gate.
 */
import { HOMESTEAD_DATA, gateRowCount, gateTile, homeArea } from '../lib/homestead.ts'
import { ITEM_RULES } from '../lib/items.ts'
import { landEntry } from './homeland.ts'
import { TERRAIN, TILE } from './textures.ts'
import type { ExitDef, ForegroundSpot, PropSpot, ScenerySpot, WorldData } from './worlds.ts'

/** One homestead gate on the lane, in Commons tiles. */
export interface GateSlot {
  gate: number
  /** The gap in the fence (two tiles tall: ty and ty + 1). */
  tx: number
  ty: number
  /** Which fence: the land lies west (or east) of the lane. */
  side: 'east' | 'west'
  /** The signpost on the lane verge beside the gate. */
  sign: { tx: number; ty: number }
  /** The gift shelf on the lane verge beside the gate. */
  shelf: { tx: number; ty: number }
  /** Where you stand on the lane coming back out. */
  entry: { tx: number; ty: number }
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
  gates: GateSlot[]
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
/** Silas's work yard (fenced), east of the lane. */
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

// ---------------------------------------------------------------- gates

/** Slot geometry for gate `gate` (shared layout, plus the lane-side details). */
export function gateSlot(gate: number): GateSlot {
  const { tx, ty, side } = gateTile(gate)
  const laneX = side === 'west' ? tx + 1 : tx - 1
  // The signpost stands on the verge a step out from the fence, just up the lane.
  const signX = side === 'west' ? tx + 2 : tx - 2
  return { gate, tx, ty, side, sign: { tx: signX, ty: ty - 1 }, shelf: { tx: signX, ty: ty + 2 }, entry: { tx: laneX, ty } }
}

/** Gate rows a Commons needs for `gateCount` gates. */
export function commonsRows(gateCount: number): number {
  return gateRowCount(gateCount)
}

// ---------------------------------------------------------------- builder

export function buildCommons(gateCount = 0): CommonsWorld {
  const rows = commonsRows(gateCount)
  const gates = Array.from({ length: Math.max(gateCount, HOMESTEAD_DATA.commons.spareGates) }, (_, i) => gateSlot(i))
  const lastRowY = Math.max(...Array.from({ length: rows * 2 }, (_, i) => gateTile(i).ty))
  const W = COMMONS_W
  const H = lastRowY + 9
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

  // ---- the fences along the lane, with a gate in them for every homestead.
  // Behind the fences the land is wild: the homesteads lie out there, each
  // through its own gate. The heart band (the square and the cross lane) is
  // left open.
  const [westX, eastX] = HOMESTEAD_DATA.commons.fenceX
  const fenceTop = 3
  const fenceBottom = H - 5
  const gapAt = (x: number, y: number) => gates.some((g) => g.tx === x && (y === g.ty || y === g.ty + 1))
  const inBand = (y: number) => y >= BAND.y0 && y <= BAND.y1
  for (const fx of [westX, eastX]) {
    let run: number | null = null
    const flush = (end: number) => {
      if (run !== null && end >= run) scenery.push({ key: `fence-v-${end - run + 1}`, x: fx * TILE, y: (end + 1) * TILE, originX: 0 })
      run = null
    }
    for (let y = fenceTop; y <= fenceBottom; y++) {
      if (inBand(y) || gapAt(fx, y)) {
        flush(y - 1)
        continue
      }
      block(fx, y)
      if (run === null) run = y
    }
    flush(fenceBottom)
  }
  for (const g of gates) {
    // The gateway: worn ground through the gap and a little way in, posts either side.
    for (let y = g.ty; y <= g.ty + 1; y++) {
      set(g.tx, y, TERRAIN.cobble_moss)
      // A worn track running off into the trees behind the gate.
      for (let d = 1; d <= 3; d++) if (hash(g.tx + d * 7, y, 33) < 0.85 - d * 0.2) set(g.side === 'west' ? g.tx - d : g.tx + d, y, d === 1 ? TERRAIN.dirt : TERRAIN.grass_b)
      set(g.entry.tx, y, TERRAIN.cobble_moss)
    }
    put('gatepost-small', g.tx, g.ty - 1, { x: g.tx * TILE + 8 })
    put('gatepost-small', g.tx, g.ty + 2, { x: g.tx * TILE + 8, y: (g.ty + 2) * TILE + 6 })
    block(g.tx, g.ty - 1)
    block(g.tx, g.ty + 2)
    block(g.sign.tx, g.sign.ty)
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
  // One lamp a gate row, on the verge between the gates, alternating sides.
  for (let r = 0; r < rows; r++) {
    const y = gateTile(r * 2).ty + 3
    if (y >= BAND.y0 - 1 && y <= BAND.y1 + 1) continue
    lamps.push({ tx: r % 2 === 0 ? LANE.x0 : LANE.x1, ty: y })
  }
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
  // Silas stands where the shared menders data puts him (the server checks
  // mending and keepsake returns against the same rows).
  const silasSpot = ITEM_RULES.menders.find((m) => m.npc === 'silas') ?? { tx: 51, ty: 21 }
  const silas = { tx: silasSpot.tx, ty: silasSpot.ty }
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

  // ---- Elara's camp, on the lane verge by the Wilds arch: her pack behind
  // her, a cold fire ring in front, on trodden ground (no tall grass). She
  // reads the drift from here and posts the Turning notices.
  const elara = { tx: 26, ty: 5 }
  for (let y = 4; y <= 6; y++) set(26, y, TERRAIN.dirt)
  block(26, 4)
  put('commons-art:wilds-pack', 26, 4)
  block(26, 6)
  put('commons-art:wilds-fire-ring', 26, 6)

  // ---- the woods behind the fences: wild land, the homesteads out past it.
  // A strip of meadow along each fence; the trees thicken further back. The
  // heart band, the yard and every gateway stay open.
  const nearGate = (x: number, y: number) => gates.some((g) => y >= g.ty - 1 && y <= g.ty + 2 && Math.abs(x - g.tx) <= 4)
  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      const west = x < westX - 1
      const east = x > eastX + 1
      if ((!west && !east) || solid[y][x] || inBand(y) || nearGate(x, y)) continue
      if (x >= YARD.x0 - 1 && x <= YARD.x1 + 1 && y >= YARD.y0 - 1 && y <= YARD.y1 + 1) continue
      const depth = west ? westX - x : x - eastX
      if (hash(x, y, 61) < (depth <= 3 ? 0.22 : 0.55)) {
        set(x, y, TERRAIN.grass_b)
        block(x, y)
        trees.push({ tx: x, ty: y })
      }
    }
  }

  // ---- meadow details: stumps, tall grass, wildflowers (not on paths)
  const free = (x: number, y: number) =>
    !solid[y][x] && (ground[y][x] === TERRAIN.grass_a || ground[y][x] === TERRAIN.grass_b || ground[y][x] === TERRAIN.grass_c || ground[y][x] === TERRAIN.flowers)
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
    { tx: LANE.path0, ty: 0, tw: LANE.path1 - LANE.path0 + 1, th: 1, to: 'wilds', entry: { ...WILDS_ENTRY } },
    // Every gate leads onto its homestead's land (signs are the homestead layer's).
    ...gates.map((g) => ({ tx: g.tx, ty: g.ty, tw: 1, th: 2, to: homeArea(g.gate), entry: landEntry(), label: null }))
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
    npcs: [{ id: 'elara', ...elara }],
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
    gates,
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
