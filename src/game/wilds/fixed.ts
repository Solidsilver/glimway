/**
 * Fixed ground on the open map (docs/design/location-seam.md 1.2, 4, lane
 * S5): an authored layout's chunks (the Commons', content/layouts, sliced by
 * server/internal/chunks/fixed.go), on the outdoor grid beside the Tangle.
 * The client builds none of it: this unpacks the served chunks into world
 * tiles and keeps them for the window, which attaches them like generated
 * ones (./fixed-chunk.ts), one chunk at a time.
 *
 * A footprint's chunks are fetched together, once per layout revision, from
 * the device's chunk cache when it has them (./chunks.ts loadFixedChunk):
 * at boot, and while the screen is dark on the way into the open map
 * (./store.ts prepareWilds). Until they're here the footprint is solid and
 * nothing of it is drawn.
 *
 * Every object belongs to the chunk it is served in (the one holding its
 * tile): that chunk draws it, and takes it away when it detaches.
 */
import type { Placed, WorldChunk } from '../../lib/gen/glimway/v1/wilds_pb.js'
import { fixedEpoch } from '../../lib/api/chunks.ts'
import type { OperationsApi } from '../../lib/api/operations.ts'
import { anchor, sourceOf } from '../../lib/location.ts'
import { PLACES, fixedChunks, type FixedPlace } from '../../lib/places.ts'
import { TERRAIN, TILE } from '../../lib/tile.ts'
import { EV, bus } from '../events.ts'
import type { Session } from '../session.ts'
import type { ExitDef, NpcId, NpcSpot, ScenerySpot } from '../worlds.ts'
import { loadFixedChunk } from './chunks.ts'
import { CHUNK_TILES, chunkKey } from './coords.ts'

/** One layout object, in world tiles, as its chunk serves it. */
export interface FixedObject {
  id: string
  kind: string
  tx: number
  ty: number
  tw: number
  th: number
  variant: string
  frame: string
  /** A festival or wick name: drawn only while the calendar has it out. */
  festival: string
  width: number
  gate: number
  side: string
  npc: string
  spot: string
  target: string
  label: string
  art: Placed['art']
  prop: Placed['prop']
  exit: Placed['exit']
}

/** A fixed footprint's ground, solids and objects, once its chunks are here. */
export interface FixedFootprint {
  place: FixedPlace
  /** The pseudo-epoch its chunks are served under. */
  epoch: string
  /** World tile of the footprint's north-west corner, and its size in tiles. */
  tx: number
  ty: number
  w: number
  h: number
  /** Footprint-local grids, [ly][lx]: TERRAIN ids and solidity. */
  ground: number[][]
  solid: boolean[][]
  /** Each chunk's objects ('cx,cy'). */
  objects: Map<string, FixedObject[]>
  /** Tiles joined to an arrival anchor over open ground (footprint-local, row-major; 1 = joined). */
  reach: Uint8Array
}

/** One homestead gate on the lane, in world tiles. */
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
  /** The chunk that draws the gate's sign and shelf. */
  chunk: string
}

/** Fixed things in the Commons the homestead layer talks about, in world tiles. */
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

/** The Commons lane as the homestead layer sees it. */
export interface CommonsLane {
  gates: GateSlot[]
  features: CommonsFeatures
}

/** What the calendar has out today: an object tagged with either is drawn. */
export interface FixedDay {
  festival: string | null
  wick: string
}

const footprints = new Map<string, FixedFootprint>()
let loading: Promise<void> | null = null

/** An anchor ("commons:arch") as its world tile. */
export function anchorTile(id: string): { tx: number; ty: number } {
  const a = anchor(id)
  if (!a) throw new Error(`[glimway] no anchor ${id}`)
  return { tx: Math.floor(a.x / TILE), ty: Math.floor(a.y / TILE) }
}

/** Where you come back out of homestead gate `gate` onto the Commons: its gate anchor (the arch past the frozen capacity). */
export function gateAnchor(gate: number): { tx: number; ty: number } {
  return anchor(`commons:gate:${gate}`) ? anchorTile(`commons:gate:${gate}`) : anchorTile('commons:arch')
}

