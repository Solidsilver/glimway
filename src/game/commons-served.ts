/**
 * Hearthwick Commons, as the server serves it (docs/design/location-seam.md
 * 6, lane S2): the Commons' six fixed chunks (content/layouts/commons.json,
 * sliced by server/internal/chunks/fixed.go) assembled into the WorldData
 * today's separate Commons scene draws, still behind today's portals. The
 * client builds nothing of the Commons any more; this adapter only unpacks
 * ground, solids and objects by kind, and keeps the old scene's frame: the
 * 62×42 map at layout tile (0, 0), the verge around it left out. S5 joins the
 * Commons to the grid, attaches the chunks to the outdoor window and deletes
 * this file.
 *
 * The chunks are fetched once per layout revision (prepareCommons: at boot,
 * and while the screen is dark on the way in) and kept on the device like
 * the Wilds' (./wilds/chunks.ts). A map built before they arrive is open
 * meadow, marked `served: false`, and rebuilds when they come (EV.homeChanged,
 * reason `commons`; ./entities/homesteads.ts).
 */
import type { Placed, WorldChunk } from '../lib/gen/glimway/v1/wilds_pb.js'
import { fixedEpoch } from '../lib/api/chunks.ts'
import type { OperationsApi } from '../lib/api/operations.ts'
import { calendarAt } from '../lib/calendar.ts'
import { PLACES, fixedChunks } from '../lib/places.ts'
import { TERRAIN, TILE } from '../lib/tile.ts'
import { gameNow } from './clock.ts'
import { EV, bus } from './events.ts'
import type { Session } from './session.ts'
import { loadFixedChunk } from './wilds/chunks.ts'
import type { ExitDef, ForegroundSpot, GatherSpot, NpcId, NpcSpot, PropSpot, ScenerySpot, WorldData } from './worlds.ts'

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
  /** Where you stand on the lane coming back out: the gate's anchor. */
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
  /** The canopies over the trees and the occluders (arch, ferns). */
  foreground: ForegroundSpot[]
  /** False while the server's chunks haven't arrived (open meadow stands in). */
  served: boolean
}

const PLACE = PLACES.fixed.find((f) => f.id === 'commons')!
/** The pseudo-epoch the Commons' chunks are served under. */
export const COMMONS_EPOCH = fixedEpoch(PLACE.layout, PLACE.revision)
/** The old scene's map in layout tiles, which the verge surrounds (goes with this adapter in S5). */
const MAP = { w: 62, h: 42 }
const CHUNK = 24

/** A Commons anchor (content/places.json) as a Commons tile. */
export function commonsTile(anchor: string): { tx: number; ty: number } {
  const a = PLACE.anchors.find((a) => a.id === anchor)
  if (!a) throw new Error(`[glimway] no Commons anchor ${anchor}`)
  return { tx: a.tx, ty: a.ty }
}

/** Arriving from Hearthwick (just inside the gate). */
export const COMMONS_FROM_VILLAGE = commonsTile('west-path')
/** Arriving back from the Wilds (just inside the north arch). */
export const COMMONS_FROM_WILDS = commonsTile('arch')

/** The Commons' chunks, row-major. */
export function commonsChunkKeys(): { cx: number; cy: number }[] {
  const { x0, y0, x1, y1 } = fixedChunks(PLACE)
  const out: { cx: number; cy: number }[] = []
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push({ cx, cy })
  return out
}

/** What the calendar has out today: an object tagged with either is drawn. */
export interface CommonsDay {
  festival: string | null
  wick: string
}

function sceneryOf(o: Placed, tx: number, ty: number): ScenerySpot {
  const a = o.art!
  return {
    key: o.variant,
    ...(o.frame ? { frame: o.frame } : {}),
    x: tx * TILE + a.ox,
    y: ty * TILE + a.oy,
    ...(a.originLeft ? { originX: 0 } : {}),
    ...(a.depth !== undefined ? { depth: a.depth } : a.depthY ? { depth: 'y' as const } : {}),
    ...(a.flip ? { flipX: true } : {}),
    ...(a.tint !== undefined ? { tint: a.tint } : {}),
    ...(a.tile ? { tx, ty } : {})
  }
}

