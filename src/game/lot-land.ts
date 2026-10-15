import { lotService } from '../lib/lots.ts'
/** Lot-local land data for streamed home art and Arrange. No standalone scene
 * or area registration: walking and collision belong to the fixed window. */
import { HOMESTEAD_DATA } from '../lib/homestead.ts'
import { OUTDOORS_AREA } from './wilds/coords.ts'
import { LAND, landFromCells, rememberLand, servedLand, type Land } from '../lib/homestead-land.ts'
import { EV, bus } from './events.ts'
import { DECOR_ART, TANGLE_GROUND, type DecorKind } from './wilds/decor.ts'
import { TILE, tileBottom, tileKey, tileMid } from '../lib/tile.ts'
import { tangleFrame } from './wilds/tangle-key.ts'
import { lookAtlasKey } from './wilds/wilds-looks.ts'
import { itemIcon } from './items-pass.ts'
import type { ScenerySpot, WorldData, GatherSpot } from './worlds.ts'
import { layoutHash01 } from '../lib/hash.ts'

/** Planted things drawn as a patch of the woods' own (the rest as their sapling). */
const PLANTED_PATCH: Partial<Record<string, DecorKind>> = {
  'comfrey-root': 'flowers',
  'wild-thyme': 'flowers',
  'turncap-spawn': 'turncaps',
  'iron-oak-acorn': 'fern'
}

/**
 * How a planted thing is drawn: a sapling as its own sprite, an herb or
 * spawn as a patch of the woods' own. Small, and walked through.
 */
export function plantScenery(p: { itemDef: string; x: number; y: number }, atlas: string): ScenerySpot {
  const patch = PLANTED_PATCH[p.itemDef]
  const at = { x: tileMid(p.x), y: tileBottom(p.y), depth: 'y' as const, flipX: layoutHash01(p.x, p.y, 6) < 0.5, tx: p.x, ty: p.y }
  return patch ? { key: atlas, frame: tangleFrame(patch, Math.floor(layoutHash01(p.x, p.y, 13) * 16)), ...at } : { key: itemIcon(p.itemDef), ...at }
}

/** What the land map needs from the homestead state (none: a guest, or not read yet). */
export interface LandSource {
  /** The world's id (seeds every gate's land); "guest" without a world. */
  worldId(): string
  /** Tiles cleared, stumps, plants, and whether the place has gone desolate. */
  state(gate: number): {
    cleared: readonly [number, number][]
    stumps?: readonly [number, number][]
    plants?: readonly { id: string; itemDef: string; x: number; y: number }[]
    desolate: boolean
  } | null
  /** Fetch a gate's land from the server (null: no server to ask). */
  fetchLand?(gate: number): Promise<{ width: number; height: number; cells: readonly string[] }> | null
}

let source: LandSource = { worldId: () => 'guest', state: () => null }

export function setLandSource(s: LandSource): void {
  source = s
}

export interface LandWorld extends WorldData {
  gate: number
  gridOrigin?: { x: number; y: number }
  land: Land
  /** False while the server's land for this gate hasn't arrived (plain ground stands in). */
  served: boolean
  /** The home site (camp, then cottage): the reserved rect, in tiles. */
  site: { x: number; y: number; w: number; h: number }
  /** Cottage door tile (left of two) and where you stand coming out. */
  door: { tx: number; ty: number }
  doorstep: { tx: number; ty: number }
  /** Grid origin of the old plot art, in px (the camp and cottage drawings use it). */
  origin: { x: number; y: number }
  mailbox: { tx: number; ty: number }
  desolate: boolean
}

/** Where you arrive on a homestead's land through its gate. */
export function landEntry(gate = 0): { tx: number; ty: number } {
  return { tx: gate % 2 ? 0 : 23, ty: 11 }
}

/** The cottage door on any gate's land (left of its two tiles), and the doorstep you come out onto. */
export function landDoor(): { door: { tx: number; ty: number }; doorstep: { tx: number; ty: number } } {
  const s = HOMESTEAD_DATA.land.site
  const door = { tx: s.x + Math.floor(s.w / 2) - 1, ty: s.y + s.h - 2 }
  return { door, doorstep: { tx: door.tx, ty: door.ty + 1 } }
}

