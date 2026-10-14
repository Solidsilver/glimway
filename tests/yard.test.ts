import test from 'node:test';
import assert from 'node:assert/strict';
import { YARD_TABS, boughtToday, defaultYardTab, furnishFilter, leftToday, mendList, mergeBought, nextTier, silasInReach, utcDayStart, yardGoods } from '../src/ui/yard.ts';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';
import { ITEM_RULES, itemDef } from '../src/lib/items.ts';
import { residentAt, residentById } from '../src/lib/residents.ts';
import { TILE } from '../src/lib/tile.ts';
import type { InstanceView } from '../src/lib/api/items.ts';

/**
 * Silas's Yard panel's rules (silas-yard.md 2.5): the tab it opens on, what
 * each tab holds, Mend's list and Silas's reach, and the bundles left today.
 */

test('the Yard has four tabs, in the design’s order', () => {
  assert.deepEqual(YARD_TABS.map((t) => t.label), ['Build', 'Furnish', 'Materials', 'Mend']);
});

test('it opens on Build while an upgrade is open to you, otherwise on Furnish', () => {
  // A camp: the cottage is next. A cottage: the workshop is next.
  assert.equal(defaultYardTab(0), 'build');
  assert.equal(defaultYardTab(1), 'build');
  // The workshop stands: nothing more Silas raises (the later tiers aren't for sale).
  assert.equal(defaultYardTab(2), 'furnish');
  assert.equal(nextTier(2), null);
  assert.equal(defaultYardTab(4), 'furnish');
  // No deed: nothing to raise.
  assert.equal(defaultYardTab(null), 'furnish');
  assert.equal(nextTier(null), null);
  assert.equal(nextTier(0), 1);
  assert.equal(nextTier(1), 2);
});

test('Build holds the buildings and the lantern post; Furnish every other piece Silas sells', () => {
  const { build, furnish } = yardGoods();
  const post = HOMESTEAD_DATA.lanternPosts.item;
  assert.ok(build.some((i) => i.id === HOMESTEAD_DATA.stable.item));
  assert.ok(build.some((i) => i.id === post));
  assert.ok(!furnish.some((i) => i.id === post || i.building));
  // Nothing made only at the bench, and nothing sold twice or left out.
  const sold = HOMESTEAD_DATA.items.filter((i) => !i.craftOnly).map((i) => i.id).sort();
  assert.deepEqual([...build, ...furnish].map((i) => i.id).sort(), sold);
  // Finished pieces (glims) come before those from the Wilds (materials).
  const firstWilds = furnish.findIndex((i) => i.glims === 0);
  assert.ok(firstWilds > 0 && furnish.slice(firstWilds).every((i) => i.glims === 0));
});

test('Furnish’s chips: a piece for indoors or out shows under both', () => {
  const { furnish } = yardGoods();
  const indoor = furnishFilter(furnish, 'indoor');
  const outdoor = furnishFilter(furnish, 'outdoor');
  assert.equal(furnishFilter(furnish, 'all').length, furnish.length);
  assert.ok(indoor.every((i) => i.where.includes('indoor')));
  assert.ok(outdoor.every((i) => i.where.includes('outdoor')));
  const both = furnish.find((i) => i.where.length === 2)!;
  assert.ok(indoor.includes(both) && outdoor.includes(both));
  assert.ok(indoor.some((i) => !outdoor.includes(i)));
});

const inst = (id: string, itemDef: string, condition: number, maxCondition: number, wardenSet = false): InstanceView => ({ id, itemDef, condition, maxCondition, usesLeft: 0, state: 'fine' as InstanceView['state'], wardenSet, fittings: [], maker: null });

test('Mend lists the worn tools in your pack that a mender mends, the most worn first, at the mender’s price', () => {
  const list = mendList([
    inst('a', 'brack-felling-axe', 0, 30),
    inst('b', 'orrins-mason-pick', 30, 30), // sharp: nothing to mend
    inst('c', 'bench-axe', 2, 12), // cheap: it just breaks
    inst('d', 'ada-garden-spade', 20, 30),
    inst('e', 'nans-lamplighter-pole', 3, 30, true) // warden-set: heals on its own
  ]);
  assert.deepEqual(list.map((m) => m.instance), ['a', 'd']);
  const axe = itemDef('brack-felling-axe')!;
  assert.equal(list[0].name, axe.name);
  assert.deepEqual(list[0].materials, { ...(axe.repair!.mender ?? {}) });
  assert.equal(list[0].glims, axe.repair!.menderGlims ?? 0);
  assert.deepEqual(mendList([]), []);
});

test('Silas mends only within his mender reach, where he stands now', { skip: "T3: mender fixture needs Hearthwick world coordinates" }, () => {
  const row = ITEM_RULES.menders.find((m) => m.npc === 'silas')!;
  const now = 1_790_000_000;
  // Where he is: his cycle's place once he has one (0.7), else his mender row's spot.
  const at = residentById('silas') ? residentAt('silas', now)! : { area: row.area, tx: row.tx, ty: row.ty };
  assert.ok(at.area);
  assert.ok(at.tx !== undefined && at.ty !== undefined);
  const mid = { x: at.tx * TILE + TILE / 2, y: at.ty * TILE + TILE / 2 };
  assert.equal(silasInReach({ area: at.area, ...mid }, now), true);
  assert.equal(silasInReach({ area: at.area, x: mid.x + (row.radiusTiles - 1) * TILE, y: mid.y }, now), true);
  assert.equal(silasInReach({ area: at.area, x: mid.x + (row.radiusTiles + 1) * TILE, y: mid.y }, now), false);
  assert.equal(silasInReach({ area: 'village', ...mid }, now), false);
});

test('a bundle’s cap counts today’s buys from the Glim log, from the UTC day’s start', () => {
  const now = utcDayStart(1_790_000_000) + 3_600;
  const lines = [
    { at: now - 60, reason: 'market-buy', seller: 'Silas', itemDef: 'timber' },
    { at: now - 120, reason: 'market-buy', seller: 'Silas', itemDef: 'timber' },
    { at: now - 7_200, reason: 'market-buy', seller: 'Silas', itemDef: 'timber' }, // yesterday
    { at: now - 30, reason: 'market-buy', seller: 'Hazel', itemDef: 'timber' },
    { at: now - 30, reason: 'mend', seller: '', itemDef: 'timber' },
    { at: now - 10, reason: 'market-buy', seller: 'Silas', itemDef: 'stone' }
  ];
  assert.deepEqual(boughtToday(lines, 'Silas', now), { timber: 2, stone: 1 });
  assert.equal(leftToday(3, 1), '2 of 3 left today');
  assert.equal(leftToday(3, 5), '0 of 3 left today');
  assert.equal(leftToday(0, 2), null);
});

test('a Glim log read merges with buys the panel counted meanwhile, never counting one twice', () => {
  // Nothing counted yet: the read stands.
  assert.deepEqual(mergeBought(null, { timber: 1 }), { timber: 1 });
  // A buy landed while the read was out and the read missed it: the panel's count stays.
  assert.deepEqual(mergeBought({ timber: 2 }, { timber: 1, stone: 1 }), { timber: 2, stone: 1 });
  // The read caught it: still two, not three.
  assert.deepEqual(mergeBought({ timber: 2 }, { timber: 2 }), { timber: 2 });
});
