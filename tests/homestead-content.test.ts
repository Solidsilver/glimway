import test from 'node:test';
import assert from 'node:assert/strict';
import { HOMESTEAD_DATA, checkPlacement, gateTile, shopSections, stallCost, validateHomesteadData, type HomeInstance } from '../src/lib/homestead.ts';
import homesteadVectors from '../content/vectors/homestead-loader.json' with { type: 'json' };
import { BUILDING_BLURBS, HOMESTEAD_TIERS, DECORATIONS_EMBER, DECORATIONS_MATERIAL } from '../src/content/expansion-writing.ts';
import { createNewGame, validateSave } from '../src/lib/state.ts';
import { checkSpend, spendEmbers } from '../src/lib/embers.ts';
import { isSafeBoundary } from '../src/lib/habitica/sync.ts';

test('shared homes preserve writing identities, categories and footprints', () => {
  assert.deepEqual(HOMESTEAD_DATA.tiers.map(t => ({ id: t.id, name: t.name })), HOMESTEAD_TIERS.map(t => ({ id: t.id, name: t.name })));
  for (const group of [DECORATIONS_EMBER, DECORATIONS_MATERIAL]) for (const expected of group) {
    const v = HOMESTEAD_DATA.items.find(i => i.id === expected.id)!;
    assert.ok(v);
    assert.deepEqual([v.name, v.category, v.footprint], [expected.name, expected.category, expected.footprint]);
    if (group === DECORATIONS_EMBER) assert.ok(v.glims >= 2 && v.glims <= 6);
    else if (v.id === HOMESTEAD_DATA.lanternPosts.item) { assert.equal(v.glims, 0); assert.deepEqual(v.materials, HOMESTEAD_DATA.lanternPosts.costs[0]!.materials); }
    else { assert.equal(v.glims, 0); assert.ok(Object.keys(v.materials).length <= 2); for (const qty of Object.values(v.materials)) assert.ok(qty >= 4 && qty <= 10); }
  }
  assert.equal(HOMESTEAD_DATA.items.length, 32);
  assert.deepEqual(HOMESTEAD_DATA.tiers.filter(t => t.purchasable).map(t => t.tier), [1, 2]);
});

test('typed homestead loader rejects malformed definitions', () => {
  const mutations = [
    (h: typeof HOMESTEAD_DATA) => { h.indoor.width = 0; },
    (h: typeof HOMESTEAD_DATA) => { h.items[1].id = h.items[0].id; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].glims = -1; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].glims = 0; h.items[0].materials = {}; },
    (h: typeof HOMESTEAD_DATA) => { h.items[8].materials = { gold: 1 }; },
    (h: typeof HOMESTEAD_DATA) => { h.items[8].materials = { stone: 0 }; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].footprint = [1, 1, 1] as unknown as [number, number]; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].where = ['attic'] as never; },
    (h: typeof HOMESTEAD_DATA) => { h.tiers[3].purchasable = true; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].minTier = 5; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].category = 'weapon' as never; },
    (h: typeof HOMESTEAD_DATA) => { h.commons.fenceX = [] as unknown as [number, number]; },
    (h: typeof HOMESTEAD_DATA) => { h.commons.gateRows = [4, 5]; },
    (h: typeof HOMESTEAD_DATA) => { h.commons.rowPitch = 1; },
    (h: typeof HOMESTEAD_DATA) => { h.commons.spareGates = 0; },
    (h: typeof HOMESTEAD_DATA) => { h.outdoorReserved = [{ x: 39, y: 0, w: 2, h: 1 }]; },
    (h: typeof HOMESTEAD_DATA) => { h.land.width = 4; },
    (h: typeof HOMESTEAD_DATA) => { h.land.generator = 2; },
    (h: typeof HOMESTEAD_DATA) => { h.land.streamPermille = 1001; },
    (h: typeof HOMESTEAD_DATA) => { h.lanternPosts.item = 'nope'; },
    (h: typeof HOMESTEAD_DATA) => { h.lanternPosts.costs = []; },
    (h: typeof HOMESTEAD_DATA) => { h.lanternPosts.growth = { gold: 1 }; },
    (h: typeof HOMESTEAD_DATA) => { h.deeds.embers = 0; },
    (h: typeof HOMESTEAD_DATA) => { h.desolation.deedLostAfterDays = h.desolation.desolateAfterDays; },
    (h: typeof HOMESTEAD_DATA) => { h.jointDeed.confirmWindowSeconds = 0; },
    (h: typeof HOMESTEAD_DATA) => { h.personalChest.maxUnits = 0; },
  ];
  for (const mutation of mutations) { const h = structuredClone(HOMESTEAD_DATA); mutation(h); assert.throws(() => validateHomesteadData(h)); }
  for (const v of [null, [], {}, { ...HOMESTEAD_DATA, items: [null] }]) assert.throws(() => validateHomesteadData(v));
});

