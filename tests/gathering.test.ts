import test from 'node:test';
import assert from 'node:assert/strict';
import { GATHERING_DATA, gatherArea, gatheringTarget, isPlantableSeed, gatheringSwings, gatheringVerb, gatheringToolWord, keepsWork, swingPlan, SWING_MS, visitIdFor, visitKey, visitWork, yieldLine, leftBehind, wearLine, gatheringOffered, EMPTY_YIELD_LINE, PLANTS_FULL_LINE } from '../src/lib/gathering.ts';
import { itemDef } from '../src/lib/items.ts';
import { chunkTerrain } from '../src/lib/wilds/index.ts';
import { toWorldData, GATHER_OF } from '../src/lib/wilds/world-data.ts';
import { buildArea } from '../src/game/worlds.ts';
import { plantScenery, setLandSource } from '../src/game/homeland.ts';
import { HOMESTEAD_DATA, checkPlacement, plantable, plantTileNear } from '../src/lib/homestead.ts';
import { LAND, generateLand, homeLights, isLit } from '../src/lib/homestead-land.ts';

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
    const tiles = (w.gathering ?? []).map((s) => `${s.tx},${s.ty}`);
    assert.equal(new Set(tiles).size, tiles.length, 'one piece of work to a tile');
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

test('a tool’s feel: Bite takes a swing off, Heft quickens, a dull warden-set tool slows (less with Bite)', () => {
  const plain = { bite: false, heft: false, dull: false };
  assert.deepEqual(swingPlan('chop', plain), { swings: 3, ms: SWING_MS });
  assert.deepEqual(swingPlan('chop', { ...plain, bite: true }), { swings: 2, ms: SWING_MS });
  assert.ok(swingPlan('chop', { ...plain, heft: true }).ms < SWING_MS);
  assert.equal(swingPlan('dig', { ...plain, dull: true }).ms, SWING_MS * 2, 'half speed at its dullest');
  assert.equal(swingPlan('dig', { ...plain, dull: true, bite: true }).ms, Math.round((SWING_MS * 4) / 3), 'three-quarters with Bite');
  assert.equal(swingPlan('dig', { ...plain, bite: true }).swings, 1, 'never fewer than one swing');
});

test('the drift: only your land inside lamplight keeps what you work; everywhere else regrows', () => {
  for (const area of ['wilds', 'woodland', 'home:0', 'village', 'commons']) assert.ok(gatherArea(area), `${area} offers work`);
  for (const area of ['ruin', 'cottage']) assert.ok(!gatherArea(area), `${area} offers none`);
  assert.equal(keepsWork('home:3', true), true, 'inside lamplight: a stump stays a stump');
  assert.equal(keepsWork('home:3', false), false, 'the unlit edge regrows like the Tangle');
  assert.equal(keepsWork('wilds', true), false, 'the Tangle always comes back');
  assert.equal(keepsWork('woodland', false), false);
});

test('the woods by the village offer trees and boulders; the ruin and the village none', () => {
  const woods = buildArea('woodland');
  const spots = woods.gathering ?? [];
  assert.ok(spots.some((s) => s.target === 'tree') && spots.some((s) => s.target === 'boulder'));
  for (const s of spots) assert.ok(gatheringTarget(s.target), s.target);
  assert.equal(new Set(spots.map((s) => `${s.tx},${s.ty}`)).size, spots.length, 'one piece of work to a tile');
  assert.equal((buildArea('ruin').gathering ?? []).length, 0);
  assert.equal((buildArea('village').gathering ?? []).length, 0);
});

