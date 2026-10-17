import test from 'node:test';
import assert from 'node:assert/strict';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';
import { itemDef, sellerFor } from '../src/lib/items.ts';
import { calendarAt } from '../src/lib/clock.ts';
import { alreadyTappedLine, refineChoice, tapLines, WICK_SAP } from '../src/lib/wick-sap.ts';
import { itemErrorText } from '../src/content/errors.ts';
import { parseItemsResult } from '../src/lib/api/items.ts';

test('wick sap rules: a real item, refined at the chandler into a wick of lot-lantern oil', () => {
  assert.equal(itemDef(WICK_SAP.item)?.kind, 'material');
  assert.equal(WICK_SAP.oil, HOMESTEAD_DATA.lotLantern.oil);
  assert.ok(sellerFor(WICK_SAP.refiner));
  assert.ok(WICK_SAP.qty * WICK_SAP.oilQty * HOMESTEAD_DATA.lotLantern.wicksPerOil >= 1);
  // Bought oil is unchanged: 4 glims a flask, 3 a day.
  const good = sellerFor('chandler')!.goods.find((g) => g.item === 'hearth-oil')!;
  assert.deepEqual([good.glims, good.cap], [4, 3]);
});

test('the first tap explains the free weekly sap and the chandler; later taps are short', () => {
  const first = tapLines(true).join(' ');
  assert.match(first, /one jar of sap a wick, free/);
  assert.match(first, /chandler/);
  assert.match(first, /hearth oil for nothing/);
  assert.deepEqual(tapLines(false), ['You tap the Wick Tree. A jar of sap for this wick.']);
});

test('already tapped: names the next wick and the days to it, never a clock', () => {
  const start = calendarAt(1_790_000_000).startsAt;
  const next = calendarAt(calendarAt(start).nextTurning).wick;
  const early = alreadyTappedLine(start + 3600);
  assert.equal(early, `You’ve had the tree’s sap this wick. It gives again when ${next}-wick comes in, in 7 days.`);
  assert.match(alreadyTappedLine(calendarAt(start).nextTurning - 60), /within the day\.$/);
  assert.match(alreadyTappedLine(start + 2.5 * 86_400 + 0.25), /in 5 days\.$/);
  assert.doesNotMatch(early, /\d+:\d+|hours?|minutes?|seconds?/);
  assert.notEqual(itemErrorText('already-tapped'), itemErrorText('no-such-code'));
});

test('the chandler offers refining only to someone carrying sap', () => {
  assert.equal(refineChoice(0), null);
  assert.deepEqual(refineChoice(1), { text: 'Refine your sap into hearth oil · free', action: 'sap:refine' });
  assert.equal(refineChoice(2)!.text, 'Refine your sap into hearth oil · free (2 jars)');
});

test('items results keep a tap and a refine', () => {
  const items = { stacks: [{ itemDef: 'wick-sap', qty: 1, maker: null }], instances: [], pockets: [], offHand: { open: false, class: null, itemDef: null, instance: null }, pickedUp: [], thanks: [] };
  const fields = { wear: null, used: '', pickup: '', given: null, mended: '', created: [], gathered: [], plant: null, land: null, returned: '', paper: null, heirloom: '', adaOilCount: 0, glimsGiven: 0, bought: null, tapped: null, firstTap: false, refined: null };
  const tapped = parseItemsResult({ items, ...fields, tapped: { itemDef: 'wick-sap', qty: 1, maker: null }, firstTap: true });
  assert.deepEqual([tapped.tapped, tapped.firstTap, tapped.refined], [{ itemDef: 'wick-sap', qty: 1 }, true, undefined]);
  const refined = parseItemsResult({ items, ...fields, used: 'wick-sap', refined: { itemDef: 'hearth-oil', qty: 1, maker: null } });
  assert.deepEqual([refined.refined, refined.firstTap, refined.used], [{ itemDef: 'hearth-oil', qty: 1 }, undefined, 'wick-sap']);
});