test('Commons and homesteads are safe, Wilds is unsafe, and home rest retains earned-only revival', () => {
  const state = { ...createNewGame(), area: 'commons', hp: 0, embers: 4, xpEmbers: 0 };
  assert.ok(isSafeBoundary(state));
  assert.ok(isSafeBoundary({ ...state, area: 'home:3' }));
  assert.ok(!isSafeBoundary({ ...state, area: 'wilds' }));
  assert.ok(!isSafeBoundary({ ...state, area: 'home:03' }));
  assert.equal(validateSave(state).area, 'commons');
  assert.equal(validateSave({ ...state, area: 'home:12' }).area, 'home:12');
  assert.throws(() => validateSave({ ...state, area: 'home:-1' }));
  assert.equal(checkSpend(state, { kind: 'home-rest' }, { imported: true }).reason, 'needs-earned');
  const rested = spendEmbers({ ...state, xpEmbers: 1 }, { kind: 'home-rest' }, { imported: true });
  assert.equal(rested.hp, rested.maxHp); assert.equal(rested.embers, 3); assert.equal(rested.xpEmbers, 0);
});

test('gate tiles are where the Commons map draws them (same table as the Go test)', () => {
  const want = [[19, 9], [28, 9], [19, 13], [28, 13], [19, 28], [28, 28], [19, 33], [28, 33], [19, 38], [28, 38], [19, 43]];
  want.forEach(([tx, ty], g) => assert.deepEqual([gateTile(g).tx, gateTile(g).ty], [tx, ty], `gate ${g}`));
  assert.equal(HOMESTEAD_DATA.commons.tileSize, 16);
});

test('the shared stall-cost bill matches the client growth rule', () => {
  const vectors = (homesteadVectors as unknown as { stallCost: { extra: number; bill: Record<string, number> }[] }).stallCost;
  assert.ok(vectors.length >= 5, 'one bill per extra bay');
  for (const v of vectors) assert.deepEqual(stallCost(v.extra), v.bill, `extra ${v.extra}`);
  assert.deepEqual(stallCost(1), HOMESTEAD_DATA.stable.stallCost);
});

test('the local placement check mirrors the server rules', () => {
  const fern: HomeInstance = { id: 'f', itemDef: 'potted-fern', scene: null, x: null, y: null, rotation: null };
  const stool: HomeInstance = { id: 's', itemDef: 'wooden-stool', scene: null, x: null, y: null, rotation: null };
  const chair: HomeInstance = { id: 'c', itemDef: 'reading-chair', scene: 'indoor', x: 0, y: 0, rotation: 0 };
  const home = { tier: 1, items: [fern, chair] };
  const s = HOMESTEAD_DATA.land.startLight;
  // Outdoors, a campsite can set out what needs no cottage.
  assert.equal(checkPlacement({ tier: 0, items: [stool] }, stool, 'outdoor', s.x - 3, s.y + 3, 0), null);
  assert.equal(checkPlacement({ tier: 0, items: [stool] }, stool, 'indoor', 0, 0, 0), 'tier-required');
  if (homeMinTier('potted-fern') > 0) assert.equal(checkPlacement({ tier: 0, items: [fern] }, fern, 'outdoor', s.x - 3, s.y + 3, 0), 'tier-required');
  assert.equal(checkPlacement(home, fern, 'outdoor', s.x - 3, s.y + 3, 0), null);
  assert.equal(checkPlacement(home, fern, 'outdoor', HOMESTEAD_DATA.land.width, 0, 0), 'out-of-bounds');
  assert.equal(checkPlacement(home, fern, 'outdoor', s.x, s.y, 0), 'placement-overlap'); // the home site
  assert.equal(checkPlacement(home, fern, 'outdoor', 2, 2, 0), 'unlit');
  assert.equal(checkPlacement(home, fern, 'indoor', 0, 1, 0), 'placement-overlap'); // the chair
  assert.equal(checkPlacement(home, fern, 'indoor', 5, 9, 0), 'placement-overlap'); // the doorway
  assert.equal(checkPlacement(home, chair, 'outdoor', 0, 0, 0), 'invalid-placement');
  assert.equal(checkPlacement(home, chair, 'indoor', 11, 9, 90), 'out-of-bounds');
  assert.equal(checkPlacement(home, chair, 'indoor', 10, 9, 90), null);
});

const homeMinTier = (id: string) => HOMESTEAD_DATA.items.find((i) => i.id === id)!.minTier;

test('Silas’s Yard: buildings come from the content flag, in a section of their own', () => {
  const { buildings, finished, wilds } = shopSections();
  // Today the stable; the kiln joins it by its row's flag, not by an id here.
  assert.deepEqual(buildings.map((i) => i.id), [HOMESTEAD_DATA.stable.item]);
  assert.ok(buildings.every((i) => i.minTier === 2 && BUILDING_BLURBS[i.id]));
  assert.ok(![...finished, ...wilds].some((i) => i.building || i.craftOnly));
  // Every sold piece is in exactly one section.
  const sold = HOMESTEAD_DATA.items.filter((i) => !i.craftOnly).map((i) => i.id).sort();
  assert.deepEqual([...buildings, ...finished, ...wilds].map((i) => i.id).sort(), sold);
  // A flag on another row moves it, and a building the bench makes isn't sold.
  const data = { ...HOMESTEAD_DATA, items: HOMESTEAD_DATA.items.map((i) => (i.id === 'wooden-stool' ? { ...i, building: true } : i.id === HOMESTEAD_DATA.stable.item ? { ...i, craftOnly: true } : i)) };
  assert.deepEqual(shopSections(data).buildings.map((i) => i.id), ['wooden-stool']);
});