/** The fixed place a chunk lies in, or null. */
export function fixedPlaceOf(cx: number, cy: number): FixedPlace | null {
  const s = sourceOf(cx, cy)
  return s.kind === 'fixed' ? PLACES.fixed.find((f) => f.layout === s.layout) ?? null : null
}

/** A fixed place's chunks, row-major. */
export function fixedChunkKeys(place: FixedPlace): { cx: number; cy: number }[] {
  const { x0, y0, x1, y1 } = fixedChunks(place)
  const out: { cx: number; cy: number }[] = []
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push({ cx, cy })
  return out
}

/** A fixed place's footprint, once its chunks are here. */
export function footprint(id: string): FixedFootprint | null {
  return footprints.get(id) ?? null
}

/** The footprint holding a chunk, once its chunks are here (null off fixed ground, or before they come). */
export function footprintAt(cx: number, cy: number): FixedFootprint | null {
  const p = fixedPlaceOf(cx, cy)
  return p ? footprints.get(p.id) ?? null : null
}

/** Are every fixed place's chunks here? */
export function fixedReady(): boolean {
  return PLACES.fixed.every((p) => footprints.has(p.id))
}

/**
 * Fetch every fixed place's chunks (once per revision; from the device's
 * cache when it has them). Without a server there is nothing to fetch.
 */
export function prepareFixed(session: Pick<Session, 'link'>): Promise<void> | null {
  if (fixedReady()) return Promise.resolve()
  const api = session.link?.api.operations
  if (!api) return null
  if (!loading) {
    loading = Promise.all(PLACES.fixed.filter((p) => !footprints.has(p.id)).map((p) => loadFootprint(api, p)))
      .then(() => {
        bus.emit(EV.fixedReady)
      })
      .catch(() => undefined)
      .finally(() => {
        loading = null
      })
  }
  return loading
}

async function loadFootprint(api: Pick<OperationsApi, 'chunk'>, place: FixedPlace): Promise<void> {
  const epoch = fixedEpoch(place.layout, place.revision)
  const chunks = await Promise.all(fixedChunkKeys(place).map(({ cx, cy }) => loadFixedChunk(api, epoch, cx, cy)))
  footprints.set(place.id, assembleFootprint(place, chunks))
}

/** A footprint from its served chunks (any order). */
export function assembleFootprint(place: FixedPlace, chunks: readonly WorldChunk[]): FixedFootprint {
  const epoch = fixedEpoch(place.layout, place.revision)
  const { x0, y0, x1, y1 } = fixedChunks(place)
  const w = (x1 - x0 + 1) * CHUNK_TILES
  const h = (y1 - y0 + 1) * CHUNK_TILES
  const ground: number[][] = Array.from({ length: h }, () => Array<number>(w).fill(TERRAIN.grass_a))
  const solid: boolean[][] = Array.from({ length: h }, () => Array<boolean>(w).fill(true))
  const objects = new Map<string, FixedObject[]>()
  for (const c of chunks) {
    if (c.epochId !== epoch) throw new Error(`[glimway] a ${place.id} chunk of ${c.epochId}`)
    if (c.cx < x0 || c.cx > x1 || c.cy < y0 || c.cy > y1) throw new Error(`[glimway] chunk ${c.cx},${c.cy} is not ${place.id}'s`)
    const lx0 = (c.cx - x0) * CHUNK_TILES
    const ly0 = (c.cy - y0) * CHUNK_TILES
    for (let i = 0; i < CHUNK_TILES * CHUNK_TILES; i++) {
      const x = lx0 + (i % CHUNK_TILES)
      const y = ly0 + Math.floor(i / CHUNK_TILES)
      const name = c.palette[(c.ground[i >> 1]! >> (4 * (i % 2))) & 15]! as keyof typeof TERRAIN
      ground[y]![x] = TERRAIN[name]
      solid[y]![x] = (c.solid[i >> 3]! & (1 << (i % 8))) !== 0
    }
    const wx0 = c.cx * CHUNK_TILES
    const wy0 = c.cy * CHUNK_TILES
    objects.set(
      chunkKey(c.cx, c.cy),
      c.objects.map((o) => ({
        id: o.id,
        kind: o.kind,
        tx: wx0 + o.tx,
        ty: wy0 + o.ty,
        tw: o.tw,
        th: o.th,
        variant: o.variant,
        frame: o.frame,
        festival: o.festival,
        width: o.width,
        gate: o.gate,
        side: o.side,
        npc: o.npc,
        spot: o.spot,
        target: o.target,
        label: o.label,
        art: o.art,
        prop: o.prop,
        exit: o.exit
      }))
    )
  }
  const fp: FixedFootprint = { place, epoch, tx: x0 * CHUNK_TILES, ty: y0 * CHUNK_TILES, w, h, ground, solid, objects, reach: new Uint8Array(w * h) }
  fp.reach = joinedGround(fp)
  return fp
}

