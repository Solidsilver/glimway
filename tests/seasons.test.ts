import test from 'node:test';
import assert from 'node:assert/strict';
import { GATHERING_DATA, gatherArea, gatheringOffered, gatheringTarget, inSeason, keepsStanding, gatheringVerb } from '../src/lib/gathering.ts';
import { itemDef, sellerFor, ITEMS } from '../src/lib/items.ts';
import { CRAFTING } from '../src/lib/workshop.ts';
import { CALENDAR, calendarAt } from '../src/lib/calendar.ts';

// The seasonal materials and the last material sources
// (docs/items/crafting-and-repair.md, "Seasonal materials"; the brief's
// build list). Content-side parity: the server reads the same JSON.

const dayAt = (unix: number) => calendarAt(unix, CALENDAR);
/** The first second of the named mark, wick or festival, in the first year. */
const epoch = Date.parse(CALENDAR.epoch) / 1000;
function firstOf(kind: 'mark' | 'wick' | 'festival', want: string): number {
  for (let d = 0; d < CALENDAR.wickDays * 12; d++) {
    const t = epoch + d * 86400 + 3600;
    const day = dayAt(t);
    if (kind === 'mark' && day.mark === want) return t;
    if (kind === 'wick' && day.wick === want) return t;
    if (kind === 'festival' && day.festival === want) return t;
  }
  throw new Error(`no ${kind} ${want} in the year`);
}

test('each seasonal material turns up only in its season, from the source the doc names', () => {
  const shore = gatheringTarget('freshet-shore');
  assert.ok(shore, 'the freshet shore is a gather target');
  assert.equal(shore?.mark, 'Mudrise');
  assert.ok(inSeason(shore!, dayAt(firstOf('mark', 'Mudrise'))));
  assert.equal(inSeason(shore!, dayAt(firstOf('mark', 'Amberfall'))), false);

  const blooms = gatheringTarget('bloom-patch');
  assert.ok(blooms, 'the bloom patch is a gather target');
  assert.equal(blooms?.wick, 'Bloom');
  assert.ok(inSeason(blooms!, dayAt(firstOf('wick', 'Bloom'))));
  assert.equal(inSeason(blooms!, dayAt(firstOf('wick', 'Light'))), false);
  for (const area of ['commons', 'wilds']) assert.ok(gatheringOffered(area, 'bloom-patch'), `bloom patches in the ${area}`);

  const ice = gatheringTarget('pond-ice');
  assert.ok(ice, 'the frozen pond is a gather target');
  assert.equal(ice?.mark, 'Quiet');
  assert.ok(gatheringOffered('village', 'pond-ice'));

  const tangleTree = gatheringTarget('tangle-tree');
  const sap = tangleTree?.yields.find((y) => y.item === 'amberfall-sap');
  assert.ok(sap, 'the Tangle trees let their sap go in Amberfall');
  assert.equal(sap?.mark, 'Amberfall');
  assert.ok(gatheringOffered('wilds', 'tangle-tree'));
  assert.equal(gatheringOffered('woodland', 'tangle-tree'), false);
  const woodsTree = gatheringTarget('tree');
  assert.equal(woodsTree?.yields.some((y) => y.item === 'amberfall-sap'), false);
});

test('the seasonal pieces stand where the seasons put them, and nowhere else', () => {
  assert.ok(gatheringOffered('village', 'freshet-shore'));
  assert.equal(gatheringOffered('commons', 'freshet-shore'), false);
  assert.equal(gatheringOffered('village', 'bloom-patch'), false);
  assert.ok(gatherArea('village') && gatherArea('commons'));
  assert.equal(gatherArea('ruin'), false);
});

test('a worked seasonal piece stays standing: the day’s caps hold you, not the map', () => {
  for (const t of ['freshet-shore', 'bloom-patch', 'pond-ice']) assert.ok(keepsStanding(t), t);
  for (const t of ['tree', 'boulder', 'stump', 'herbs']) assert.equal(keepsStanding(t), false, t);
});

test('the seasons’ work says its own word', () => {
  assert.equal(gatheringVerb('dig', gatheringTarget('freshet-shore')?.verb), 'Sweep');
  assert.equal(gatheringVerb('dig', gatheringTarget('bloom-patch')?.verb), 'Pick');
  assert.equal(gatheringVerb('break', gatheringTarget('pond-ice')?.verb), 'Break');
  assert.equal(gatheringVerb('chop'), 'Chop');
});

test('bloom flowers dry into dried flowers, and the frame takes either', () => {
  const fresh = itemDef('bloom-flowers');
  const dried = itemDef('dried-flowers');
  assert.ok(fresh && dried, 'both flowers in the catalogue');
  assert.equal(dried?.kind, 'material');
  assert.equal(dried?.icon, 'bloom-flowers', 'the dried posy borrows the fresh one’s icon');
  const frame = CRAFTING.recipes.find((r) => r.id === 'craft-pressed-flowers');
  assert.ok(frame, 'the pressed-flower frame recipe');
  assert.equal(frame?.materials['bloom-flowers'], 3);
  assert.deepEqual(frame?.swaps?.['bloom-flowers'], ['dried-flowers']);
});

test('the last materials have their people: Hazel’s tallow, Finn’s flour, and the day’s stall', () => {
  const tallow = sellerFor('hazels-kitchen');
  assert.ok(tallow, 'Hazel sells tallow');
  assert.equal(tallow?.goods[0]?.item, 'tallow');
  assert.equal(tallow?.goods[0]?.embers, 1, 'tallow is cheap');
  const flour = sellerFor('finns-mill-door');
  assert.ok(flour, 'Finn sells flour');
  assert.equal(flour?.goods[0]?.item, 'flour');
  const stall = sellerFor('madder-stall');
  assert.ok(stall, 'the Carting Day stall');
  assert.equal(stall?.festival, 'Carting Day');
  assert.equal(stall?.goods[0]?.item, 'madder-scraps');
  assert.equal(stall?.goods[0]?.cap, 4, 'the stall’s baskets empty for the day');
  assert.ok(stall?.area === 'commons');
  // Everyone named is somewhere the game knows.
  for (const s of ITEMS.sellers ?? []) {
    assert.ok(s.radiusTiles >= 1);
    assert.ok(s.goods.length > 0);
  }
});

test('storm-grade drop stays the rarest thing in the deep', () => {
  const drop = itemDef('storm-grade-drop');
  assert.ok(drop, 'in the catalogue');
  assert.match(drop?.blurb ?? '', /deep in the Tangle or the Whitequiet/);
});

/** Story text stays in-world (tests/world.test.ts's rule, for the seasons' own copy). */
const OUT_OF_WORLD = /\b(habitica|xp|habits?|tasks?|to-?dos?|dailies|streaks?|app)\b/i;

test('the seasons’ words are cozy, in-world, and fit the box', () => {
  const lines: string[] = [];
  for (const t of Object.values(GATHERING_DATA.targets)) lines.push(t.name, ...(t.verb ? [t.verb] : []));
  for (const s of ITEMS.sellers ?? []) {
    lines.push(s.npc);
    for (const g of s.goods) lines.push(g.label, g.line);
  }
  for (const d of ITEMS.items) if (['dried-flowers', 'bloom-flowers', 'walnut-shells', 'madder-scraps', 'amberfall-sap', 'frost-glass', 'tallow', 'flour', 'storm-grade-drop'].includes(d.id)) lines.push(d.blurb);
  for (const line of lines) {
    assert.ok(line.length > 0 && line.length <= 160, `${line.length} chars: ${line}`);
    assert.doesNotMatch(line, OUT_OF_WORLD, line);
  }
});