const loading = new Map<string, Promise<void>>()

/** Fetch a gate's served land (once per world and gate); the map rebuilds when it lands. */
function loadLand(gate: number): Promise<void> {
  const world = source.worldId()
  if (servedLand(gate, world)) return Promise.resolve()
  const key = `${world}:${gate}`
  let pending = loading.get(key)
  if (!pending) {
    const fetch = source.fetchLand?.(gate)
    if (!fetch) return Promise.resolve()
    pending = fetch
      .then((served) => {
        rememberLand(world, gate, landFromCells(served))
        bus.emit(EV.homeChanged, { reason: 'land', gate })
      })
      .catch(() => undefined)
      .finally(() => loading.delete(key))
    loading.set(key, pending)
  }
  return pending
}

/** Plain ground while the served land is on its way: edge, grass, the gate path. */
function provisionalLand(gate: number): Land {
  const L = HOMESTEAD_DATA.land
  const tiles = new Uint8Array(L.width * L.height)
  for (let y = 0; y < L.height; y++) {
    for (let x = 0; x < L.width; x++) {
      const path = x >= 11 && x <= 12 && y >= 9 && y <= 12 || y >= 11 && y <= 12 && (gate % 2 ? x <= 12 : x >= 11)
      const edge = y <= 1 || y >= 22 || x === (gate % 2 ? 0 : 23)
      tiles[y * L.width + x] = path ? LAND.PATH : edge ? LAND.EDGE : LAND.GRASS
    }
  }
  return { width: L.width, height: L.height, tiles }
}

const TREES: DecorKind[] = ['oak', 'oak', 'pine', 'birch', 'pine', 'oak']

