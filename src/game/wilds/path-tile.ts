/**
 * One world tile of the open map as the path rules read it (src/lib/wilds/
 * paths.ts): the generated land under it (its surface, whether it's solid,
 * the decor anchored there, a site, entity or landmark standing on it) and
 * the change on it now, the player's own unanswered ones included.
 */
import { TERRAIN, tileKey } from '../../lib/tile.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { chunkOf, localOf } from '../../lib/wilds/coords.ts'
import type { PathTile } from '../../lib/wilds/paths.ts'
import type { WildsSurface } from '../../lib/wilds/types.ts'
import { chunkTerrain, groundChanges, insideNamedFrontier } from './store.ts'
import type { ChunkTerrain } from './terrain.ts'

/** The ground's surface by terrain id (content `grounds`). */
const SURFACE = new Map<number, WildsSurface>(loadWilds().grounds.map((g) => [(TERRAIN as Record<string, number>)[g.terrain]!, g.surface]))

const NONE: readonly string[] = []
/** A chunk's decor kinds and occupied tiles by local tile, made once per chunk body (the rules read them every frame). */
const index = new WeakMap<ChunkTerrain, { decor: Map<string, string[]>; occupied: Set<string> }>()
function indexOf(t: ChunkTerrain): { decor: Map<string, string[]>; occupied: Set<string> } {
  let ix = index.get(t)
  if (ix) return ix
  ix = { decor: new Map(), occupied: new Set() }
  for (const d of t.decor) {
    const k = tileKey(d.tx, d.ty)
    const list = ix.decor.get(k)
    if (list) list.push(d.kind)
    else ix.decor.set(k, [d.kind])
  }
  for (const p of [...t.sites, ...t.entities, ...t.places]) ix.occupied.add(tileKey(p.tx, p.ty))
  index.set(t, ix)
  return ix
}

/** One world tile as the path rules read it (null where its chunk isn't loaded or lies past the frontier). */
export function pathTileAt(tx: number, ty: number): PathTile | null {
  const { cx, cy } = chunkOf(tx, ty)
  if (!insideNamedFrontier(cx, cy)) return null
  const t = chunkTerrain(cx, cy)
  if (!t) return null
  const { lx, ly } = localOf(tx, ty)
  const changes = groundChanges(cx, cy)
  const c = changes.find((g) => g.tx === lx && g.ty === ly) ?? null
  const ix = indexOf(t)
  const k = tileKey(lx, ly)
  return {
    surface: SURFACE.get(t.ground[ly]![lx]!) ?? null,
    baseSolid: t.solid[ly]![lx]!,
    decor: ix.decor.get(k) ?? NONE,
    occupied: ix.occupied.has(k),
    change: c ? { change: c.change, by: c.by } : null,
    changes: changes.length,
  }
}

