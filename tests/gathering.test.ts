import test from 'node:test';
import assert from 'node:assert/strict';
import { GATHERING_DATA, gatheringTarget, isPlantableSeed, gatheringSwings, gatheringVerb, gatheringToolWord, visitIdFor, visitKey } from '../src/lib/gathering.ts';
import { itemDef } from '../src/lib/items.ts';
import { chunkTerrain } from '../src/lib/wilds/index.ts';
import { toWorldData, GATHER_OF } from '../src/lib/wilds/world-data.ts';
import { buildArea } from '../src/game/worlds.ts';
import { setLandSource } from '../src/game/homeland.ts';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';

const epoch = { worldSeed: 'oak-7', regionId: 'inner-1', generatorVersion: 1, season: 'spring' } as const;

test('gathering rules match specification', () => {
  assert.equal(GATHERING_DATA.caps.visit.chop, 8);
  assert.equal(GATHERING_DATA.caps.visit.break, 5);
  assert.equal(GATHERING_DATA.caps.visit.dig, 6);

  assert.equal(GATHERING_DATA.caps.day.chop, 30);
  assert.equal(GATHERING_DATA.caps.day.break, 20);
  assert.equal(GATHERING_DATA.caps.day.dig, 25);

  assert.equal(GATHERING_DATA.softCapLine, 'The wood’s given enough here today.');
});

test('gathering targets and yields are valid items', () => {
  for (const [id, target] of Object.entries(GATHERING_DATA.targets)) {
    assert.ok(target.action, `target ${id} missing action`);
    assert.ok(target.toolAction, `target ${id} missing toolAction`);
    assert.ok(target.yields.length > 0, `target ${id} missing yields`);
    for (const y of target.yields) {
      const def = itemDef(y.item);
      assert.ok(def, `yield item ${y.item} not in catalogue`);
      assert.ok(y.min > 0 && y.max >= y.min);
    }
  }
});

test('gathering seeds are valid seed items in catalogue', () => {
  for (const seed of GATHERING_DATA.seeds) {
    assert.ok(isPlantableSeed(seed));
    const def = itemDef(seed);
    assert.ok(def, `seed ${seed} not in catalogue`);
    assert.equal(def.kind, 'seed');
  }
});

test('swings per action with and without bite fitting', () => {
  assert.equal(gatheringSwings('chop', false), 3);
  assert.equal(gatheringSwings('chop', true), 2);
  assert.equal(gatheringSwings('break', false), 3);
  assert.equal(gatheringSwings('break', true), 2);
  assert.equal(gatheringSwings('dig', false), 2);
  assert.equal(gatheringSwings('dig', true), 1);
  assert.equal(gatheringVerb('chop'), 'Chop');
  assert.equal(gatheringVerb('break'), 'Break');
  assert.equal(gatheringVerb('dig'), 'Dig');
  assert.equal(gatheringToolWord('chop'), 'axe');
  assert.equal(gatheringToolWord('break'), 'pick');
  assert.equal(gatheringToolWord('dig'), 'spade');
});

test('a visit is one stay: the same while you rebuild, new when you leave and return', () => {
  assert.equal(visitKey('wilds', null), 'wilds:tangle');
  assert.equal(visitKey('wilds', 'outer-1'), 'wilds:outer-1');
  assert.equal(visitKey('home:0', null), 'home:0');
  const a = visitIdFor('wilds', null);
  assert.equal(visitIdFor('wilds', null), a, 'a scene rebuild is the same visit');
  const b = visitIdFor('commons', null);
  assert.notEqual(visitIdFor('wilds', null), a, 'leaving and coming back is a new visit');
  assert.notEqual(b, a);
});

test('the Tangle offers work: trees and boulders stand on solid ground, patches you can dig', () => {
  for (const [cx, cy] of [[0, 0], [1, 1], [2, 0]] as const) {
    const w = toWorldData(chunkTerrain(epoch, cx, cy), 'wilds');
    assert.ok((w.gathering?.length ?? 0) > 10, `chunk ${cx},${cy} has workable pieces`);
    for (const spot of w.gathering ?? []) {
      const t = gatheringTarget(spot.target);
      assert.ok(t, `spot target ${spot.target} is in content/gathering.json`);
      assert.ok(spot.label.length > 0, 'every spot says what it is in words');
      const solid = w.solid[spot.ty]?.[spot.tx] ?? false;
      if (t.action === 'dig') assert.ok(w.ground[spot.ty][spot.tx] !== undefined, 'a dig patch sits on the map');
      else assert.ok(solid, `a ${spot.target} stands on solid ground at ${spot.tx},${spot.ty}`);
      assert.ok(spot.art, 'a woods piece carries its art (a felled tree leaves its stump)');
    }
  }
});

test('every woods kind that can be worked maps to a target with yields', () => {
  for (const [kind, g] of Object.entries(GATHER_OF)) {
    const t = gatheringTarget(g.target);
    assert.ok(t, `decor ${kind} maps to target ${g.target}`);
    assert.ok(t.yields.length > 0, `target ${g.target} yields something`);
  }
});

test('homestead land: work stands on solid ground, clear of the home site, and stumps are kept', () => {
  const w = buildArea('home:0');
  const site = HOMESTEAD_DATA.land.site;
  for (const spot of w.gathering ?? []) {
    assert.ok(gatheringTarget(spot.target), `spot target ${spot.target} is in content/gathering.json`);
    assert.ok(w.solid[spot.ty][spot.tx], `a ${spot.target} stands on solid ground at ${spot.tx},${spot.ty}`);
    const onSite = spot.tx >= site.x && spot.tx < site.x + site.w && spot.ty >= site.y && spot.ty < site.y + site.h;
    assert.ok(!onSite, 'no work inside the home site');
  }
  assert.ok((w.gathering?.length ?? 0) > 10, 'the land has woods to work');
  // The drift: what you leave comes back the same (the land builds from its seed).
  const again = buildArea('home:0');
  assert.deepEqual(again.gathering, w.gathering, 'regrowth rebuilds the same land');
});

test('a kept stump (inside lamplight) is workable ground; a planted piece is not', () => {
  setLandSource({
    worldId: () => 'test-world',
    state: (gate) =>
      gate === 0
        ? { cleared: [], stumps: [[20, 11]], plants: [{ id: 'p1', itemDef: 'birch-sapling', x: 21, y: 11 }], desolate: false }
        : null
  });
  try {
    const w = buildArea('home:0');
    const stump = (w.gathering ?? []).find((s) => s.tx === 20 && s.ty === 11);
    assert.ok(stump, 'the kept stump offers work');
    assert.equal(stump?.target, 'stump');
    // The planted piece stands where it was put, and is not work.
    assert.ok(
      !(w.gathering ?? []).some((s) => s.tx === 21 && s.ty === 11),
      'a planted piece is not workable ground'
    );
  } finally {
    setLandSource({ worldId: () => 'guest', state: () => null });
  }
});
