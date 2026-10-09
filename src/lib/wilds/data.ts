/**
 * Typed loader for content/wilds.json — the canonical shared generator data.
 * The schema and its field rules live in proto/glimway/content/v1/wilds.proto;
 * the generated types are read here (the client reads region sizes, timers
 * and catalogs) and by the server's generator via content/wilds.go.
 */
import raw from '../../../content/wilds.json' with { type: 'json' };
import { decodeContent } from '../content-proto.ts';
import {
  WildsSchema,
  type WildsValid,
} from '../gen/glimway/content/v1/wilds_pb.js';
import type { WildsData, WildsEntityKind, WildsEntityKindRule, WildsRegion } from './types.ts';

/**
 * Validated shared data, with the schema's vocabularies narrowed once here
 * so callers never cast a bare string.
 */
export type Wilds = Omit<WildsValid, 'regions' | 'campMixes' | 'entityKinds'> & {
  regions: WildsRegion[];
  campMixes: WildsValid['campMixes'];
  entityKinds: WildsEntityKindRule[];
};

/**
 * The rules that span entries, the twins of Go's wildsRules: region ids are
 * unique, camp mixes name known enemy kinds, every spawn rule's loot tables
 * exist, and no table pays an unknown material.
 */
function wildsRules(doc: Wilds): void {
  const seen = new Set<string>();
  for (const r of doc.regions) {
    if (seen.has(r.id)) throw new Error(`invalid wilds: duplicate region ${r.id}`);
    seen.add(r.id);
  }
  doc.campMixes.forEach((mix, i) => {
    for (const e of mix.enemies) {
      if (!doc.enemyKinds.includes(e)) throw new Error(`invalid wilds: campMixes[${i}]: unknown enemy kind "${e}"`);
    }
  });
  for (const k of doc.entityKinds) {
    for (const id of lootTableIds(k.kind, doc.materials)) {
      if (!(id in doc.lootTables)) throw new Error(`invalid wilds: missing loot table "${id}"`);
    }
  }
  // Sorted table ids, so the same table is named every run (Go's map
  // iteration isn't; both sides spell the same message).
  for (const id of Object.keys(doc.lootTables).sort()) {
    for (const e of doc.lootTables[id]!.entries) {
      if (!doc.materials.includes(e.material)) throw new Error(`invalid wilds: loot table "${id}": unknown material "${e.material}"`);
    }
  }
}

/** Every loot table a spawn rule of the kind rolls on. */
function lootTableIds(kind: WildsEntityKind, materials: string[]): string[] {
  switch (kind) {
    case 'camp': return ['camp'];
    case 'node': return materials.map((m) => `node:${m}`);
    case 'chest': return ['chest:1', 'chest:2', 'chest:3'];
    default: return ['poi'];
  }
}

/**
 * Validate the raw shared data. Throws with a precise message on anything
 * the generators cannot rely on; both language test suites run this check.
 */
export function validateWildsData(value: unknown): WildsData {
  const doc = decodeContent(WildsSchema, value, 'wilds', ['regions']) as unknown as Wilds;
  wildsRules(doc);
  return doc;
}

let cached: WildsData | null = null;

/** Validated shared data, loaded once. */
export function loadWilds(): WildsData {
  if (!cached) cached = validateWildsData(raw);
  return cached;
}
