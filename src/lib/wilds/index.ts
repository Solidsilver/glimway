/**
 * Wilds generator library: pure, deterministic, no rendering.
 *
 * Public API (version-resolved via the registry):
 *   chunkEntities(epoch, cx, cy)      — server-reproducible entities
 *   rollLoot(epoch, entityId, cycle)  — server-reproducible loot
 *   chunkTerrain(epoch, cx, cy)       — client-only terrain (WorldData-shaped)
 *
 * The Go port (server/internal/wilds) reproduces the first two exactly;
 * parity is enforced by content/vectors/wilds.json in both test suites.
 */
export type { ChunkExit, ChunkTerrain, Epoch, LootDrop, Tile, WildsEntity } from './types.ts';
export { Rng, fnv1a32, hash, chunkSeed, lootSeed } from './hash.ts';
export { loadWilds, validateWildsData } from './data.ts';
export { generatorFor } from './registry.ts';
export { buildExits, genV1 } from './gen-v1.ts';
export { toWorldData } from './world-data.ts';

import { generatorFor } from './registry.ts';
import type { ChunkTerrain, Epoch, LootDrop, WildsEntity } from './types.ts';

/** Entity list for a chunk, using the epoch's generator version. */
export function chunkEntities(epoch: Epoch, cx: number, cy: number): WildsEntity[] {
  return generatorFor(epoch.generatorVersion).chunkEntities(epoch, cx, cy);
}

/** Deterministic loot for one claim cycle of one entity. */
export function rollLoot(epoch: Epoch, entityId: string, cycle: number): LootDrop {
  return generatorFor(epoch.generatorVersion).rollLoot(epoch, entityId, cycle);
}

/** Client-only terrain for one chunk. */
export function chunkTerrain(epoch: Epoch, cx: number, cy: number): ChunkTerrain {
  return generatorFor(epoch.generatorVersion).chunkTerrain(epoch, cx, cy);
}
