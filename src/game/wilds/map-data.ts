/**
 * What the Map tab draws (docs/design/open-map.md 2.8), gathered from the
 * open map's store and this device: the chunks you've walked this wick
 * (src/game/wilds/walked.ts) and the Tangle always, each with its ground
 * changes; the glimpse past the frontier; named ways; places, the landmarks
 * you've seen and who found what first; and where you stand.
 *
 * Chunk bodies come from memory, then the device's chunk cache, then the
 * server (they're immutable per epoch). Before the Wilds have been read
 * this session, one near read at the gate names the epochs.
 */
import { MAP_LABELS } from '../../content/open-map.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import type { MapChunk, MapInput, MapPlace } from '../../lib/wilds/map-model.ts'
import type { Session } from '../session.ts'
import { loadChunk } from './chunks.ts'
import { chunkKey, isWildsArea, parseChunkKey } from './coords.ts'
import { effectiveTerrain } from './terrain.ts'
import { chunkEpoch, groundChanges, insideNamedFrontier, knownPlaces, refreshNear, wildsView } from './store.ts'
import { seenAt, seenLandmarks, walkedChunks } from './walked.ts'

/** The chunks the map shows: walked this wick, and the Tangle (it never turns). */
export function mapChunkKeys(walked: readonly string[]): string[] {
  const keys = new Set(walked)
  const tangle = loadWilds().places.find((p) => p.id === 'tangle')
  if (tangle) for (let cy = tangle.cy; cy < tangle.cy + tangle.height; cy++) for (let cx = tangle.cx; cx < tangle.cx + tangle.width; cx++) keys.add(chunkKey(cx, cy))
  return [...keys]
}

/** The Map tab's input, or null when the Wilds can't be read (a guest, or no connection yet). */
export async function mapInput(session: Session): Promise<MapInput | null> {
  const link = session.link
  if (!link) return null
  if (!wildsView() && link.online) await refreshNear(session, 0, 0)
  const view = wildsView()
  if (!view) return null
  const wick = view.wick.id
  const chunks: MapChunk[] = []
  await Promise.all(
    mapChunkKeys(walkedChunks(wick)).map(async (key) => {
      const { cx, cy } = parseChunkKey(key)
      const epoch = chunkEpoch(cx, cy)
      if (!epoch || !insideNamedFrontier(cx, cy)) return
      try {
        const t = effectiveTerrain(await loadChunk(link.api.operations, epoch.id, cx, cy), groundChanges(cx, cy))
        chunks.push({ cx, cy, ground: t.ground, solid: t.solid })
      } catch {
        // A chunk that won't load is left blank on the map.
      }
    })
  )
  const seen = new Set(seenLandmarks(wick))
  const at = seenAt(wick)
  const places = new Map<string, MapPlace>()
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
    const where = await findPlace(session, d.entityId)
    if (where) places.set(d.entityId, { ...where, seen: seen.has(d.entityId), foundBy: d.displayName })
  }
  const st = session.state
  const hero = isWildsArea(st.area) && st.position ? { tx: Math.floor(st.position.x / 16), ty: Math.floor(st.position.y / 16) } : null
  return {
    frontier: view.frontier,
    chunks,
    glimpse: [...view.glimpse].map(([key, g]) => ({ ...parseChunkKey(key), land: g.land, river: g.river })),
    ways: [...view.ways.values()].map((w) => ({ id: w.id, name: w.name, a: w.a, b: w.b, path: w.path.map((t) => ({ x: t.x, y: t.y })) })),
    places: [...places.values()],
    hero,
    words: { you: MAP_LABELS.you, gate: MAP_LABELS.gate },
  }
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

/** Find a place's landmark in its cell's chunks (loaded as the map loads them), or null. */
async function findPlace(session: Session, id: string): Promise<{ id: string; kind: string; tx: number; ty: number } | null> {
  const link = session.link
  if (!link) return null
  for (const { cx, cy } of cellChunks(id)) {
    const epoch = chunkEpoch(cx, cy)
    if (!epoch || !insideNamedFrontier(cx, cy)) continue
    try {
      const t = await loadChunk(link.api.operations, epoch.id, cx, cy)
      const p = t.places.find((x) => x.id === id)
      if (p) return { id, kind: p.kind, tx: cx * t.size + p.tx, ty: cy * t.size + p.ty }
    } catch {
      // Not this one, or not now.
    }
  }
  return null
}
