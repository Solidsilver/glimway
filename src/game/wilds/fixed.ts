import type { HomeView } from '../../lib/api/types.ts'
import { lotOrigin, lotLayout, insideLot } from '../../lib/lots.ts'
import { lotAt, plotEpoch, plotIdentity, PLOT_REVISION } from '../../lib/lots.ts'
import { HOMESTEAD_DATA } from '../../lib/homestead.ts'
import { lanternFrame, lanternLook } from '../../lib/lot-lantern.ts'
import { hw2Art } from '../hearthwick2-art.ts'
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
import { loadFixedChunk, keepPlotWorld } from './chunks.ts'
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
  /** A lot's cleared tiles (footprint-local): painted as trodden earth (./fixed-ground.ts). */
  cleared?: readonly (readonly [number, number])[]
}

/** One homestead gate on the lane, in world tiles. */
export interface GateSlot {
  gate: number
  /** The two-tile vertical gap in the lot’s front fence. */
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
  mark?: string
  wick: string
}

const footprints = new Map<string, FixedFootprint>()
let loading: Promise<void> | null = null
let loadingWorld = ''
let desiredWorld = ''

/** An anchor ("hearthwick:arch") as its world tile. */
export function anchorTile(id: string): { tx: number; ty: number } {
  const a = anchor(id)
  if (!a) throw new Error(`[glimway] no anchor ${id}`)
  return { tx: Math.floor(a.x / TILE), ty: Math.floor(a.y / TILE) }
}

/** Where you come back out of homestead gate `gate` onto the Commons: its gate anchor (the arch past the frozen capacity). */

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
  const world = session.link?.worldId ?? ''
  desiredWorld = world
  keepPlotWorld(world)
  for (const p of PLACES.fixed.filter(p => p.kind === 'plots')) {
    const plots = footprints.get(p.id)
    if (plots && plots.epoch !== `plot:${world}@${PLOT_REVISION}`) footprints.delete(p.id)
  }
  if (fixedReady()) return Promise.resolve()
  const api = session.link?.api.operations
  if (!api) return null
  if (!loading || loadingWorld !== world) {
    loadingWorld = world
    const request = Promise.all(PLACES.fixed.filter((p) => !footprints.has(p.id)).map((p) => loadFootprint(api, p, world)))
      .then(() => {
        if (desiredWorld === world) bus.emit(EV.fixedReady)
      })
      .catch(() => undefined)
      .finally(() => {
        if (loading === request) loading = null
      })
    loading = request
  }
  return loading
}

let fixedReads = 0
const fixedWaiting: (() => void)[] = []
async function limitedFixed<T>(read: () => Promise<T>): Promise<T> {
 if (fixedReads >= 8) await new Promise<void>((resolve) => fixedWaiting.push(resolve))
 else fixedReads++
 try { return await read() } finally { const next = fixedWaiting.shift(); if (next) next(); else fixedReads-- }
}

async function loadFootprint(api: Pick<OperationsApi, 'chunk'>, place: FixedPlace, world: string): Promise<void> {
  const epoch = fixedEpoch(place.layout, place.revision)
  const chunks = await Promise.all(fixedChunkKeys(place).map(({ cx, cy }) => limitedFixed(() => loadFixedChunk(api, place.kind === 'plots' ? plotEpoch(world, lotAt(cx, cy)!) : epoch, cx, cy))))
  if (desiredWorld === world) serveFixed(place, chunks)
}

