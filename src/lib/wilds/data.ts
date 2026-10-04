/**
 * Typed loader for content/wilds.json — the canonical shared generator data.
 * The JSON is the single copy: Go reads the same file via content/embed.go.
 */
import wildsJson from '../../../content/wilds.json' with { type: 'json' };
import type {
  WildsData,
  WildsEntityKind,
  WildsEntityKindRule,
  WildsLootEntry,
  WildsRegion,
} from './types.ts';

const ENTITY_KINDS: readonly WildsEntityKind[] = ['camp', 'node', 'chest', 'poi'];

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
}

function isLootEntry(v: unknown): v is WildsLootEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.material === 'string' &&
    e.material.length > 0 &&
    isInt(e.min) &&
    isInt(e.max) &&
    isInt(e.chancePermille) &&
    e.min >= 1 &&
    e.max >= e.min &&
    e.chancePermille > 0 &&
    e.chancePermille <= 1000
  );
}

function isRegion(v: unknown): v is WildsRegion {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    (r.kind === 'inner' || r.kind === 'outer') &&
    isInt(r.gridWidth) &&
    isInt(r.gridHeight) &&
    r.gridWidth > 0 &&
    r.gridHeight > 0 &&
    isInt(r.entryX) &&
    isInt(r.entryY) &&
    r.entryX >= 0 &&
    r.entryX < r.gridWidth &&
    r.entryY >= 0 &&
    r.entryY < r.gridHeight
  );
}

function isKindRule(v: unknown): v is WildsEntityKindRule {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.kind === 'string' &&
    (ENTITY_KINDS as readonly string[]).includes(r.kind) &&
    isInt(r.min) &&
    isInt(r.max) &&
    r.min >= 0 &&
    r.max >= r.min
  );
}

/**
 * Validate the raw shared data. Throws with a precise message on anything the
 * generators cannot rely on; both language test suites run this check.
 */
export function validateWildsData(raw: unknown): WildsData {
  if (typeof raw !== 'object' || raw === null) throw new Error('wilds: data must be an object');
  const d = raw as Record<string, unknown>;
  const keys = Object.keys(d).sort();
  const want = [
    'chunkSize', 'campMixes', 'enemyKinds', 'entityKinds', 'generatorVersion',
    'lootTables', 'materials', 'poiIds', 'regions', 'timers',
    'trinketChancePermille', 'trinkets',
  ].sort();
  if (keys.join(',') !== want.join(',')) throw new Error(`wilds: unexpected keys ${keys.join(',')}`);
  if (!isInt(d.generatorVersion) || d.generatorVersion !== 1) throw new Error('wilds: generatorVersion must be 1');
  if (!isInt(d.chunkSize) || d.chunkSize < 12 || d.chunkSize % 2 !== 0) throw new Error('wilds: chunkSize must be an even integer >= 12');
  if (!Array.isArray(d.regions) || d.regions.length === 0 || !d.regions.every(isRegion)) throw new Error('wilds: bad regions');
  const ids = new Set<string>();
  for (const r of d.regions as WildsRegion[]) {
    if (ids.has(r.id)) throw new Error(`wilds: duplicate region ${r.id}`);
    ids.add(r.id);
  }
  if (!isStringArray(d.enemyKinds)) throw new Error('wilds: bad enemyKinds');
  if (!Array.isArray(d.campMixes) || d.campMixes.length === 0) throw new Error('wilds: bad campMixes');
  for (const mix of d.campMixes as unknown[]) {
    if (!isStringArray(mix) || !(d.enemyKinds as string[]).includes((mix as string[])[0])) {
      throw new Error('wilds: camp mixes must be non-empty lists of known enemy kinds');
    }
    for (const e of mix as string[]) if (!(d.enemyKinds as string[]).includes(e)) throw new Error(`wilds: unknown enemy kind ${e}`);
  }
  if (!isStringArray(d.materials)) throw new Error('wilds: bad materials');
  if (!isStringArray(d.poiIds)) throw new Error('wilds: bad poiIds');
  if (!isStringArray(d.trinkets)) throw new Error('wilds: bad trinkets');
  if (!Array.isArray(d.entityKinds) || d.entityKinds.length === 0 || !d.entityKinds.every(isKindRule)) {
    throw new Error('wilds: bad entityKinds');
  }
  for (const k of d.entityKinds as WildsEntityKindRule[]) {
    if (k.kind === 'camp' && !(d.campMixes as unknown[]).length) throw new Error('wilds: camps need campMixes');
    if (k.kind === 'node' && !(d.materials as string[]).length) throw new Error('wilds: nodes need materials');
    if (k.kind === 'poi' && !(d.poiIds as string[]).length) throw new Error('wilds: pois need poiIds');
  }
  const tables = d.lootTables;
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) throw new Error('wilds: bad lootTables');
  for (const [id, entries] of Object.entries(tables as Record<string, unknown>)) {
    if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isLootEntry)) throw new Error(`wilds: bad loot table ${id}`);
    for (const e of entries as WildsLootEntry[]) {
      if (!(d.materials as string[]).includes(e.material)) throw new Error(`wilds: loot table ${id} pays unknown material ${e.material}`);
    }
  }
  for (const rule of d.entityKinds as WildsEntityKindRule[]) {
    const idsToCheck =
      rule.kind === 'camp' ? ['camp'] :
      rule.kind === 'poi' ? ['poi'] :
      rule.kind === 'chest' ? ['chest:1', 'chest:2', 'chest:3'] :
      (d.materials as string[]).map((m) => `node:${m}`);
    for (const id of idsToCheck) {
      if (!(id in (tables as Record<string, unknown>))) throw new Error(`wilds: missing loot table ${id}`);
    }
  }
  if (!isInt(d.trinketChancePermille) || d.trinketChancePermille < 0 || d.trinketChancePermille > 1000) {
    throw new Error('wilds: bad trinketChancePermille');
  }
  const timers = d.timers;
  if (typeof timers !== 'object' || timers === null) throw new Error('wilds: bad timers');
  const t = timers as Record<string, unknown>;
  if (!isInt(t.campRespawnSeconds) || t.campRespawnSeconds <= 0 || !isInt(t.nodeRegrowSeconds) || t.nodeRegrowSeconds <= 0) {
    throw new Error('wilds: timers must be positive integers (seconds)');
  }
  return d as unknown as WildsData;
}

let cached: WildsData | null = null;

/** Validated shared data, loaded once. */
export function loadWilds(): WildsData {
  if (!cached) cached = validateWildsData(wildsJson);
  return cached;
}
