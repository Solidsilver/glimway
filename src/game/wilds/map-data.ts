/**
 * What the world map draws (docs/design/world-map.md 2, 4; open-map.md 2.8),
 * gathered from the open map's store and this device: the chunks you've walked this wick
 * (src/game/wilds/walked.ts) and the Tangle always, each with its ground
 * changes; the glimpse past the frontier; named ways; places, the landmarks
 * you've seen and who found what first; and where you stand.
 *
 * Chunk bodies come from memory, then the device's chunk cache, then the
 * server (they're immutable per epoch), at most MAP_LOAD_CONCURRENCY at a
 * time. Before the Wilds have been read this session, one near read at the
 * gate names the epochs. Zooming and panning never come here: only new
 * input (a read, a path, a find) does.
 */
import { roomFor } from '../../lib/rooms.ts'
import { homeDoorstep } from '../../lib/lots.ts'
import { MAP_LABELS } from '../../content/open-map.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import type { GroundChange } from '../../lib/gen/glimway/v1/wilds_pb.js'
import type { MapChunk, MapInput, MapPlace } from '../../lib/wilds/map-model.ts'
import type { Session } from '../session.ts'
import { cachedTerrain, loadChunk } from './chunks.ts'
import { chunkKey, chunkOfPixel, isWildsArea, parseChunkKey } from './coords.ts'
import { epochKindAt } from '../../lib/wilds/coords.ts'
import { sourceOf } from '../../lib/location.ts'
import { gameNow } from '../clock.ts'
import { effectiveTerrain, type ChunkTerrain } from './terrain.ts'
import { groundChanges, knownPlaces, placeKey, readRequested, refreshNear, wickEnded, wildsView } from './store.ts'
import { seenAt, seenLandmarks, walkedChunks } from './walked.ts'
import { PLACES } from '../../lib/places.ts'
import { fixedChunkKeys, footprint, prepareFixed } from './fixed.ts'
import { CHUNK_TILES } from './coords.ts'

/** The chunks the map shows: walked this wick, and the Tangle (it never turns). */
export function mapChunkKeys(walked: readonly string[]): string[] {
  const keys = new Set(walked)
  const tangle = loadWilds().places.find((p) => p.id === 'tangle')
  if (tangle) for (let cy = tangle.cy; cy < tangle.cy + tangle.height; cy++) for (let cx = tangle.cx; cx < tangle.cx + tangle.width; cx++) keys.add(chunkKey(cx, cy))
  return [...keys]
}

/** Chunks loaded at once while the map gathers its land. */
export const MAP_LOAD_CONCURRENCY = 8

/** What the world map has to draw, and what it should say about it (docs/design/world-map.md 2). */
export interface MapLoad {
  input: MapInput | null
  /** The world and the epochs the input belongs to: nothing from another is ever shown as current. */
  scope: string
  /** Why there's nothing to draw: a guest (no link), or the Wilds not read this session. */
  missing: 'guest' | 'unread' | null
  /** No connection: the land already read is shown. */
  offline: boolean
  /** Some chunks couldn't be loaded; they're left blank. */
  partial: boolean
  /** The wick ended and no current read came: only the Tangle is shown, and a read is needed. */
  ended: boolean
  /** When this wick ends (Unix seconds, game clock), or null: an open map expires it on time. */
  endsAt: number | null
  /** Another world or wick came while this loaded: nothing here is current, so show none of it. */
  superseded?: boolean
}

/**
 * What the map keeps for one world and its epochs (a scope): the chunks
 * built (the same terrain and ground changes give back the same MapChunk and
 * revision, so the renderer keeps its raster), the last picture of each
 * chunk (one that won't load now keeps it), and places found by someone
 * else. A load holds its own scope's cache, never whichever is current.
 */
