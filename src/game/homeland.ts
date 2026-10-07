/**
 * A homestead's land, the map behind a Commons gate (area `home:<gate>`):
 * wild ground generated per gate (src/lib/homestead-land.ts, the same land
 * the server validates against), drawn with the Tangle's look — woods
 * floor, its trees, stumps and stones — with the home site near the top,
 * a path down to the gate mouth in the south edge, and the way back to the
 * Commons through it.
 *
 * What changes (the camp or cottage, decorations, lantern posts and their
 * light, cleared tiles, desolation) comes from the homestead state through
 * `setLandSource`; the scene layer (src/game/entities/homesteads.ts) draws
 * the buildings and pieces on top.
 */
import { HOMESTEAD_DATA, gateTile, homeArea, parseHomeArea } from '../lib/homestead.ts'
import { LAND, generateLand, landSeed, type Land } from '../lib/homestead-land.ts'
import { TANGLE_GROUND } from '../lib/wilds/tangle.ts'
import type { DecorKind } from '../lib/wilds/types.ts'
import { DECOR_ART } from '../lib/wilds/tangle.ts'
import { TILE } from './textures.ts'
import { tangleFrame } from './wilds/tangle-key.ts'
import { lookAtlasKey } from './wilds/wilds-looks.ts'
import { itemIcon } from './items-pass.ts'
import type { ScenerySpot, WorldData, GatherSpot } from './worlds.ts'

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
  const at = { x: p.x * TILE + TILE / 2, y: (p.y + 1) * TILE, depth: 'y' as const, flipX: h32(p.x, p.y, 6) < 0.5, tx: p.x, ty: p.y }
  return patch ? { key: atlas, frame: tangleFrame(patch, Math.floor(h32(p.x, p.y, 13) * 16)), ...at } : { key: itemIcon(p.itemDef), ...at }
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
  /** The server's seed for a gate, once read (it wins over the local one). */
  seed?(gate: number): number | null
}

let source: LandSource = { worldId: () => 'guest', state: () => null }

export function setLandSource(s: LandSource): void {
  source = s
}

export interface LandWorld extends WorldData {
  gate: number
  land: Land
  /** The seed the land was generated from. */
  seed: number
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

/** Where you arrive on the Commons coming back out of gate g (the lane side of it). */
function commonsEntryFor(gate: number): { tx: number; ty: number } {
  const t = gateTile(gate)
  return { tx: t.side === 'west' ? t.tx + 1 : t.tx - 1, ty: t.ty }
}

/** Where you arrive on a homestead's land through its gate. */
export function landEntry(): { tx: number; ty: number } {
  const L = HOMESTEAD_DATA.land
  return { tx: L.gate.x, ty: L.height - 2 }
}

/** The seed of a gate's land in this world: the server's when read, else from the world id. */
export function seedFor(gate: number): number {
  return source.seed?.(gate) ?? landSeed(source.worldId(), gate)
}

function h32(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const TREES: DecorKind[] = ['oak', 'oak', 'pine', 'birch', 'pine', 'oak']

export function buildLand(gate: number): LandWorld {
  const L = HOMESTEAD_DATA.land
  const seed = seedFor(gate)
  const land = generateLand(seed)
  const st = source.state(gate)
  const cleared = new Set((st?.cleared ?? []).map(([x, y]) => `${x},${y}`))
  const stumps = new Set((st?.stumps ?? []).map(([x, y]) => `${x},${y}`))
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
      x: tx * TILE + TILE / 2 + Math.round((h32(tx, ty, 5) - 0.5) * 4),
      y: (ty + 1) * TILE,
      depth: DECOR_ART[kind].flat ? -5 : 'y',
      flipX: h32(tx, ty, 6) < 0.5,
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
      const r = h32(x, y, 11)
      if (stumps.has(`${x},${y}`)) k = LAND.STUMP
      if ((k === LAND.TREE || k === LAND.STUMP || k === LAND.BOULDER) && cleared.has(`${x},${y}`)) k = LAND.GRASS
      switch (k) {
        case LAND.EDGE:
          g.push(TANGLE_GROUND.woods)
          so.push(true)
          if (r < 0.75) decor(TREES[Math.floor(h32(x, y, 3) * TREES.length)], x, y, Math.floor(r * 16), { tint: 0xc4c4cc })
          break
        case LAND.TREE:
          g.push(TANGLE_GROUND.woods)
          so.push(true)
          gathering.push(
            r < 0.08
              ? { target: 'iron-oak', label: 'Chop the iron-oak', tx: x, ty: y }
              : { target: 'tree', label: 'Chop the tree', tx: x, ty: y }
          )
          decor(r < 0.08 ? 'iron-oak' : TREES[Math.floor(h32(x, y, 3) * TREES.length)], x, y, Math.floor(r * 16))
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
  for (let x = L.gate.x; x < L.gate.x + L.gate.w; x++) solid[H - 1][x] = false
  // Planted things stand where the server says (inside lamplight where
  // they were put; outside, wherever they've wandered to). Small, and
  // walked through: a sapling is its own sprite, a patch the woods' own.
  for (const p of plants) scenery.push(plantScenery(p, atlas))
  const area = homeArea(gate)
  const door = { tx: s.x + Math.floor(s.w / 2) - 1, ty: s.y + s.h - 2 }
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
    exits: [{ tx: L.gate.x, ty: H - 1, tw: L.gate.w, th: 1, to: 'commons', entry: commonsEntryFor(gate) }],
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
    emberSpots: [],
    spawn: landEntry(),
    gate,
    land,
    seed,
    site: { ...s },
    door,
    doorstep: { tx: door.tx, ty: door.ty + 1 },
    // The old 16×12 plot's art sat with the site at (4, 0): keep that framing.
    origin: { x: (s.x - 4) * TILE, y: s.y * TILE },
    mailbox: { tx: L.gate.x + L.gate.w, ty: s.y + s.h },
    desolate
  }
}

/** The area kind for `home:<gate>` ids (null for any other id): see worlds.ts. */
export function homeLandKind(id: string): { build: () => WorldData; foreground: () => [] } | null {
  const gate = parseHomeArea(id)
  return gate === null ? null : { build: () => buildLand(gate), foreground: () => [] }
}
