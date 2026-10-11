/**
 * The open map's ground as the client walks it: each loaded chunk with the
 * near read's player-made changes on top (./terrain.ts effectiveTerrain),
 * looked up by world tile. Past the frontier, or where no chunk is loaded,
 * everything is solid and has no ground. The hero (spawn, footsteps, walk
 * speed), the painter and the window all read it.
 */
import type { GroundChange } from '../../lib/gen/glimway/v1/wilds_pb.js'
import { CHUNK_TILES, chunkKey } from './coords.ts'
import { effectiveTerrain, type ChunkTerrain } from './terrain.ts'
import { chunkTerrain, groundChanges, insideNamedFrontier } from './store.ts'
import { nearestOpen } from './window-plan.ts'
import { TERRAIN, TILE } from '../../lib/tile.ts'
import { loadWilds } from '../../lib/wilds/data.ts'

const cache = new Map<string, { base: ChunkTerrain; changes: readonly GroundChange[]; sig: string; effective: ChunkTerrain }>()

/** The changes' signature: a chunk whose changes moved is repainted. */
export function changesSig(changes: readonly GroundChange[]): string {
  return changes.map((c) => `${c.tx},${c.ty},${c.change}`).sort().join(';')
}

/** A chunk with its changes applied, or null when it isn't loaded (or lies past the frontier). */
export function effectiveChunk(cx: number, cy: number): ChunkTerrain | null {
  if (!insideNamedFrontier(cx, cy)) return null
  const base = chunkTerrain(cx, cy)
  if (!base) return null
  const key = chunkKey(cx, cy)
  const changes = groundChanges(cx, cy)
  const had = cache.get(key)
  if (had && had.base === base && had.changes === changes) return had.effective
  const sig = changesSig(changes)
  const effective = had && had.base === base && had.sig === sig ? had.effective : effectiveTerrain(base, changes)
  cache.set(key, { base, changes, sig, effective })
  return effective
}

/** The changes' signature a chunk was last read with ('' with none). */
export function chunkSig(cx: number, cy: number): string {
  effectiveChunk(cx, cy)
  return cache.get(chunkKey(cx, cy))?.sig ?? ''
}

const split = (t: number) => {
  const c = Math.floor(t / CHUNK_TILES)
  return { c, l: t - c * CHUNK_TILES }
}

/** The ground (a TERRAIN id) at a world tile, or null past the frontier or where nothing is loaded. */
export function groundAt(tx: number, ty: number): number | null {
  const x = split(tx)
  const y = split(ty)
  return effectiveChunk(x.c, y.c)?.ground[y.l]![x.l] ?? null
}

/** Is a world tile solid? (Past the frontier and unloaded tiles are.) */
export function solidAt(tx: number, ty: number): boolean {
  const x = split(tx)
  const y = split(ty)
  const t = effectiveChunk(x.c, y.c)
  return !t || t.solid[y.l]![x.l]!
}

/**
 * Where a hero at world pixel (x, y) can stand: there, if its tile is open;
 * else the middle of the nearest open tile (decision 10). Null when nothing
 * near is open (or loaded).
 */
export function standAt(x: number, y: number): { x: number; y: number } | null {
  const tx = Math.floor(x / TILE)
  const ty = Math.floor(y / TILE)
  if (!solidAt(tx, ty)) return { x, y }
  const t = nearestOpen(tx, ty, (a, b) => !solidAt(a, b))
  return t ? { x: t.tx * TILE + TILE / 2, y: t.ty * TILE + TILE / 2 } : null
}

/** Forget the cache (the turning, a world move). */
export function forgetGround(): void {
  cache.clear()
}

const terrainOfGround = (id: string) => (TERRAIN as Record<string, number>)[loadWilds().grounds.find((g) => g.id === id)?.terrain ?? '']
const WET = new Set([terrainOfGround('water'), terrainOfGround('ford')])

/**
 * What land a world tile is in, for the HUD's place name: by the Wend
 * (water within three tiles), the meadow (its chunk's main land), or null
 * (the woods, or nothing loaded).
 */
export function landName(tx: number, ty: number): 'wend' | 'meadow' | null {
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (WET.has(groundAt(tx + dx, ty + dy) ?? -1)) return 'wend'
  const x = split(tx)
  const y = split(ty)
  return effectiveChunk(x.c, y.c)?.land === 'meadow' ? 'meadow' : null
}