/** Tiles an arrival anchor reaches over open ground (the arch, the west path, the yard door, every gate). */
function joinedGround(fp: FixedFootprint): Uint8Array {
  const { w, h, solid } = fp
  const out = new Uint8Array(w * h)
  const queue: [number, number][] = []
  for (const a of fp.place.anchors) {
    const x = a.tx + fp.place.origin.tx - fp.tx
    const y = a.ty + fp.place.origin.ty - fp.ty
    if (x < 0 || y < 0 || x >= w || y >= h || solid[y]![x]) continue
    out[y * w + x] = 1
    queue.push([x, y])
  }
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i]!
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || solid[ny]![nx] || out[ny * w + nx]) continue
      out[ny * w + nx] = 1
      queue.push([nx, ny])
    }
  }
  return out
}

const local = (fp: FixedFootprint, tx: number, ty: number) => {
  const x = tx - fp.tx
  const y = ty - fp.ty
  return x >= 0 && y >= 0 && x < fp.w && y < fp.h ? { x, y } : null
}

/** The fixed footprint holding a world tile, or null (off fixed ground). */
function footprintOfTile(tx: number, ty: number): FixedFootprint | null {
  return footprintAt(Math.floor(tx / CHUNK_TILES), Math.floor(ty / CHUNK_TILES))
}

/** The ground (a TERRAIN id) at a fixed world tile, or null (not fixed, or not here yet). */
export function fixedGroundAt(tx: number, ty: number): number | null {
  const fp = footprintOfTile(tx, ty)
  const l = fp && local(fp, tx, ty)
  return l ? fp.ground[l.y]![l.x]! : null
}

/** Is a fixed world tile solid? (True while its chunks aren't here.) */
export function fixedSolidAt(tx: number, ty: number): boolean {
  const fp = footprintOfTile(tx, ty)
  const l = fp && local(fp, tx, ty)
  return !l || fp.solid[l.y]![l.x]!
}

/**
 * Where to stand for a fixed world tile: the tile itself when it joins an
 * arrival anchor on open ground, else the nearest tile that does (a save
 * can name an open pocket walled in by the woods). Null when its chunks
 * aren't here.
 */
export function fixedStand(tx: number, ty: number): { tx: number; ty: number } | null {
  const fp = footprintOfTile(tx, ty)
  if (!fp) return null
  const l = local(fp, tx, ty)!
  if (fp.reach[l.y * fp.w + l.x]) return { tx, ty }
  let best: { tx: number; ty: number } | null = null
  let bestD = Infinity
  for (let i = 0; i < fp.reach.length; i++) {
    if (!fp.reach[i]) continue
    const x = i % fp.w
    const y = (i - x) / fp.w
    const d = (x - l.x) ** 2 + (y - l.y) ** 2
    if (d < bestD) {
      bestD = d
      best = { tx: fp.tx + x, ty: fp.ty + y }
    }
  }
  return best
}

/** Is an object out today? (Untagged ones always are.) */
export function objectOut(o: Pick<FixedObject, 'festival'>, day: FixedDay): boolean {
  return !o.festival || o.festival === day.festival || o.festival === day.wick
}