interface ScopeCache {
  scope: string
  built: Map<string, { terrain: ChunkTerrain; changes: readonly GroundChange[]; chunk: MapChunk }>
  chunks: Map<string, MapChunk>
  located: Map<string, { id: string; kind: string; tx: number; ty: number }>
}
let current: ScopeCache | null = null
let revs = 0

/** Run `fn` over `items`, at most `limit` at a time. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** The world and epochs the link and the store name now ('' before a read). */
function scopeNow(session: Session): string {
  const view = wildsView()
  return session.link && view ? `${session.link.worldId ?? ''}|${view.still.id}|${view.wick.id}` : ''
}

/**
 * The map's land, or why there isn't any (a guest, or the Wilds not read
 * yet). `read: false` skips the read a stale or ended view would ask for
 * (an open map expiring its wick says so at once, before any answer).
 *
 * Everything the load needs from the store (the epochs, the frontier, when
 * the wick ends) is taken once, before the first wait. After each wait it
 * checks the store still names the same world and epochs; if not (a
 * turning, another world), it stops, touches no cache, and says it was
 * superseded.
 */
export async function loadMap(session: Session, opts: { read?: boolean } = {}): Promise<MapLoad> {
  const link = session.link
  const none = (missing: MapLoad['missing']): MapLoad => ({ input: null, scope: '', missing, offline: !link?.online, partial: false, ended: false, endsAt: null })
  if (!link) return none('guest')
  if (opts.read !== false) await freshen(session)
  const view = wildsView()
  if (!view) return none('unread')
  const scope = scopeNow(session)
  const live = () => scopeNow(session) === scope
  const still = { ...view.still }
  const wickEpoch = { ...view.wick }
  const frontier = { ...view.frontier }
  const cache: ScopeCache = current?.scope === scope ? current : (current = { scope, built: new Map(), chunks: new Map(), located: new Map() })
  // Fixed ground has no generated epoch (its chunks come from ./fixed.ts); a held chunk is its pinned epoch's.
  const held = new Map(view.held)
  const epochOf = (cx: number, cy: number) => {
    if (sourceOf(cx, cy).kind === 'fixed') return null
    const pinned = held.get(chunkKey(cx, cy))
    if (pinned) return pinned
    const e = epochKindAt(cx, cy) === 'still' ? still : wickEpoch
    return e.id ? e : null
  }
  const inside = (cx: number, cy: number) => cx >= frontier.minCx && cx <= frontier.maxCx && cy >= frontier.minCy && cy <= frontier.maxCy
  // A wick that ended with no current read since: its Beyond isn't current any more. Only the Tangle (still) stays.
  const endsAt = wickEpoch.endsAt
  const ended = endsAt !== null && gameNow() >= endsAt
  const wick = wickEpoch.id
  const keys = mapChunkKeys(ended ? [] : walkedChunks(wick))
  const chunks: MapChunk[] = []
  let failed = 0
  let superseded = false
  await eachLimit(keys, MAP_LOAD_CONCURRENCY, async (key) => {
    if (superseded || !live()) return void (superseded = true)
    const { cx, cy } = parseChunkKey(key)
    const epoch = epochOf(cx, cy)
    if (!epoch || !inside(cx, cy)) return
    if (ended && epoch.kind !== 'still') return
    let terrain: ChunkTerrain
    try {
      terrain = cachedTerrain(epoch.id, cx, cy) ?? (await loadChunk(link.api.operations, epoch.id, cx, cy))
    } catch {
      if (!live()) return void (superseded = true)
      // A chunk that won't load keeps its last picture this wick, else it's blank.
      const had = cache.chunks.get(key)
      if (had) chunks.push(had)
      else failed++
      return
    }
    // The store may have moved on while the chunk came: its ground changes would be another epoch's.
    if (!live()) return void (superseded = true)
    const changes = groundChanges(cx, cy)
    const id = `${epoch.id}:${key}`
    let b = cache.built.get(id)
    if (!b || b.terrain !== terrain || b.changes !== changes) {
      const t = effectiveTerrain(terrain, changes)
      b = { terrain, changes, chunk: { cx, cy, ground: t.ground, solid: t.solid, rev: `${id}:${++revs}` } }
      cache.built.set(id, b)
    }
    chunks.push(b.chunk)
    cache.chunks.set(key, b.chunk)
  })
  const places = new Map<string, MapPlace>()
  const glimpse: MapInput['glimpse'][number][] = []
  const ways: MapInput['ways'][number][] = []
  if (!ended && !superseded && live()) {
    const v = wildsView()!
    const seen = new Set(seenLandmarks(wick))
    const at = seenAt(wick)
    const foundBy = (id: string) => v.discoveries.get(id)?.displayName ?? null
    for (const p of knownPlaces()) places.set(p.id, { ...p, seen: seen.has(p.id), foundBy: foundBy(p.id) })
    for (const id of seen) {
      const t = at[id]
      if (places.has(id) || !t) continue
      places.set(id, { id, kind: v.discoveries.get(id)?.poiId ?? '', tx: t[0], ty: t[1], seen: true, foundBy: foundBy(id) })
    }
    // Places someone found that you haven't been near: their cell's chunks say where (everyone's map names the finder).
    for (const d of [...v.discoveries.values()]) {
      if (places.has(d.entityId)) continue
      const where = await findPlace(session, cache, epochOf, inside, live, d.entityId)
      if (!live()) {
        superseded = true
        break
      }
      if (where) places.set(d.entityId, { ...where, seen: seen.has(d.entityId), foundBy: d.displayName })
    }
    for (const [key, g] of v.glimpse) glimpse.push({ ...parseChunkKey(key), land: g.land, river: g.river })
    for (const w of v.ways.values()) ways.push({ id: w.id, name: w.name, a: w.a, b: w.b, path: w.path.map((t) => ({ x: t.x, y: t.y })) })
  }
  // The fixed footprints (the Commons), always: their own chunks, whatever the world or wick.
  await prepareFixed(session)
  if (!live()) superseded = true
  const fixed = fixedMapChunks()
  if (superseded || !live()) return { ...none(null), scope, superseded: true }
  const st = session.state
  const hero = mapHeroTile(st.area, st.position)
  return {
    input: { frontier, chunks, fixed, glimpse, ways, places: [...places.values()], hero, words: { you: MAP_LABELS.you, gate: MAP_LABELS.gate } },
    scope,
    missing: null,
    offline: !link.online,
    partial: failed > 0,
    ended,
    endsAt
  }
}

