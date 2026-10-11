import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/wilds.json' with { type: 'json' };
import wildsRaw from '../content/wilds.json' with { type: 'json' };
import { loadWilds, validateWildsData, wildsV2Regions } from '../src/lib/wilds/data.ts';
import { DECOR_ART, TANGLE_GROUND, isDecorKind, type DecorKind } from '../src/game/wilds/decor.ts';
import { TERRAIN } from '../src/lib/tile.ts';
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
  assert.equal(d.generatorVersion, 3);
  assert.equal(d.chunkSize, 24);
  assert.equal(d.realm, 'hearthwick');
  assert.deepEqual(d.places.map((p) => p.id), ['tangle', 'whitequiet']);
  assert.deepEqual(d.lands.map((l) => l.id), ['woods', 'meadow']);
  assert.deepEqual(d.campMixes[0]!.enemies, ['wisp']);
  for (const kind of ['camp', 'node', 'chest', 'poi']) {
    assert.ok(d.entityKinds.some((k) => k.kind === kind), `${kind} spawn rule`);
  }
  for (const id of ['camp', 'node:timber', 'chest:1', 'poi', 'discovery', 'rumour']) assert.ok(d.lootTables[id], `loot table ${id}`);
  // The rumour's find beats chest:3 on trinkets (open-map.md 2.10).
  assert.ok(d.lootTables.rumour!.trinketChancePermille! > d.trinketChancePermille);
});

test('the vocabularies are narrowed at the loader', () => {
  const d = loadWilds();
  const looks: ('tangle' | 'outer')[] = d.places.map((p) => p.look);
  const epochs: ('still' | 'wick')[] = d.places.map((p) => p.epochKind);
  const entityKinds: ('camp' | 'node' | 'chest' | 'poi')[] = d.entityKinds.map((k) => k.kind);
  assert.deepEqual(looks, ['tangle', 'outer']);
  assert.deepEqual(epochs, ['still', 'wick']);
  assert.ok(entityKinds.length > 0);
});

test('the decor union and the art tables follow content', () => {
  const kinds = loadWilds().decor.map((d) => d.kind);
  // Every content kind is a DecorKind (isDecorKind reads DECOR_ART, built
  // from content), and the union names nothing content lacks.
  const union: DecorKind[] = ['oak', 'pine', 'birch', 'iron-oak', 'snag', 'thicket', 'stump', 'ring-stump', 'log', 'boulder', 'cairn', 'fern', 'grass', 'flowers', 'turncaps', 'reeds', 'roots', 'litter', 'pebbles', 'meadow-grass', 'meadow-flowers', 'meadow-outcrop', 'meadow-oak', 'meadow-stone', 'bank-stones', 'split-oak', 'standing-stone'];
  assert.deepEqual([...kinds].sort(), [...union].sort());
  for (const k of kinds) assert.ok(isDecorKind(k), k);
  assert.deepEqual(DECOR_ART.oak, { w: 30, h: 32, blocking: true, flat: false });
  assert.equal(TANGLE_GROUND.woods, TERRAIN.grass_b);
  assert.equal(TANGLE_GROUND.water, TERRAIN.water_a);
  // Every ground paints with a terrain the ground art knows.
  for (const g of loadWilds().grounds) assert.ok(g.terrain in TERRAIN, g.id);
});

test('the v2 bridge reads the regions off the footprints', () => {
  assert.deepEqual(wildsV2Regions(), [
    { id: 'inner-1', kind: 'inner', gridWidth: 3, gridHeight: 3, entryX: 1, entryY: 1 },
    { id: 'outer-1', kind: 'outer', gridWidth: 3, gridHeight: 3, entryX: 1, entryY: 1 },
  ]);
});