/** A footprint from its served chunks (any order). */
export function assembleFootprint(place: FixedPlace, chunks: readonly WorldChunk[]): FixedFootprint {
  const plot = chunks[0] && plotIdentity(chunks[0].epochId)
  const epoch = plot ? `plot:${plot.world}@${PLOT_REVISION}` : fixedEpoch(place.layout, place.revision)
  const { x0, y0, x1, y1 } = fixedChunks(place)
  const w = (x1 - x0 + 1) * CHUNK_TILES
  const h = (y1 - y0 + 1) * CHUNK_TILES
  const ground: number[][] = Array.from({ length: h }, () => Array<number>(w).fill(TERRAIN.grass_a))
  const solid: boolean[][] = Array.from({ length: h }, () => Array<boolean>(w).fill(true))
  const objects = new Map<string, FixedObject[]>()
  for (const c of chunks) {
    if (c.epochId !== (plot ? plotEpoch(plot.world, lotAt(c.cx, c.cy)!) : epoch)) throw new Error(`[glimway] a ${place.id} chunk of ${c.epochId}`)
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
  for (const list of fp.objects.values()) for (const o of list) if (o.kind === 'gate' || o.id === 'wildgate:arch') {
    const x=o.tx-fp.tx,y=o.ty-fp.ty
    if (!solid[y]![x]) {out[y*w+x]=1;queue.push([x,y])}
  }
  // Lane anchors seed town; each lot is seeded at its own gate above.
  for (const place of PLACES.fixed) for (const a of place.anchors) {
    const x = a.tx + place.origin.tx - fp.tx
    const y = a.ty + place.origin.ty - fp.ty
    if (x < 0 || y < 0 || x >= w || y >= h || solid[y]![x] || out[y * w + x]) continue
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
  if (!fp.reach.length) fp.reach = joinedGround(fp)
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
  return !o.festival || o.festival === day.festival || o.festival === day.wick || o.festival === day.mark
}

/** An object's drawn picture as scenery, in world px. */
export function sceneryOf(o: FixedObject): ScenerySpot | null {
  const a = o.art
  if (!a) return null
  return {
    key: o.variant,
    ...(o.frame ? { frame: o.frame } : {}),
    ...(o.kind === 'scenery' && o.tw > 0 && o.th > 0 ? { groundUnder: { tx: o.tx, ty: o.ty - o.th + 1, tw: o.tw, th: o.th, tile: TERRAIN.grass_a } } : {}),
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
 * An exit or gate as a way out, in world tiles (null without exit data).
 * Its arrival is the destination's own tile, as the layout names it; its
 * side, the footprint edge it is nearest.
 */
export function exitOf(o: FixedObject, fp: Pick<FixedFootprint, 'tx' | 'ty' | 'w' | 'h'>): ExitDef | null {
  const e = o.exit
  if (!e) return null
  const side = o.tw > o.th ? (o.ty - fp.ty < fp.h / 2 ? 'north' : 'south') : o.tx - fp.tx < fp.w / 2 ? 'west' : 'east'
  return { tx: o.tx, ty: o.ty, tw: o.tw, th: o.th, to: e.to, entry: { tx: e.entryTx, ty: e.entryTy }, side, ...(e.unlabelled ? { label: null } : o.label ? { label: o.label } : {}) }
}

/** The Commons lane (gates and fixtures) in world tiles, once its chunks are here. */
export function commonsLane(): CommonsLane | null {
  const fp = footprints.get('hearthwick')
  if (!fp || !PLACES.fixed.filter(p => p.kind === 'plots').every(p => footprints.has(p.id))) return null
  const named = new Map<string, { tx: number; ty: number }>()
  const slots = new Map<number, Partial<GateSlot>>()
  const lamps: { tx: number; ty: number }[] = []
  const slot = (g: number) => slots.get(g) ?? slots.set(g, { gate: g }).get(g)!
  for (const place of [fp, ...PLACES.fixed.filter(p => p.kind === 'plots').map(p => footprints.get(p.id))].filter((p): p is FixedFootprint => !!p)) for (const [key, list] of place.objects)
    for (const o of list) {
      const at = { tx: o.tx, ty: o.ty }
      named.set(o.id, at)
      if (o.kind === 'lamp') lamps.push(at)
      else if (o.kind === 'gate') Object.assign(slot(o.gate), { tx: o.tx, ty: o.ty, side: o.side as GateSlot['side'], entry: anchorTile(`hearthwick:lot:${o.gate}`) })
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
      gate: anchorTile('hearthwick:arch'),
      hame: feature('gate-hame'),
      well: feature('town-well'),
      board: feature('town-board'),
      silas: feature('npc:silas'),
      toolbox: feature('toolbox'),
      firebox: feature('firebox'),
      skids: feature('skids'),
      lamps
    }
  }
}

/**
 * The residents posted on fixed ground (Silas by his sawhorse, Elara at her
 * camp), in world tiles, once the chunks are here. A chunk asks only for
 * its own posts while it attaches.
 */
export function fixedNpcs(key?: string): NpcSpot[] {
  const out: NpcSpot[] = []
  for (const fp of footprints.values())
    for (const [k, list] of fp.objects)
      for (const o of list) if ((!key || key === k) && o.kind === 'npc-post') out.push({ id: o.npc as NpcId, tx: o.tx, ty: o.ty, ...(o.spot ? { spot: o.spot } : {}) })
  return out
}

/** The chunk key a world tile lies in. */
export function chunkOfTile(tx: number, ty: number): string {
  return chunkKey(Math.floor(tx / CHUNK_TILES), Math.floor(ty / CHUNK_TILES))
}

/** Test seam: forget the footprints. */
export function forgetFixed(): void {
  footprints.clear()
  plotBases.clear()
  loading = null
  desiredWorld = ''
}

/** Test seam: a footprint as if its chunks were served. */
export function serveFixed(place: FixedPlace, chunks: readonly WorldChunk[]): FixedFootprint {
  const fp = assembleFootprint(place, chunks)
  if (place.kind === 'plots') plotBases.set(place.id, fp)
  footprints.set(place.id, fp)
  return fp
}


const plotBases = new Map<string, FixedFootprint>()
/** Mutable home state changes collision and standing pieces, never the cached base bytes. */
export function applyLotHome(gate: number, home: HomeView | null): void {
  const id = lotLayout(gate), current = footprints.get(id), base = plotBases.get(id)
  if (!current || !base || gate < 0 || gate > 7) return
  if (home && current.epoch !== `plot:${home.worldId}@${PLOT_REVISION}`) home = null
  const o = lotOrigin(gate), key = `${o.tx / 24},${o.ty / 24}`
  const fp = { ...current, solid: current.solid.map((r, y) => y >= o.ty-current.ty && y < o.ty-current.ty+24 ? [...r] : r), objects: new Map(current.objects) }
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) fp.solid[o.ty - fp.ty + y]![o.tx - fp.tx + x] = base.solid[o.ty - base.ty + y]![o.tx - base.tx + x]!
  const cleared = new Set((home?.cleared ?? []).map(([x,y]) => `${x},${y}`))
  const stumps = new Set((home?.stumps ?? []).map(([x,y]) => `${x},${y}`))
  const stake = `lot:${gate}:stake:${HOMESTEAD_DATA.lotLantern.stakeY}`
  const objects = (base.objects.get(key) ?? []).flatMap((object) => {
    const tile = `${object.tx-o.tx},${object.ty-o.ty}`
    if (object.id.startsWith('land:') && cleared.has(tile)) return []
    if ((object.target === 'tree' || object.target === 'iron-oak') && stumps.has(tile)) return [{ ...object, target: 'stump', label: 'Dig the stump', frame: 'stump-0' }]
    // The lot's lantern: dark, lit or guttering (lot-lantern.ts).
    if (object.id === stake) return [{ ...object, variant: hw2Art(lanternFrame(lanternLook(home?.lantern))) }]
    return [object]
  })
  for (const [x,y] of home?.cleared ?? []) if (insideLot(o.tx+x,o.ty+y,gate) && base.objects.get(key)?.some((p) => p.id === `land:${x},${y}`)) fp.solid[o.ty-fp.ty+y]![o.tx-fp.tx+x] = false
  // Its clearings show on the ground (the other lots' stay as they were).
  const lx0 = o.tx - fp.tx, ly0 = o.ty - fp.ty
  const mine = ([x, y]: readonly [number, number]) => x >= lx0 && x < lx0 + 24 && y >= ly0 && y < ly0 + 24
  fp.cleared = [...(current.cleared ?? []).filter((t) => !mine(t)), ...(home?.cleared ?? []).filter(([x, y]) => insideLot(o.tx+x,o.ty+y,gate)).map(([x, y]) => [lx0 + x, ly0 + y] as const)]
  const decor = (id: string, tx: number, ty: number, frame: string, tint?: number): FixedObject => ({
    id, kind: 'scenery', tx, ty, tw: 0, th: 0, variant: 'tangle-decor', frame,
    festival: '', width: 0, gate, side: '', npc: '', spot: '', target: '', label: '',
    prop: undefined, exit: undefined,
    art: { $typeName: 'glimway.v1.PlacedArt', ox: 8, oy: 16, originLeft: false, depthY: true, flip: false, tile: true, ...(tint === undefined ? {} : { tint }) }
  })
  for (const p of home?.plants ?? []) objects.push(decor(`plant:${p.id}`, o.tx+p.x, o.ty+p.y, p.itemDef === 'turncap-spawn' ? 'turncaps-0' : p.itemDef === 'iron-oak-acorn' ? 'fern-0' : 'flowers-0'))
  if (home?.desolate) for (let x=3;x<=20;x+=2) objects.push(decor(`desolate:${gate}:${x}`, o.tx+x, o.ty+17, 'grass-0', 0xaaa09a))
  fp.objects.set(key, objects)
  // Recompute only when stand recovery/pathfinding actually requests reachability.
  fp.reach = new Uint8Array(0)
  footprints.set(id, fp)
}
