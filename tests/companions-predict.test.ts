import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { JsonValue } from '@bufbuild/protobuf';
import { decodeWire } from '../src/lib/api/wire.ts';
import { projectHome } from '../src/lib/api/homestead.ts';
import { predictCompanions, predictStableExtend, predictStall } from '../src/lib/api/predict.ts';
import { HomeViewSchema } from '../src/lib/gen/glimway/v1/goods_pb.js';
import { PlayerStateSchema } from '../src/lib/gen/glimway/v1/state_pb.js';
import { HOMESTEAD_DATA, checkPlacement, stableFootprint, stallGroundProblem } from '../src/lib/homestead.ts';
import { stableFootprint as layoutFootprint } from '../src/lib/stable-layout.ts';

const fixtures = new Map(
  (JSON.parse(readFileSync(new URL('../content/vectors/crafts-fixtures.json', import.meta.url), 'utf8')) as { messages: { name: string; json: JsonValue }[] }).messages.map((m) => [m.name, m.json]),
);
const home = () => projectHome(decodeWire(HomeViewSchema, fixtures.get('home-view')!));
const tam = { id: 'fixture-account', name: 'Tam' };

test('homestead view: stalls, yard pets and the stable\'s stall count come through', () => {
  const h = home();
  assert.deepEqual(h.stalls.map((s) => [s.stall, s.mount, s.out]), [[1, 'Wolf-Shade', true], [2, '', false]]);
  assert.ok(h.yardPets.length > 0);
  assert.equal(h.items.find((i) => i.itemDef === 'stable')?.stalls, 2);
  assert.equal('stalls' in h.items.find((i) => i.itemDef === 'wooden-stool')!, false);
});

test('companions view: the server\'s, with unanswered choices on top in order', () => {
  const server = decodeWire(PlayerStateSchema, fixtures.get('player-state')!);
  const base = predictCompanions(server, []);
  assert.deepEqual(base, { followPet: server.companions?.followPet ?? '', yardPets: server.companions?.yardPets ?? [], mountOut: server.companions?.mountOut ?? '', mountHome: server.companions?.mountHome ?? '' });
  const chosen = predictCompanions(server, [{ kind: 'companions', followPet: 'Fox-Golden', yardPets: ['Cat-Siamese'] }, { kind: 'mount-home' }]);
  assert.equal(chosen.followPet, 'Fox-Golden');
  assert.deepEqual(chosen.yardPets, ['Cat-Siamese']);
  assert.equal(chosen.mountOut, '');
  assert.deepEqual(predictCompanions(null, []), { followPet: '', yardPets: [], mountOut: '', mountHome: '' });
});

test('stall prediction: the mount moves rather than stands twice; a partner\'s stall is left alone', () => {
  const moved = predictStall(home(), 2, 'Wolf-Shade', tam);
  assert.deepEqual(moved.stalls.map((s) => [s.stall, s.mount, s.ownerId]), [[1, '', ''], [2, 'Wolf-Shade', 'fixture-account']]);
  const emptied = predictStall(home(), 1, '', tam);
  assert.equal(emptied.stalls[0].mount, '');
  const theirs = predictStall(home(), 1, 'Lion-Golden', { id: 'partner', name: 'Ivy' });
  assert.deepEqual(theirs.stalls, home().stalls);
});

test('stable-extend prediction: one more bay, empty, up to six', () => {
  const grown = predictStableExtend(home(), 'stable', 6);
  assert.equal(grown.items.find((i) => i.itemDef === 'stable')?.stalls, 3);
  assert.deepEqual(grown.stalls.at(-1), { stall: 3, mount: '', ownerId: '', ownerName: '', out: false });
  let h = home();
  for (let i = 0; i < 10; i++) h = predictStableExtend(h, 'stable', 6);
  assert.equal(h.items.find((i) => i.itemDef === 'stable')?.stalls, 6);
  assert.equal(h.stalls.length, 6);
});

test('the stable grows east 2 tiles a stall, faces front only, and its footprint is checked grown', () => {
  for (let n = 1; n <= 6; n++) assert.deepEqual(stableFootprint(n), layoutFootprint(n));
  assert.deepEqual(stableFootprint(6), [14, 3]);
  const empty = { tier: 2, items: [] };
  const stable = { id: 's', itemDef: 'stable', scene: null, x: null, y: null, rotation: null, stalls: 3 };
  assert.equal(checkPlacement(empty, stable, 'outdoor', 0, 0, 90, HOMESTEAD_DATA), 'invalid-placement');
  // Next to a placed 3-stall stable (8 wide at x 2), x 9 overlaps and x 10 doesn't (grid rules only).
  const placed = { tier: 2, items: [{ ...stable, id: 'placed', scene: 'outdoor' as const, x: 2, y: 2, rotation: 0 as const }] };
  const stool = { id: 'w', itemDef: 'wooden-stool', scene: null, x: null, y: null, rotation: null };
  const where = HOMESTEAD_DATA.items.find((i) => i.id === 'wooden-stool')!.where;
  if (where.includes('outdoor')) {
    assert.equal(checkPlacement(placed, stool, 'outdoor', 9, 3, 0, HOMESTEAD_DATA) === 'placement-overlap', true);
  }
});

test('a new stall asks only for the 2 × 3 tiles east of the stable', () => {
  const stable = { id: 's', itemDef: 'stable', scene: 'outdoor' as const, x: 0, y: 0, rotation: 0 as const, stalls: 2 };
  // Find a spot where the east bay fits on the grid and in the light.
  let at: { x: number; y: number } | null = null;
  for (let y = 0; y < 40 && !at; y++) for (let x = 0; x < 40 && !at; x++) if (stallGroundProblem({ tier: 2, items: [{ ...stable, x, y }] }, { ...stable, x, y }) === null) at = { x, y };
  assert.ok(at, 'somewhere a bay fits');
  const placed = { ...stable, ...at! };
  const east = placed.x + stableFootprint(2)[0];
  assert.equal(stallGroundProblem({ tier: 2, items: [placed], plants: [{ x: east + 1, y: placed.y + 2 }] }, placed), 'plant-in-the-way');
  const stool = { id: 'w', itemDef: 'wooden-stool', scene: 'outdoor' as const, x: east, y: placed.y, rotation: 0 as const };
  assert.equal(stallGroundProblem({ tier: 2, items: [placed, stool] }, placed), 'placement-overlap');
  // A plant west of the bay (under or beside the stable itself) is not asked about.
  assert.equal(stallGroundProblem({ tier: 2, items: [placed], plants: [{ x: east - 1, y: placed.y }] }, placed), null);
});