function exitOf(o: Placed, tx: number, ty: number): ExitDef {
  const e = o.exit!
  return { tx, ty, tw: o.tw, th: o.th, to: e.to, entry: { tx: e.entryTx, ty: e.entryTy }, ...(e.unlabelled ? { label: null } : {}) }
}

/**
 * The Commons map from its served chunks (any order): the map's ground and
 * solids, and each object on the map by its kind, if the day has it out.
 */
export function assembleCommons(chunks: readonly WorldChunk[], day: CommonsDay): CommonsWorld {
  const ground: number[][] = Array.from({ length: MAP.h }, () => Array<number>(MAP.w).fill(TERRAIN.grass_a))
  const solid: boolean[][] = Array.from({ length: MAP.h }, () => Array<boolean>(MAP.w).fill(false))
  const trees: { tx: number; ty: number }[] = []
  const bushes: { tx: number; ty: number }[] = []
  const rocks: { tx: number; ty: number }[] = []
  const props: PropSpot[] = []
  const scenery: ScenerySpot[] = []
  const gathering: GatherSpot[] = []
  const foreground: ForegroundSpot[] = []
  const npcs: NpcSpot[] = []
  const exits: ExitDef[] = []
  const slots = new Map<number, Partial<GateSlot>>()
  const lamps: { tx: number; ty: number }[] = []
  const named = new Map<string, { tx: number; ty: number }>()
  let board: { tx: number; ty: number } | undefined
  const onMap = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP.w && y < MAP.h
  const slot = (g: number) => slots.get(g) ?? slots.set(g, { gate: g }).get(g)!
  const sorted = [...chunks].sort((a, b) => a.cy - b.cy || a.cx - b.cx)
  for (const c of sorted) {
    if (c.epochId !== COMMONS_EPOCH) throw new Error(`[glimway] a Commons chunk of ${c.epochId}`)
    // The chunk's north-west tile, in Commons tiles.
    const x0 = c.cx * CHUNK - PLACE.origin.tx
    const y0 = c.cy * CHUNK - PLACE.origin.ty
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      const x = x0 + (i % CHUNK)
      const y = y0 + Math.floor(i / CHUNK)
      if (!onMap(x, y)) continue
      const name = c.palette[(c.ground[i >> 1]! >> (4 * (i % 2))) & 15]! as keyof typeof TERRAIN
      ground[y]![x] = TERRAIN[name]
      solid[y]![x] = (c.solid[i >> 3]! & (1 << (i % 8))) !== 0
    }
    for (const o of c.objects) {
      const tx = x0 + o.tx
      const ty = y0 + o.ty
      if (!onMap(tx, ty) || (o.festival && o.festival !== day.festival && o.festival !== day.wick)) continue
      const at = { tx, ty }
      named.set(o.id, at)
      if (o.art) scenery.push(sceneryOf(o, tx, ty))
      if (o.prop) props.push({ frame: o.variant, tx, ty, h: o.prop.h, body: [o.prop.bodyW, o.prop.bodyH], ...(o.prop.light ? { light: o.prop.light } : {}) })
      switch (o.kind) {
        case 'tree':
          trees.push(at)
          if (o.variant) foreground.push({ frame: o.variant, tx, ty, w: o.width })
          break
        case 'bush':
          bushes.push(at)
          break
        case 'rock':
          rocks.push(at)
          break
        case 'overhang':
          foreground.push({ frame: o.variant, tx, ty, w: o.width })
          break
        case 'lamp':
          lamps.push(at)
          break
        case 'board':
          board = at
          break
        case 'gate':
          exits.push(exitOf(o, tx, ty))
          Object.assign(slot(o.gate), { tx, ty, side: o.side as GateSlot['side'], entry: commonsTile(`gate:${o.gate}`) })
          break
        case 'sign':
          slot(o.gate).sign = at
          break
        case 'shelf':
          slot(o.gate).shelf = at
          break
        case 'exit':
          exits.push(exitOf(o, tx, ty))
          break
        case 'npc-post':
          npcs.push({ id: o.npc as NpcId, tx, ty, ...(o.spot ? { spot: o.spot } : {}) })
          break
        case 'gather':
          gathering.push({ target: o.target, label: o.label, tx, ty, art: { key: o.variant } })
          break
      }
    }
  }
  const feature = (id: string) => {
    const at = named.get(id)
    if (!at) throw new Error(`[glimway] the served Commons has no ${id}`)
    return at
  }
  const gates = [...slots.values()].sort((a, b) => a.gate! - b.gate!) as GateSlot[]
  return {
    areaId: 'commons',
    width: MAP.w,
    height: MAP.h,
    widthPx: MAP.w * TILE,
    heightPx: MAP.h * TILE,
    ground,
    solid,
    trees,
    bushes,
    rocks,
    npcs,
    enemies: [],
    exits,
    props,
    scenery,
    gathering,
    discoverySpots: [],
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    glimSpots: [],
    spawn: { ...COMMONS_FROM_VILLAGE },
    ...(board ? { board } : {}),
    gates,
    features: {
      gate: feature('commons-gate'),
      hame: feature('hame'),
      well: feature('well'),
      board: feature('board'),
      silas: feature('npc-post:silas'),
      toolbox: feature('toolbox'),
      firebox: feature('firebox'),
      skids: feature('skids'),
      lamps
    },
    foreground,
    served: true
  }
}