/** An object's drawn picture as scenery, in world px. */
export function sceneryOf(o: FixedObject): ScenerySpot | null {
  const a = o.art
  if (!a) return null
  return {
    key: o.variant,
    ...(o.frame ? { frame: o.frame } : {}),
    x: o.tx * TILE + a.ox,
    y: o.ty * TILE + a.oy,
    ...(a.originLeft ? { originX: 0 } : {}),
    ...(a.depth !== undefined ? { depth: a.depth } : a.depthY ? { depth: 'y' as const } : {}),
    ...(a.flip ? { flipX: true } : {}),
    ...(a.tint !== undefined ? { tint: a.tint } : {}),
    ...(a.tile ? { tx: o.tx, ty: o.ty } : {})
  }
}

/**
 * An exit or gate as a way out, in world tiles (null for a way to the open
 * map itself: the joined footprint is walked into, not through a portal).
 * Its arrival is the destination's own tile, as the layout names it; its
 * side, the footprint edge it is nearest.
 */
export function exitOf(o: FixedObject, fp: Pick<FixedFootprint, 'tx' | 'ty' | 'w' | 'h'>): ExitDef | null {
  const e = o.exit
  if (!e || e.to === 'outdoors') return null
  const side = o.tw > o.th ? (o.ty - fp.ty < fp.h / 2 ? 'north' : 'south') : o.tx - fp.tx < fp.w / 2 ? 'west' : 'east'
  return { tx: o.tx, ty: o.ty, tw: o.tw, th: o.th, to: e.to, entry: { tx: e.entryTx, ty: e.entryTy }, side, ...(e.unlabelled ? { label: null } : {}) }
}

/** The Commons lane (gates and fixtures) in world tiles, once its chunks are here. */
export function commonsLane(): CommonsLane | null {
  const fp = footprints.get('commons')
  if (!fp) return null
  const named = new Map<string, { tx: number; ty: number }>()
  const slots = new Map<number, Partial<GateSlot>>()
  const lamps: { tx: number; ty: number }[] = []
  const slot = (g: number) => slots.get(g) ?? slots.set(g, { gate: g }).get(g)!
  for (const [key, list] of fp.objects)
    for (const o of list) {
      const at = { tx: o.tx, ty: o.ty }
      named.set(o.id, at)
      if (o.kind === 'lamp') lamps.push(at)
      else if (o.kind === 'gate') Object.assign(slot(o.gate), { tx: o.tx, ty: o.ty, side: o.side as GateSlot['side'], entry: anchorTile(`commons:gate:${o.gate}`) })
      else if (o.kind === 'sign') Object.assign(slot(o.gate), { sign: at, chunk: key })
      else if (o.kind === 'shelf') slot(o.gate).shelf = at
    }
  const feature = (id: string) => {
    const at = named.get(id)
    if (!at) throw new Error(`[glimway] the served Commons has no ${id}`)
    return at
  }
  return {
    gates: [...slots.values()].sort((a, b) => a.gate! - b.gate!) as GateSlot[],
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
    }
  }
}

/**
 * The residents posted on fixed ground (Silas by his sawhorse, Elara at her
 * camp), in world tiles, once the chunks are here. The open map stands them
 * for its whole scene for now; per-chunk residents come with lane S5b.
 */
export function fixedNpcs(): NpcSpot[] {
  const out: NpcSpot[] = []
  for (const fp of footprints.values())
    for (const list of fp.objects.values())
      for (const o of list) if (o.kind === 'npc-post') out.push({ id: o.npc as NpcId, tx: o.tx, ty: o.ty, ...(o.spot ? { spot: o.spot } : {}) })
  return out
}

/** The chunk key a world tile lies in. */
export function chunkOfTile(tx: number, ty: number): string {
  return chunkKey(Math.floor(tx / CHUNK_TILES), Math.floor(ty / CHUNK_TILES))
}

/** Test seam: forget the footprints. */
export function forgetFixed(): void {
  footprints.clear()
  loading = null
}

/** Test seam: a footprint as if its chunks were served. */
export function serveFixed(place: FixedPlace, chunks: readonly WorldChunk[]): FixedFootprint {
  const fp = assembleFootprint(place, chunks)
  footprints.set(place.id, fp)
  return fp
}
