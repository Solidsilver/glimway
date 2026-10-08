/**
 * Types of the Wilds' shared data (content/wilds.json), read on both sides:
 * the server's generator (server/internal/wilds) and the client's loader
 * (data.ts). The client never generates the Wilds; it reads served chunks.
 */

export type WildsEntityKind = 'camp' | 'node' | 'chest' | 'poi';

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

interface WildsTimers {
  campRespawnSeconds: number;
  nodeRegrowSeconds: number;
}

export interface WildsData {
  generatorVersion: number;
  chunkSize: number;
  deepTangleManhattanDistance: number;
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
