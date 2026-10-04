/**
 * Shared types for the Wilds generator library.
 *
 * The generator API is three functions per generator version:
 *
 *   chunkEntities(epoch, cx, cy)  — server-reproducible entity list
 *   rollLoot(epoch, entityId, cycle) — server-reproducible loot
 *   chunkTerrain(epoch, cx, cy)   — client-only terrain (WorldData-shaped)
 *
 * `epoch` is the region's frozen (worldSeed, regionId, generatorVersion,
 * season) tuple; every output is a pure function of epoch + arguments and the
 * shared data in content/wilds.json.
 */

/** Frozen generation parameters for a region (see expansion-design.md §3). */
export interface Epoch {
  worldSeed: string;
  regionId: string;
  generatorVersion: number;
  season: string;
}

export type WildsEntityKind = 'camp' | 'node' | 'chest' | 'poi';

export interface Tile {
  tx: number;
  ty: number;
}

/**
 * One generated entity. Stable id is `<kind>:<cx>:<cy>:<index>` (index counts
 * within the kind). Kind data uses flat fields so the Go port matches on JSON:
 * `enemies` for camps, `material` for nodes, `tier` for chests, `poi` for
 * points of interest; unused fields are empty/zero.
 */
export interface WildsEntity {
  id: string;
  kind: WildsEntityKind;
  tx: number;
  ty: number;
  enemies: string[];
  material: string;
  tier: number;
  poi: string;
}

export interface MaterialQty {
  id: string;
  qty: number;
}

/** Deterministic loot for one claim cycle of one entity. */
export interface LootDrop {
  materials: MaterialQty[];
  /** Ember-free trinket id, or null. */
  trinket: string | null;
}

export type ExitDir = 'north' | 'east' | 'south' | 'west';

/** Destination chunk of a chunk-to-chunk exit (chunk coordinates). */
export interface ChunkCoord {
  cx: number;
  cy: number;
}

/**
 * A chunk exit. `to` is `commons` for the region entry's way home, otherwise
 * `chunk:<regionId>:<cx>:<cy>`. `entry` is the tile to arrive on in the
 * destination (for the commons exit: where stepping back in lands). The shape
 * matches WorldData's ExitDef apart from the widened `to` target id.
 */
export interface ChunkExit {
  tx: number;
  ty: number;
  tw: number;
  th: number;
  to: string;
  entry: Tile;
  dir: ExitDir;
  toChunk: ChunkCoord | null;
}

/**
 * Client-only terrain for one chunk: the WorldData terrain fields (ground,
 * solid, trees, bushes, rocks, exits, spawn) plus its position in the region.
 * Use `toWorldData` (world-data.ts) to adapt it for the game runtime.
 */
export interface ChunkTerrain {
  regionId: string;
  cx: number;
  cy: number;
  width: number;
  height: number;
  widthPx: number;
  heightPx: number;
  ground: number[][];
  solid: boolean[][];
  trees: Tile[];
  bushes: Tile[];
  rocks: Tile[];
  exits: ChunkExit[];
  spawn: Tile;
}

/** The public API of one generator version. */
export interface WildsGenerator {
  version: number;
  chunkEntities(epoch: Epoch, cx: number, cy: number): WildsEntity[];
  rollLoot(epoch: Epoch, entityId: string, cycle: number): LootDrop;
  chunkTerrain(epoch: Epoch, cx: number, cy: number): ChunkTerrain;
}

// ------------------------------------------------------------- shared data

export interface WildsRegion {
  id: string;
  kind: 'inner' | 'outer';
  gridWidth: number;
  gridHeight: number;
  entryX: number;
  entryY: number;
}

export interface WildsEntityKindRule {
  kind: WildsEntityKind;
  min: number;
  max: number;
}

export interface WildsLootEntry {
  material: string;
  min: number;
  max: number;
  chancePermille: number;
}

export interface WildsTimers {
  campRespawnSeconds: number;
  nodeRegrowSeconds: number;
}

export interface WildsData {
  generatorVersion: number;
  chunkSize: number;
  regions: WildsRegion[];
  enemyKinds: string[];
  campMixes: string[][];
  materials: string[];
  poiIds: string[];
  trinkets: string[];
  entityKinds: WildsEntityKindRule[];
  lootTables: Record<string, WildsLootEntry[]>;
  trinketChancePermille: number;
  timers: WildsTimers;
}