/** Each fixed footprint's chunks as the map draws them, made once a footprint (the same objects every load). */
const fixedPictures = new WeakMap<object, MapChunk[]>()
function fixedMapChunks(): MapChunk[] {
  const out: MapChunk[] = []
  for (const p of PLACES.fixed) {
    const fp = footprint(p.id)
    if (!fp) continue
    let list = fixedPictures.get(fp)
    if (!list) {
      list = fixedChunkKeys(p).map(({ cx, cy }) => {
        const lx = cx * CHUNK_TILES - fp.tx
        const ly = cy * CHUNK_TILES - fp.ty
        const rows = <T,>(grid: readonly (readonly T[])[]) => grid.slice(ly, ly + CHUNK_TILES).map((r) => r.slice(lx, lx + CHUNK_TILES))
        return { cx, cy, ground: rows(fp.ground), solid: rows(fp.solid), rev: `${fp.epoch}:${cx},${cy}` }
      })
      fixedPictures.set(fp, list)
    }
    out.push(...list)
  }
  return out
}

/** Test seam: forget the map's caches (every scope's). */
export function forgetMapData(): void {
  current = null
}

/** When the map last read the Wilds itself (ms): at most one read in MAP_READ_EVERY_MS, however often it asks. */
let mapReadAt = -Infinity
export const MAP_READ_EVERY_MS = 10_000

