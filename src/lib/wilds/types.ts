/**
 * Types of the Wilds' shared data (content/wilds.json), read on both sides:
 * the server's generator (server/internal/wilds) and the client's loader
 * (data.ts). The client never generates the Wilds; it reads served chunks.
 * The generated messages (proto/glimway/content/v1/wilds.proto) carry the
 * schema; these are the narrowed views the loaders export.
 */

import type { WildsRegionValid, WildsEntityKindRuleValid } from '../gen/glimway/content/v1/wilds_pb.js';

export type WildsEntityKind = 'camp' | 'node' | 'chest' | 'poi';

// ------------------------------------------------------------- shared data

export type WildsRegion = Omit<WildsRegionValid, 'kind'> & { kind: 'inner' | 'outer' };
export type WildsEntityKindRule = Omit<WildsEntityKindRuleValid, 'kind'> & { kind: WildsEntityKind };

export interface WildsTimers {
  campRespawnSeconds: number;
  nodeRegrowSeconds: number;
}

export interface WildsData {
  generatorVersion: number;
  chunkSize: number;
  deepTangleManhattanDistance: number;
  regions: WildsRegion[];
  enemyKinds: string[];
  campMixes: { enemies: string[] }[];
  materials: string[];
  poiIds: string[];
  trinkets: string[];
  entityKinds: WildsEntityKindRule[];
  lootTables: Record<string, { entries: WildsLootEntry[] }>;
  trinketChancePermille: number;
  timers: WildsTimers;
}

export interface WildsLootEntry {
  material: string;
  min: number;
  max: number;
  chancePermille: number;
}
