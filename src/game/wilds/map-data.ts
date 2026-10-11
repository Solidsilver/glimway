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
import { MAP_LABELS } from '../../content/open-map.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import type { GroundChange } from '../../lib/gen/glimway/v1/wilds_pb.js'
import type { MapChunk, MapInput, MapPlace } from '../../lib/wilds/map-model.ts'
import type { Session } from '../session.ts'
import { cachedTerrain, loadChunk } from './chunks.ts'
import { chunkKey, chunkOfPixel, isWildsArea, parseChunkKey } from './coords.ts'
import { effectiveTerrain, type ChunkTerrain } from './terrain.ts'
import { chunkEpoch, groundChanges, insideNamedFrontier, knownPlaces, readRequested, refreshNear, wickEnded, wildsView } from './store.ts'
import { seenAt, seenLandmarks, walkedChunks } from './walked.ts'

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
}

/**
 * Chunks built for the map, by epoch and chunk: the same terrain and the
 * same ground changes give back the same MapChunk (and revision), so the
 * renderer keeps its raster.
 */
const built = new Map<string, { terrain: ChunkTerrain; changes: readonly GroundChange[]; chunk: MapChunk }>()
let revs = 0
/** Places found by someone else, located once per world, wick and place. */
const located = new Map<string, { id: string; kind: string; tx: number; ty: number }>()
/** The last map shown, for its world and epochs: a chunk that won't load now keeps its last picture. */
let snapshot: { scope: string; chunks: Map<string, MapChunk> } | null = null

/** Run `fn` over `items`, at most `limit` at a time. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** The map's land, or why there isn't any (a guest, or the Wilds not read yet). */
export async function loadMap(session: Session): Promise<MapLoad> {
  const link = session.link
  const none = (missing: MapLoad['missing']): MapLoad => ({ input: null, scope: '', missing, offline: !link?.online, partial: false, ended: false })
  if (!link) return none('guest')
  await freshen(session)
  const view = wildsView()
  if (!view) return none('unread')
  const world = link.worldId ?? ''
  const scope = `${world}|${view.still.id}|${view.wick.id}`
  if (snapshot?.scope !== scope) {
    snapshot = { scope, chunks: new Map() }
    built.clear()
  }
  // A wick that ended with no current read since: its Beyond isn't current any more. Only the Tangle (still) stays.
  const ended = wickEnded()
  const wick = view.wick.id
  const keys = mapChunkKeys(ended ? [] : walkedChunks(wick))
  const chunks: MapChunk[] = []
  let failed = 0
  await eachLimit(keys, MAP_LOAD_CONCURRENCY, async (key) => {
    const { cx, cy } = parseChunkKey(key)
    const epoch = chunkEpoch(cx, cy)
    if (!epoch || !insideNamedFrontier(cx, cy)) return
    if (ended && epoch.kind !== 'still') return
    try {
      const terrain = cachedTerrain(epoch.id, cx, cy) ?? (await loadChunk(link.api.operations, epoch.id, cx, cy))
      const changes = groundChanges(cx, cy)
      const id = `${epoch.id}:${key}`
      let b = built.get(id)
      if (!b || b.terrain !== terrain || b.changes !== changes) {
        const t = effectiveTerrain(terrain, changes)
        b = { terrain, changes, chunk: { cx, cy, ground: t.ground, solid: t.solid, rev: `${id}:${++revs}` } }
        built.set(id, b)
      }
      chunks.push(b.chunk)
      snapshot!.chunks.set(key, b.chunk)
    } catch {
      // A chunk that won't load keeps its last picture this wick, else it's blank.
      const had = snapshot!.chunks.get(key)
      if (had) chunks.push(had)
      else failed++
    }
  })
  const places = new Map<string, MapPlace>()
  const glimpse: MapInput['glimpse'][number][] = []
  const ways: MapInput['ways'][number][] = []
  if (!ended) {
    const seen = new Set(seenLandmarks(wick))
    const at = seenAt(wick)
    const foundBy = (id: string) => view.discoveries.get(id)?.displayName ?? null
    for (const p of knownPlaces()) places.set(p.id, { ...p, seen: seen.has(p.id), foundBy: foundBy(p.id) })
    for (const id of seen) {
      const t = at[id]
      if (places.has(id) || !t) continue
      places.set(id, { id, kind: view.discoveries.get(id)?.poiId ?? '', tx: t[0], ty: t[1], seen: true, foundBy: foundBy(id) })
    }
    // Places someone found that you haven't been near: their cell's chunks say where (everyone's map names the finder).
    for (const d of view.discoveries.values()) {
      if (places.has(d.entityId)) continue
      const where = await findPlace(session, `${scope}|${d.entityId}`, d.entityId)
      if (where) places.set(d.entityId, { ...where, seen: seen.has(d.entityId), foundBy: d.displayName })
    }
    for (const [key, g] of view.glimpse) glimpse.push({ ...parseChunkKey(key), land: g.land, river: g.river })
    for (const w of view.ways.values()) ways.push({ id: w.id, name: w.name, a: w.a, b: w.b, path: w.path.map((t) => ({ x: t.x, y: t.y })) })
  }
  const st = session.state
  const hero = isWildsArea(st.area) && st.position ? { tx: Math.floor(st.position.x / 16), ty: Math.floor(st.position.y / 16) } : null
  return {
    input: { frontier: view.frontier, chunks, glimpse, ways, places: [...places.values()], hero, words: { you: MAP_LABELS.you, gate: MAP_LABELS.gate } },
    scope,
    missing: null,
    offline: !link.online,
    partial: failed > 0,
    ended
  }
}

/** Test seam: forget the map's built chunks, located places and snapshot. */
export function forgetMapData(): void {
  built.clear()
  located.clear()
  snapshot = null
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

/** Find a place's landmark in its cell's chunks (loaded as the map loads them), or null; found ones are kept under `cacheKey`. */
async function findPlace(session: Session, cacheKey: string, id: string): Promise<{ id: string; kind: string; tx: number; ty: number } | null> {
  const had = located.get(cacheKey)
  if (had) return had
  const link = session.link
  if (!link) return null
  for (const { cx, cy } of cellChunks(id)) {
    const epoch = chunkEpoch(cx, cy)
    if (!epoch || !insideNamedFrontier(cx, cy)) continue
    try {
      const t = cachedTerrain(epoch.id, cx, cy) ?? (await loadChunk(link.api.operations, epoch.id, cx, cy))
      const p = t.places.find((x) => x.id === id)
      if (p) {
        const where = { id, kind: p.kind, tx: cx * t.size + p.tx, ty: cy * t.size + p.ty }
        located.set(cacheKey, where)
        return where
      }
    } catch {
      // Not this one, or not now.
    }
  }
  return null
}
