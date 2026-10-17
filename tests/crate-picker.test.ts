import test from 'node:test';
import assert from 'node:assert/strict';
import { CRATE_WORDS, cratePick, crateRows, crateTakeLines, keptLine } from '../src/lib/camps.ts';
import { CARRIED_PLANT_WORDS, modelEntries } from '../src/lib/inventory.ts';
import { GATHERING_DATA } from '../src/lib/gathering.ts';
import type { ItemsView } from '../src/lib/api/types.ts';

const entry = (id: number, kind: string, itemDef: string, qty = 1, o: { movedBy?: string; reason?: string } = {}) => ({ id, kind, itemDef, qty, ...o });

test('the picker lists each entry with why it waits; only plants offer whole or seed', () => {
  const rows = crateRows([
    entry(1, 'piece', 'way-lamp'),
    entry(2, 'plant', 'birch-sapling'),
    entry(3, 'stack', 'stone', 3, { reason: 'land-changed' }),
    entry(4, 'piece', 'wooden-stool', 1, { movedBy: 'Alice' }),
    entry(5, 'piece', 'wooden-stool', 1, { reason: 'deed-lost' }),
    entry(6, 'piece', 'wooden-stool', 1, { reason: 'packed-up' }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4, 5, 6], 'in Pell’s order');
  assert.equal(rows[0]!.label, 'A way-lamp');
  assert.match(rows[2]!.label, /^3 [Ss]tones?$/);
  assert.deepEqual(rows.map((r) => r.plant), [false, true, false, false, false, false]);
  assert.equal(rows[0]!.note, 'From a camp the woods took back');
  assert.equal(rows[2]!.note, 'Your old paths, paid back');
  assert.equal(rows[3]!.note, 'Moved off Alice’s camp');
  assert.equal(rows[4]!.note, 'From your old lot');
  assert.equal(rows[5]!.note, 'From the camp you packed up');
  assert.deepEqual(crateRows([]), []);
});

test('the picker asks for one entry, a plant whole or as its seed, or for everything', () => {
  assert.deepEqual(cratePick(null), { entries: [], asSeed: [] }, 'none named: everything');
  assert.deepEqual(cratePick(7), { entries: [7], asSeed: [] });
  assert.deepEqual(cratePick(7, true), { entries: [7], asSeed: [7] });
});

test('Pell says what was signed out, and what the pack could not carry stays', () => {
  const lamp = { itemDef: 'way-lamp', qty: 1 }, sapling = { itemDef: 'birch-sapling', qty: 1 }, thyme = { itemDef: 'wild-thyme', qty: 1 };
  assert.deepEqual(crateTakeLines([lamp]), ['Signed out to you: a way-lamp. The home pieces are in your pack.']);
  assert.deepEqual(crateTakeLines([]), ['Nothing waiting for you. The book’s square.']);
  const both = crateTakeLines([lamp], [sapling]);
  assert.equal(both.length, 2);
  assert.match(both[0]!, /^Signed out to you: a way-lamp/);
  assert.equal(both[1], keptLine([sapling]));
  assert.match(keptLine([sapling]), new RegExp(`carries ${GATHERING_DATA.carriedPlants} living plants at most, so a birch sapling waits here for you\\. Plant one first, or take it as seed\\.`));
  assert.match(keptLine([sapling, thyme]), /a birch sapling and a wild thyme wait here.*take them as seed/i);
  assert.deepEqual(crateTakeLines([], [sapling]), [keptLine([sapling])], 'nothing came: no "nothing waiting"');
  assert.ok(GATHERING_DATA.carriedPlants >= 1);
  assert.equal(CRATE_WORDS.takeYours, 'Take your things from the crate', 'Pell’s take-all choice keeps its words');
});

test('a carried plant is its own row in the pack, named whole, plantable, never given or used', () => {
  const view: ItemsView = {
    stacks: [{ itemDef: 'birch-sapling', qty: 2, maker: null }],
    instances: [],
    pockets: [],
    offHand: { open: false, class: null, itemDef: null, instance: null },
    pickedUp: [],
    thanks: [],
    carried: [],
    plants: [{ id: 'p1', itemDef: 'birch-sapling', plantedAt: 1000 }, { id: 'p2', itemDef: 'birch-sapling', plantedAt: 2000 }],
  };
  const entries = modelEntries(view, { pack: [], decorations: [] });
  const seeds = entries.find((e) => e.key === 'item:birch-sapling')!;
  assert.equal(seeds.qty, 2);
  assert.equal(seeds.carriedPlant, undefined);
  const plants = entries.filter((e) => e.carriedPlant);
  assert.deepEqual(plants.map((e) => e.key), ['plant:p1', 'plant:p2'], 'one row each, never stacked');
  const p = plants[0]!;
  assert.equal(p.id, 'birch-sapling');
  assert.equal(p.qty, 1);
  assert.equal(p.carriedPlant?.plantedAt, 1000);
  assert.match(p.name, /^Birch [Ss]apling, lifted whole$/);
  assert.equal(p.blurb, CARRIED_PLANT_WORDS.blurb);
  assert.equal(p.giveable, false);
  assert.equal(p.usable, false);
  assert.equal(p.pocketable, false);
  assert.match(CARRIED_PLANT_WORDS.planted('Birch sapling'), /^Your birch sapling is back in the ground/);
});
