import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/furnishings.json' with { type: 'json' };
import furnishingRaw from '../content/furnishings.json' with { type: 'json' };
import { FURNISHINGS, validateFurnishings, furnishingFor, canPlace, type Furnishing, type PlaceOn } from '../src/lib/furnishings.ts';
import { HOMESTEAD_DATA, validateHomesteadData, homeItem } from '../src/lib/homestead.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';

interface Edit { path: (string | number)[]; value?: unknown; remove?: boolean }
function edited(base: unknown, edits: Edit[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  return value;
}
for (const v of vectors.loader) test(`shared furnishings loader: ${v.name}`, () => {
  const value = edited(furnishingRaw, v.edits);
  if (v.valid) assert.doesNotThrow(() => validateFurnishings(value));
  else assert.throws(() => validateFurnishings(value), (e: Error) => refusalMatchesRule(e, v.rule), v.rule);
});

test('the shipped catalogue keeps every home good and the interior kit', () => {
  // 32 home goods, the 14-piece kit, the village rooms' 15 signature pieces and round 2b's 16 kit and wall pieces (lane B).
  assert.equal(FURNISHINGS.pieces.length, 77);
  for (const sig of ['kitchen-hearth', 'kitchen-worktable', 'millstones', 'mill-gears', 'mill-hoist', 'library-shelves', 'library-side-shelves', 'reading-table', 'reading-nook', 'elara-desk']) assert.ok(furnishingFor(sig), `signature piece ${sig}`);
  for (const good of HOMESTEAD_DATA.items) assert.ok(furnishingFor(good.id), `${good.id} left the catalogue`);
  for (const kit of ['rag-rug', 'wall-shelves', 'wall-peg', 'wall-tools', 'crate', 'barrel', 'sack', 'candle', 'picture', 'calendar', 'curtains', 'counter', 'small-table', 'chest']) assert.ok(furnishingFor(kit), `interior kit lost ${kit}`);
  // Art frame names may be empty until the art lands; a rug may omit its size.
  assert.equal(furnishingFor('chest')!.facings.front, '');
  assert.equal(furnishingFor('rag-rug')!.size, undefined);
});

for (const v of vectors.placements) test(`shared canPlace: ${v.name}`, () => {
  const pieces = vectors.pieces as Record<string, Furnishing>;
  const piece = pieces[v.piece]!;
  const raw = v.onto as { kind: string; host?: string; offer?: 'top' | 'shelves' };
  const onto: PlaceOn = raw.kind === 'surface' ? { kind: 'surface', host: pieces[raw.host!]!, offer: raw.offer! } : { kind: raw.kind as 'floor' | 'wall' | 'rug' };
  assert.equal(canPlace(piece, onto, v.at), v.ok, v.name);
});

// Homestead rows only refer to the catalogue by id; the loader fills in each
// row's name and footprint and refuses unknown ids.
test('homestead reads its items through the catalogue', () => {
  const stool = furnishingFor('wooden-stool')!;
  assert.deepEqual([HOMESTEAD_DATA.items[0]!.id, HOMESTEAD_DATA.items[0]!.name, HOMESTEAD_DATA.items[0]!.footprint], ['wooden-stool', stool.name, stool.footprint]);
  assert.equal(homeItem('wooden-stool')!.name, 'Wooden Stool');
  for (const good of HOMESTEAD_DATA.items) assert.ok(furnishingFor(good.id), `${good.id} unresolved`);
  const broken: unknown = { ...structuredClone(HOMESTEAD_DATA), items: [{ ...structuredClone(HOMESTEAD_DATA.items[0]), id: 'no-such-piece' }] };
  assert.throws(() => validateHomesteadData(broken));
  const renamed = structuredClone(HOMESTEAD_DATA);
  (renamed.items[0] as { name: string }).name = 'Wrong Name';
  assert.throws(() => validateHomesteadData(renamed));
  const stale = structuredClone(HOMESTEAD_DATA);
  (stale.items[0] as { footprint: number[] }).footprint = [9, 9];
  assert.throws(() => validateHomesteadData(stale));
  const malformed = structuredClone(HOMESTEAD_DATA);
  malformed.items[0]!.footprint = [1, 1, 1] as unknown as [number, number];
  assert.throws(() => validateHomesteadData(malformed));
});