export function buildLand(gate: number): LandWorld {
  const L = HOMESTEAD_DATA.land
  const known = servedLand(gate, source.worldId())
  if (!known) void loadLand(gate)
  const land = known ?? provisionalLand(gate)
  const st = source.state(gate)
  const cleared = new Set((st?.cleared ?? []).map(([x, y]) => tileKey(x, y)))
  const stumps = new Set((st?.stumps ?? []).map(([x, y]) => tileKey(x, y)))
  const plants = st?.plants ?? []
  const desolate = st?.desolate ?? false
  const W = land.width
  const H = land.height
  const atlas = lookAtlasKey('tangle', null)
  const ground: number[][] = []
  const solid: boolean[][] = []
  const scenery: ScenerySpot[] = []
  const gathering: GatherSpot[] = []
  const decor = (kind: DecorKind, tx: number, ty: number, v: number, opts: Partial<ScenerySpot> = {}) =>
    scenery.push({
      key: atlas,
      frame: tangleFrame(kind, v),
      x: tileMid(tx) + Math.round((layoutHash01(tx, ty, 5) - 0.5) * 4),
      y: tileBottom(ty),
      depth: DECOR_ART[kind].flat ? -5 : 'y',
      flipX: layoutHash01(tx, ty, 6) < 0.5,
      tx,
      ty,
      ...opts
    })
  const s = L.site
  const nearSite = (x: number, y: number) => x >= s.x - 1 && x <= s.x + s.w && y >= s.y - 1 && y <= s.y + s.h
  for (let y = 0; y < H; y++) {
    const g: number[] = []
    const so: boolean[] = []
    for (let x = 0; x < W; x++) {
      let k = land.tiles[y * W + x]
      const r = layoutHash01(x, y, 11)
      if (stumps.has(tileKey(x, y))) k = LAND.STUMP
      if ((k === LAND.TREE || k === LAND.STUMP || k === LAND.BOULDER) && cleared.has(tileKey(x, y))) k = LAND.GRASS
      switch (k) {
        case LAND.EDGE:
          g.push(TANGLE_GROUND.woods)
          so.push(true)
          if (r < 0.75) decor(TREES[Math.floor(layoutHash01(x, y, 3) * TREES.length)], x, y, Math.floor(r * 16), { tint: 0xc4c4cc })
          break
        case LAND.TREE:
          g.push(TANGLE_GROUND.woods)
          so.push(true)
          gathering.push(
            r < 0.08
              ? { target: 'iron-oak', label: 'Chop the iron-oak', tx: x, ty: y }
              : { target: 'tree', label: 'Chop the tree', tx: x, ty: y }
          )
          decor(r < 0.08 ? 'iron-oak' : TREES[Math.floor(layoutHash01(x, y, 3) * TREES.length)], x, y, Math.floor(r * 16))
          break
        case LAND.STUMP:
          g.push(TANGLE_GROUND.moss)
          so.push(true)
          gathering.push({ target: 'stump', label: 'Dig the stump', tx: x, ty: y })
          decor(r < 0.3 ? 'ring-stump' : 'stump', x, y, Math.floor(r * 16))
          break
        case LAND.BOULDER:
          g.push(TANGLE_GROUND.moss)
          so.push(true)
          gathering.push(
            r < 0.2
              ? { target: 'lamp-stone', label: 'Break the old lamp-stone', tx: x, ty: y }
              : { target: 'boulder', label: 'Break the boulder', tx: x, ty: y }
          )
          decor(r < 0.2 ? 'cairn' : 'boulder', x, y, Math.floor(r * 16))
          break
        case LAND.WATER:
          g.push(TANGLE_GROUND.water)
          so.push(true)
          if (r < 0.25) decor('reeds', x, y, Math.floor(r * 16))
          break
        case LAND.FORD:
          g.push(TANGLE_GROUND.road)
          so.push(false)
          break
        case LAND.SLOPE:
          g.push(TANGLE_GROUND.verge)
          so.push(false)
          if (r < 0.35) decor(r < 0.15 ? 'roots' : 'pebbles', x, y, Math.floor(r * 16))
          break
        case LAND.PATH:
          g.push(TANGLE_GROUND.path)
          so.push(false)
          break
        default:
          g.push(nearSite(x, y) ? TANGLE_GROUND.trodden : TANGLE_GROUND.moss)
          so.push(false)
          // Wild ground: a tuft here and there (never on the home site).
          if (!nearSite(x, y) && r > 0.9) decor(r > 0.97 ? 'flowers' : r > 0.94 ? 'fern' : 'grass', x, y, Math.floor(r * 16))
          // Desolate: the wild creeps back in over the open ground.
          else if (desolate && r > 0.55) decor(r > 0.8 ? 'fern' : 'grass', x, y, Math.floor(r * 16))
      }
    }
    ground.push(g)
    solid.push(so)
  }
  // The gate mouth stays open (the way back to the Commons).
  for (const y of [11,12]) solid[y][gate % 2 ? 0 : 23] = false
  // Planted things stand where the server says (inside lamplight where
  // they were put; outside, wherever they've wandered to). Small, and
  // walked through: a sapling is its own sprite, a patch the woods' own.
  for (const p of plants) scenery.push(plantScenery(p, atlas))
  const area = OUTDOORS_AREA
  const { door, doorstep } = landDoor()
  return {
    areaId: area,
    width: W,
    height: H,
    widthPx: W * TILE,
    heightPx: H * TILE,
    ground,
    solid,
    trees: [],
    bushes: [],
    rocks: [],
    npcs: [],
    enemies: [],
    exits: [],
    props: [],
    scenery,
    gathering,
    discoverySpots: [],
    groundStyle: 'tangle',
    groundMark: null,
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    glimSpots: [],
    spawn: landEntry(gate),
    gate,
    land,
    served: known !== null,
    site: { ...s },
    door,
    doorstep,
    // The old 16×12 plot's art sat with the site at (4, 0): keep that framing.
    origin: { x: (s.x - 4) * TILE, y: s.y * TILE },
    mailbox: { tx: lotService(gate, 'mailbox').x, ty: 10 },
    desolate
  }
}

