import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/wilds.json' with { type: 'json' };
import wildsRaw from '../content/wilds.json' with { type: 'json' };
import { loadWilds, validateWildsData } from '../src/lib/wilds/data.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';

interface Edit { path: (string | number)[]; value?: unknown; remove?: boolean }
function edited(base: unknown, edits: Edit[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  return value;
}
for (const v of vectors.loader) test(`shared wilds loader: ${v.name}`, () => {
  const value = edited(wildsRaw, v.edits);
  if (v.valid) assert.doesNotThrow(() => validateWildsData(value));
  else assert.throws(() => validateWildsData(value), (e: Error) => refusalMatchesRule(e, v.rule), v.rule);
});

test('the shipped catalogue loads on the client', () => {
  const d = loadWilds();
  assert.equal(d.generatorVersion, 2);
  assert.equal(d.chunkSize, 24);
  assert.deepEqual(d.regions.map((r) => r.id), ['inner-1', 'outer-1']);
  assert.deepEqual(d.campMixes[0]!.enemies, ['wisp']);
  for (const kind of ['camp', 'node', 'chest', 'poi']) {
    assert.ok(d.entityKinds.some((k) => k.kind === kind), `${kind} spawn rule`);
  }
  for (const id of ['camp', 'node:timber', 'chest:1', 'poi']) assert.ok(d.lootTables[id], `loot table ${id}`);
});

test('the vocabularies are narrowed at the loader', () => {
  const d = loadWilds();
  const kinds: ('inner' | 'outer')[] = d.regions.map((r) => r.kind);
  const entityKinds: ('camp' | 'node' | 'chest' | 'poi')[] = d.entityKinds.map((k) => k.kind);
  assert.deepEqual(kinds, ['inner', 'outer']);
  assert.ok(entityKinds.length > 0);
});
