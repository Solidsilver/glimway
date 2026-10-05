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
  /** Set when the exit leads into another region (the Tangle crossing). */
  toRegion?: string;
}

/**
 * Visual dressing for a generated chunk. Blocking pieces (trees, thickets,
 * stumps, logs, boulders, cairns, snags) always stand on solid tiles — the
 * solid grid carries their collision; everything else is walk-through
 * undergrowth or a flat decal on the ground.
 */
export type DecorKind =
  | 'oak'
  | 'pine'
  | 'birch'
  | 'iron-oak'
  | 'snag'
  | 'thicket'
  | 'stump'
  | 'ring-stump'
  | 'log'
  | 'boulder'
  | 'cairn'
  | 'fern'
  | 'grass'
  | 'flowers'
  | 'turncaps'
  | 'reeds'
  | 'roots'
  | 'litter'
  | 'pebbles';

export interface DecorSpot {
  kind: DecorKind;
  /** Anchor tile: the art stands on this tile's bottom edge, centred. */
  tx: number;
  ty: number;
  /** Pixel nudge from that anchor. */
  ox: number;
  oy: number;
  /** Art variant (any non-negative integer; the art seeds from it). */
  variant: number;
  /** Mirror the art (turncaps: lean east instead of west). */
  flip: boolean;
  /** The art overhangs a walkable tile, so it fades when someone walks beneath. */
  overhang: boolean;
}

/**
 * Client-only terrain for one chunk: the WorldData terrain fields (ground,
 * solid, trees, bushes, rocks, exits, spawn) plus its position in the region.
 * Use `toWorldData` (world-data.ts) to adapt it for the game runtime.
 *
 * Generated chunks dress themselves through `decor` (trees included), so
 * `trees`/`bushes`/`rocks` — the curated areas' prop bodies — stay empty and
 * the solid grid carries all collision.
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
  decor: DecorSpot[];
  exits: ChunkExit[];
  spawn: Tile;
  /** Story sites in this chunk (src/lib/wilds/outer.ts): Echo camps, given-back finds. */
  sites: StorySite[];
  /** 'outer': the deep drift's look; `mark` is its season's Mark (null when permanent). */
  look: 'tangle' | 'outer';
  mark: string | null;
}

export type { StorySite } from './outer.ts';
import type { StorySite } from './outer.ts';

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