test('the land rebuilt after leaving: lit stumps stay, unlit felled trees stand again, open ground stays open', () => {
  const land = generateLand(1234);
  const lights = homeLights([]);
  const lit = { x: -1, y: -1 };
  const dark = { x: -1, y: -1 };
  for (let y = 1; y < land.height - 1; y++) {
    for (let x = 1; x < land.width - 1; x++) {
      if (land.tiles[y * land.width + x] !== LAND.TREE) continue;
      if (isLit(lights, x, y) && lit.x < 0) Object.assign(lit, { x, y });
      if (!isLit(lights, x, y) && dark.x < 0) Object.assign(dark, { x, y });
    }
  }
  assert.ok(lit.x >= 0 && dark.x >= 0, 'seed 1234 has lit and dark trees');
  // What the server keeps: only the lit stump (the dark chop is never stored).
  setLandSource({ worldId: () => 'w', seed: () => 1234, state: () => ({ cleared: [], stumps: [[lit.x, lit.y]], plants: [], desolate: false }) });
  try {
    const w = buildArea('home:0');
    const at = (x: number, y: number) => (w.gathering ?? []).find((s) => s.tx === x && s.ty === y)?.target;
    assert.equal(at(lit.x, lit.y), 'stump', 'the lit stump stays');
    assert.ok(['tree', 'iron-oak'].includes(at(dark.x, dark.y) ?? ''), 'the dark tree stands again');
    assert.ok(w.solid[lit.y][lit.x], 'a stump is still in the way');
  } finally {
    setLandSource({ worldId: () => 'guest', state: () => null });
  }
  setLandSource({ worldId: () => 'w', seed: () => 1234, state: () => ({ cleared: [[lit.x, lit.y]], stumps: [], plants: [], desolate: false }) });
  try {
    const w = buildArea('home:0');
    assert.ok(!(w.gathering ?? []).some((s) => s.tx === lit.x && s.ty === lit.y), 'a dug stump leaves nothing to work');
    assert.ok(!w.solid[lit.y][lit.x], 'and open ground');
  } finally {
    setLandSource({ worldId: () => 'guest', state: () => null });
  }
});

test('planting goes into open grass only, near your feet', () => {
  const home = { landSeed: 1234, cleared: [] as [number, number][], items: [], plants: [] as { x: number; y: number }[] };
  const land = generateLand(1234);
  const site = HOMESTEAD_DATA.land.site;
  let tree: [number, number] | null = null;
  let grass: [number, number] | null = null;
  for (let y = 1; y < land.height - 1 && (!tree || !grass); y++) {
    for (let x = 1; x < land.width - 1; x++) {
      const k = land.tiles[y * land.width + x];
      if (k === LAND.TREE && !tree) tree = [x, y];
      if (k === LAND.GRASS && !grass && plantable(home, x, y)) grass = [x, y];
    }
  }
  assert.ok(tree && grass);
  assert.ok(!plantable(home, tree[0], tree[1]), 'not into a tree');
  assert.ok(!plantable(home, site.x, site.y), 'not on the home site');
  assert.ok(plantable({ ...home, cleared: [tree] }, tree[0], tree[1]), 'cleared ground takes a sapling');
  assert.ok(!plantable({ ...home, plants: [{ x: grass[0], y: grass[1] }] }, grass[0], grass[1]), 'one plant to a tile');
  // Standing on open grass: it goes in at your feet.
  assert.deepEqual(plantTileNear(home, { x: grass[0] * 16 + 8, y: grass[1] * 16 + 10 }), grass);
  // Standing in the middle of the home site: nowhere to plant.
  assert.equal(plantTileNear(home, { x: (site.x + site.w / 2) * 16, y: (site.y + site.h / 2) * 16 }), null);
});

test('a planted sapling is drawn as itself, an herb or spawn as a patch of the woods', () => {
  const sap = plantScenery({ itemDef: 'birch-sapling', x: 4, y: 5 }, 'atlas');
  assert.equal(sap.frame, undefined);
  assert.equal(sap.x, 4 * 16 + 8);
  assert.equal(sap.y, 6 * 16);
  const thyme = plantScenery({ itemDef: 'wild-thyme', x: 4, y: 5 }, 'atlas');
  assert.equal(thyme.key, 'atlas');
  assert.match(thyme.frame ?? '', /^flowers-/);
  assert.match(plantScenery({ itemDef: 'turncap-spawn', x: 1, y: 1 }, 'atlas').frame ?? '', /^turncaps-/);
});

test('a stay remembers its work; a new visit starts fresh', () => {
  const first = visitIdFor('wilds', null);
  const done = visitWork(first);
  done.worked.set('chunk:inner-1:0:0:4,5', 'stump');
  done.enough.add('chop');
  assert.equal(visitWork(visitIdFor('wilds', null)).worked.get('chunk:inner-1:0:0:4,5'), 'stump', 'a rebuild in the same stay keeps it');
  visitIdFor('commons', null);
  const again = visitWork(visitIdFor('wilds', null));
  assert.equal(again.worked.size, 0, 'leaving and coming back: the woods have regrown');
  assert.equal(again.enough.size, 0, 'and give again');
});