/**
 * The map draws one wick: before drawing, read the Wilds again when they've
 * never been read, the view is stale, its wick has ended by the clock, or
 * the store asked for a read. Around the hero on the open map, else at the
 * gate. Coalesced: the read's own news (EV.wilds) redraws the map, which
 * must not read again.
 */
async function freshen(session: Session, now = Date.now()): Promise<void> {
  const link = session.link
  const view = wildsView()
  const due = !view || view.stale || wickEnded() || readRequested()
  if (!link || !due || !link.online || now - mapReadAt < MAP_READ_EVERY_MS) return
  mapReadAt = now
  const st = session.state
  const at = isWildsArea(st.area) && st.position ? chunkOfPixel(st.position.x, st.position.y) : { cx: 0, cy: 0 }
  await refreshNear(session, at.cx, at.cy)
}

/** Test seam: the Map may read again at once. */
export function forgetMapRead(): void {
  mapReadAt = -Infinity
}

/** The chunks of a place's cell (`place:<cellX>:<cellY>`, content `cells`), or none for anything else. */
export function cellChunks(placeId: string): { cx: number; cy: number }[] {
  const m = /^place:(-?\d+):(-?\d+)$/.exec(placeId)
  if (!m) return []
  const c = loadWilds().cells
  const x0 = c.originCx + Number(m[1]) * c.cellChunks
  const y0 = c.originCy + Number(m[2]) * c.cellChunks
  const out: { cx: number; cy: number }[] = []
  for (let dy = 0; dy < c.cellChunks; dy++) for (let dx = 0; dx < c.cellChunks; dx++) out.push({ cx: x0 + dx, cy: y0 + dy })
  return out
}

/** Find a place's landmark in its cell's chunks (loaded as the map loads them), or null; found ones are kept in the load's own scope. */
async function findPlace(
  session: Session,
  cache: ScopeCache,
  epochOf: (cx: number, cy: number) => { id: string } | null,
  inside: (cx: number, cy: number) => boolean,
  live: () => boolean,
  id: string
): Promise<{ id: string; kind: string; tx: number; ty: number } | null> {
  const had = cache.located.get(id)
  if (had) return had
  const link = session.link
  if (!link) return null
  // A held chunk's place is keyed `<id>@<epoch>` (placeKey): its cell's chunks, in that epoch.
  const raw = id.split('@')[0]!
  for (const { cx, cy } of cellChunks(raw)) {
    const epoch = epochOf(cx, cy)
    if (!epoch || !inside(cx, cy)) continue
    try {
      const t = cachedTerrain(epoch.id, cx, cy) ?? (await loadChunk(link.api.operations, epoch.id, cx, cy))
      if (!live()) return null
      const p = t.places.find((x) => x.id === raw && placeKey(x.id, epoch.id) === id)
      if (p) {
        const where = { id, kind: p.kind, tx: cx * t.size + p.tx, ty: cy * t.size + p.ty }
        cache.located.set(id, where)
        return where
      }
    } catch {
      // Not this one, or not now.
    }
  }
  return null
}

/** Rooms retain local pixels; the outdoor map marks their exterior doorway. */
export function mapHeroTile(area: string, position?: { x: number; y: number }): { tx: number; ty: number } | null {
 if (isWildsArea(area)) return position ? { tx: Math.floor(position.x / 16), ty: Math.floor(position.y / 16) } : null
 const home = /^in:home:([0-7])$/.exec(area)
 if (home) return homeDoorstep(Number(home[1]))
 const queue = [area], seen = new Set<string>()
 while (queue.length) {
  const id = queue.shift()!
  if (seen.has(id)) continue
  seen.add(id)
  for (const door of roomFor(id)?.doors ?? []) {
   if (door.outside && door.to === 'hearthwick') return { tx: door.outside.tx, ty: door.outside.ty }
   if (door.to.startsWith('in:')) queue.push(door.to)
  }
 }
 return null
}