/** Open meadow the size of the map while the chunks are on their way: walkable, nothing on it. */
function provisionalCommons(): CommonsWorld {
  const at = { ...COMMONS_FROM_VILLAGE }
  return {
    areaId: 'commons',
    width: MAP.w,
    height: MAP.h,
    widthPx: MAP.w * TILE,
    heightPx: MAP.h * TILE,
    ground: Array.from({ length: MAP.h }, () => Array<number>(MAP.w).fill(TERRAIN.grass_a)),
    solid: Array.from({ length: MAP.h }, () => Array<boolean>(MAP.w).fill(false)),
    trees: [],
    bushes: [],
    rocks: [],
    npcs: [],
    enemies: [],
    exits: [],
    props: [],
    scenery: [],
    gathering: [],
    discoverySpots: [],
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    glimSpots: [],
    spawn: at,
    gates: [],
    features: { gate: at, hame: at, well: at, board: at, silas: at, toolbox: at, firebox: at, skids: at, lamps: [] },
    foreground: [],
    served: false
  }
}

/** The served chunks, once all are here (this revision's). */
let served: WorldChunk[] | null = null
let loading: Promise<void> | null = null

/** Have the Commons' chunks arrived? */
export function commonsServed(): boolean {
  return served !== null
}

/**
 * Fetch the Commons' chunks (once per revision; from the device's cache
 * when it has them). The map rebuilds when they land. Without a server
 * there is nothing to fetch.
 */
export function prepareCommons(session: Pick<Session, 'link'>): Promise<void> | null {
  if (served) return Promise.resolve()
  const api = session.link?.api.operations
  if (!api) return null
  if (!loading) {
    loading = loadCommonsChunks(api)
      .then((chunks) => {
        served = chunks
        bus.emit(EV.homeChanged, { reason: 'commons' })
      })
      .catch(() => undefined)
      .finally(() => {
        loading = null
      })
  }
  return loading
}

/** The Commons' chunks through the device's chunk cache (./wilds/chunks.ts). */
export function loadCommonsChunks(api: Pick<OperationsApi, 'chunk'>): Promise<WorldChunk[]> {
  return Promise.all(commonsChunkKeys().map(({ cx, cy }) => loadFixedChunk(api, COMMONS_EPOCH, cx, cy)))
}

/** The Commons map: from the served chunks with today's calendar, or meadow until they come. */
export function servedCommons(): CommonsWorld {
  if (!served) return provisionalCommons()
  const cal = calendarAt(gameNow())
  return assembleCommons(served, { festival: cal.festival, wick: cal.wick })
}

/** Test seam: forget the served chunks. */
export function forgetCommons(): void {
  served = null
  loading = null
}

/** Test seam: the chunks as if served (validated by the caller). */
export function serveCommonsChunks(chunks: readonly WorldChunk[]): void {
  served = [...chunks]
}