test('the yield in words: stuff counted as stuff, things as things', () => {
  assert.equal(yieldLine([{ itemDef: 'timber', qty: 4 }]), '4 timber');
  assert.equal(yieldLine([{ itemDef: 'stone', qty: 3 }, { itemDef: 'drift-stone', qty: 1 }]), '3 stone and a little drift-stone');
  assert.equal(yieldLine([{ itemDef: 'timber', qty: 2 }, { itemDef: 'green-ash-haft', qty: 1 }]), '2 timber and a green-ash haft');
  assert.equal(yieldLine([{ itemDef: 'hazel-whip', qty: 1 }]), 'a hazel whip');
});

test('what a worked piece leaves: a stump, pebbles, or nothing where a stump was dug out', () => {
  assert.equal(leftBehind('chop', 'stump'), 'stump');
  assert.equal(leftBehind('break', 'open'), 'pebbles');
  assert.equal(leftBehind('dig', 'open'), null);
  // A rebuild replays a chopped-then-dug tree from the tree: open ground, nothing drawn.
  assert.equal(leftBehind('chop', 'open'), null);
});

test('wear is told in a line: giving out, going blunt, a fitting wearing away', () => {
  const base = { broke: false, state: 'worn', wornOut: [] as string[], returned: [] as string[], itemDef: 'bench-axe', usesLeft: 12 };
  assert.equal(wearLine(base), null, 'an ordinary swing says nothing');
  assert.equal(wearLine(undefined), null);
  assert.equal(wearLine({ ...base, broke: true, usesLeft: 0 }), 'Your bench axe gave out.');
  assert.match(wearLine({ ...base, broke: true, returned: ['loose-road-nail'] }) ?? '', /^Your bench axe gave out\. You kept the loose road-?nail\.$/i);
  assert.match(wearLine({ ...base, itemDef: 'brack-felling-axe', state: 'blunt', usesLeft: 0 }) ?? '', /^The Brack felling axe has gone blunt\. Mend it/);
  assert.match(wearLine({ ...base, itemDef: 'ada-garden-spade', state: 'blunt', usesLeft: 0 }) ?? '', /^Ada['’]s garden spade has gone blunt/);
  assert.match(wearLine({ ...base, wornOut: ['waxed-cord'] }) ?? '', /^The waxed cord wore away\.$/);
  for (const line of [EMPTY_YIELD_LINE, PLANTS_FULL_LINE, wearLine({ ...base, itemDef: 'brack-felling-axe', state: 'cracked' })!]) {
    assert.ok(line.length <= 160, line);
    assert.ok(!/\d/.test(line), `no numbers: ${line}`);
  }
});

test('each place offers only the pieces the server allows there', () => {
  for (const [cx, cy] of [[0, 0], [1, 1], [2, 0]] as const) {
    for (const s of toWorldData(chunkTerrain(epoch, cx, cy), 'wilds').gathering ?? []) assert.ok(gatheringOffered('wilds', s.target), `wilds: ${s.target}`);
  }
  for (const s of Object.values(GATHER_OF)) assert.ok(gatheringOffered("wilds", s!.target), `wilds kind: ${s!.target}`);
  for (const s of buildArea('woodland').gathering ?? []) assert.ok(gatheringOffered('woodland', s.target), `woodland: ${s.target}`);
  for (const s of buildArea('home:0').gathering ?? []) assert.ok(gatheringOffered('home:0', s.target), `home: ${s.target}`);
  assert.ok(!gatheringOffered('woodland', 'hollow-tree'));
  assert.ok(!gatheringOffered('village', 'tree'));
  assert.ok(GATHERING_DATA.plantsPerHome > 0);
});

test('nothing is set out on top of something growing', () => {
  const s = HOMESTEAD_DATA.land.startLight;
  const stool = { id: 'st', itemDef: 'wooden-stool', scene: null, x: null, y: null, rotation: null } as never;
  const home = { tier: 0, items: [stool] };
  const spot = [s.x - 3, s.y + 3] as const;
  assert.equal(checkPlacement(home, stool, 'outdoor', spot[0], spot[1], 0), null);
  assert.equal(checkPlacement({ ...home, plants: [{ x: spot[0], y: spot[1] }] }, stool, 'outdoor', spot[0], spot[1], 0), 'plant-in-the-way');
});
