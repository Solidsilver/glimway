import test from 'node:test';
import assert from 'node:assert/strict';
import { HOMESTEAD_DATA, checkPlacement, plotBounds, plotTile, validateHomesteadData, type HomeInstance } from '../src/lib/homestead.ts';
import { HOMESTEAD_TIERS, DECORATIONS_EMBER, DECORATIONS_MATERIAL } from '../src/content/expansion-writing.ts';
import { createNewGame, validateSave } from '../src/lib/state.ts';
import { checkSpend, spendEmbers } from '../src/lib/embers.ts';
import { isSafeBoundary } from '../src/lib/habitica/sync.ts';

test('shared homes preserve writing identities, categories and footprints', () => {
  assert.deepEqual(HOMESTEAD_DATA.tiers.map(t => ({ id: t.id, name: t.name })), HOMESTEAD_TIERS.map(t => ({ id: t.id, name: t.name })));
  for (const group of [DECORATIONS_EMBER, DECORATIONS_MATERIAL]) for (const expected of group) {
    const v = HOMESTEAD_DATA.items.find(i => i.id === expected.id)!;
    assert.ok(v);
    assert.deepEqual([v.name, v.category, v.footprint], [expected.name, expected.category, expected.footprint]);
    if (group === DECORATIONS_EMBER) assert.ok(v.embers >= 2 && v.embers <= 6);
    else { assert.equal(v.embers, 0); assert.ok(Object.keys(v.materials).length <= 2); for (const qty of Object.values(v.materials)) assert.ok(qty >= 4 && qty <= 10); }
  }
  assert.equal(HOMESTEAD_DATA.items.length, DECORATIONS_EMBER.length + DECORATIONS_MATERIAL.length);
  assert.deepEqual(HOMESTEAD_DATA.tiers.filter(t => t.purchasable).map(t => t.tier), [1, 2]);
});

test('typed homestead loader rejects malformed definitions', () => {
  const mutations = [
    (h: typeof HOMESTEAD_DATA) => { h.indoor.width = 0; },
    (h: typeof HOMESTEAD_DATA) => { h.items[1].id = h.items[0].id; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].embers = -1; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].materials = { stone: 1 }; },
    (h: typeof HOMESTEAD_DATA) => { h.items[8].materials = { gold: 1 }; },
    (h: typeof HOMESTEAD_DATA) => { h.items[8].materials = { stone: 0 }; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].footprint = [1, 1, 1] as unknown as [number, number]; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].where = ['attic'] as never; },
    (h: typeof HOMESTEAD_DATA) => { h.tiers[3].purchasable = true; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].minTier = 5; },
    (h: typeof HOMESTEAD_DATA) => { h.items[0].category = 'weapon' as never; },
    (h: typeof HOMESTEAD_DATA) => { h.commons.columns = []; },
    (h: typeof HOMESTEAD_DATA) => { h.commons.columns = [4, 10]; },
    (h: typeof HOMESTEAD_DATA) => { h.commons.rowPitch = 4; },
    (h: typeof HOMESTEAD_DATA) => { h.outdoorReserved = [{ x: 15, y: 0, w: 2, h: 1 }]; },
  ];
  for (const mutation of mutations) { const h = structuredClone(HOMESTEAD_DATA); mutation(h); assert.throws(() => validateHomesteadData(h)); }
  for (const v of [null, [], {}, { ...HOMESTEAD_DATA, items: [null] }]) assert.throws(() => validateHomesteadData(v));
});

test('Commons is safe, Wilds is unsafe, and home rest retains earned-only revival', () => {
  const state = { ...createNewGame(), area: 'commons', hp: 0, embers: 4, xpEmbers: 0 };
  assert.ok(isSafeBoundary(state));
  assert.ok(!isSafeBoundary({ ...state, area: 'wilds' }));
  assert.equal(validateSave(state).area, 'commons');
  assert.equal(checkSpend(state, { kind: 'home-rest' }, { imported: true }).reason, 'needs-earned');
  const rested = spendEmbers({ ...state, xpEmbers: 1 }, { kind: 'home-rest' }, { imported: true });
  assert.equal(rested.hp, rested.maxHp); assert.equal(rested.embers, 3); assert.equal(rested.xpEmbers, 0);
});

test('plot bounds are the rectangles the Commons map draws (same table as the Go test)', () => {
  const want = [[64, 64], [448, 64], [64, 416], [448, 416], [64, 640], [448, 640], [64, 864]];
  want.forEach(([x, y], i) => assert.deepEqual(plotBounds(i), { x, y, width: 256, height: 192 }, `plot ${i}`));
  assert.equal(HOMESTEAD_DATA.commons.tileSize, 16);
  assert.deepEqual(plotTile(5), { tx: 28, ty: 40 });
});

test('the local placement check mirrors the server rules', () => {
  const fern: HomeInstance = { id: 'f', itemDef: 'potted-fern', scene: null, x: null, y: null, rotation: null };
  const chair: HomeInstance = { id: 'c', itemDef: 'reading-chair', scene: 'indoor', x: 0, y: 0, rotation: 0 };
  const home = { tier: 1, items: [fern, chair] };
  assert.equal(checkPlacement({ tier: 0, items: [fern] }, fern, 'outdoor', 0, 0, 0), 'tier-required');
  assert.equal(checkPlacement(home, fern, 'outdoor', 0, 0, 0), null);
  assert.equal(checkPlacement(home, fern, 'outdoor', 16, 0, 0), 'out-of-bounds');
  assert.equal(checkPlacement(home, fern, 'outdoor', 6, 2, 0), 'placement-overlap'); // the cottage
  assert.equal(checkPlacement(home, fern, 'indoor', 0, 1, 0), 'placement-overlap'); // the chair
  assert.equal(checkPlacement(home, fern, 'indoor', 5, 9, 0), 'placement-overlap'); // the doorway
  assert.equal(checkPlacement(home, chair, 'outdoor', 0, 0, 0), 'invalid-placement');
  assert.equal(checkPlacement(home, chair, 'indoor', 11, 9, 90), 'out-of-bounds');
  assert.equal(checkPlacement(home, chair, 'indoor', 10, 9, 90), null);
});
