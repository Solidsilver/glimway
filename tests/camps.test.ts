import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '@bufbuild/protobuf';
import { CampViewSchema, CampPieceSchema, CampPlantSchema } from '../src/lib/gen/glimway/v1/camps_pb.js';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';
import { CAMP_PACK_WORDS, campAtTile, campFrame, campHasRoom, campLines, campLook, campPlantLines, campSpot, campTaken, collectedLine, crateLines } from '../src/lib/camps.ts';
import { uprootedLine } from '../src/lib/trowel.ts';
import { homeErrorText } from '../src/content/errors.ts';

const W = HOMESTEAD_DATA.wayLamp;

const camp = (o: Partial<{ id: string; cx: number; cy: number; x: number; y: number; oil: number; dimming: boolean; setterId: string; setterName: string }> = {}) =>
  create(CampViewSchema, {
    id: 'lamp', cx: 2, cy: -4, x: 60, y: -84, oil: 1, dimming: false, setterId: 'alice', setterName: 'Alice', builder: true,
    pieces: [create(CampPieceSchema, { id: 'lamp', itemDef: W.item, x: 60, y: -84, rotation: 0, ownerId: 'alice' }), create(CampPieceSchema, { id: 'bench', itemDef: 'raised-bed', x: 62, y: -84, rotation: 90, ownerId: 'alice' })],
    plants: [create(CampPlantSchema, { id: 'p', itemDef: 'birch-sapling', x: 58, y: -82, ownerId: 'alice' })],
    ...o
  });

test('way-lamp rules: a camp-only piece, hearth oil, three wicks, one a flask', () => {
  assert.equal(W.item, 'way-lamp');
  assert.equal(W.oil, 'hearth-oil');
  assert.equal(W.maxWicks, 3);
  assert.equal(W.wicksPerOil, 1);
  const def = HOMESTEAD_DATA.items.find((i) => i.id === W.item);
  assert.deepEqual(def?.where, ['camp'], 'set as a lamp, never arranged as a piece');
  assert.equal(def?.craftOnly, true);
});

test('a camp is found by the chunk a tile lies in, negative chunks included', () => {
  const c = camp();
  assert.equal(campAtTile([c], 48, -96), c, 'the chunk’s first tile');
  assert.equal(campAtTile([c], 71, -73), c, 'its last');
  assert.equal(campAtTile([c], 72, -84), null);
  assert.equal(campAtTile([c], 60, -97), null);
});

test('what stands at a camp: pieces by their turned footprint, and plants', () => {
  const taken = campTaken(camp());
  assert.ok(taken.has('60,-84'), 'the lamp');
  assert.ok(taken.has('58,-82'), 'the sapling');
  const bench = HOMESTEAD_DATA.items.find((i) => i.id === 'raised-bed')!;
  assert.notEqual(bench.footprint[0], bench.footprint[1]);
  const [w, h] = [bench.footprint[1], bench.footprint[0]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.ok(taken.has(`${62 + x},${-84 + y}`));
});

test('a spot beside the hero: the open tile above first, never across the chunk edge or on something', () => {
  const open = () => true;
  assert.deepEqual(campSpot({ tx: 60, ty: -80 }, open), { tx: 60, ty: -81 });
  assert.deepEqual(campSpot({ tx: 60, ty: -80 }, open, new Set(['60,-81'])), { tx: 59, ty: -80 });
  // On the chunk's top row the tile above is the next chunk's.
  assert.deepEqual(campSpot({ tx: 60, ty: -96 }, open), { tx: 59, ty: -96 });
  assert.equal(campSpot({ tx: 60, ty: -80 }, () => false), null);
});

test('the lamp’s looks and readouts: burning, empty, guttering; whose it is; room for a flask', () => {
  assert.equal(campLook(camp()), 'lit');
  assert.equal(campLook(camp({ dimming: true, oil: 0 })), 'dimming');
  assert.equal(campLook(camp({ oil: 0 })), 'dimming', 'the last wick is dimming');
  assert.equal(campLook(camp({ oil: 1 })), 'lit');
  assert.equal(campFrame('lit'), 'way-lamp-1');
  assert.equal(campFrame('dimming'), 'way-lamp-2');
  assert.match(campLines(camp({ oil: 2 }), 'alice')[0]!, /^Your way-lamp\. It burns, 2 of 3 wicks/);
  assert.match(campLines(camp({ oil: 0 }), 'bob')[0]!, /^Alice’s way-lamp\. It’s dimming: .*last wick.*gutters for a wick/);
  assert.match(campLines(camp({ oil: 0, dimming: true }), 'bob')[0]!, /guttering.*Pell’s/);
  assert.equal(campHasRoom(camp({ oil: 2 })), true);
  assert.equal(campHasRoom(camp({ oil: 3 })), false);
});

test('Pell’s words: what the crate holds, and what was signed out', () => {
  const entries = [{ itemDef: 'way-lamp', qty: 1 }, { itemDef: 'birch-sapling', qty: 1 }, { itemDef: 'stone', qty: 3 }];
  const lines = crateLines(entries);
  assert.equal(lines[0], 'The woods turned. I have your things.');
  assert.match(lines[1]!, /a way-lamp, a birch sapling and 3 [Ss]tone/);
  assert.deepEqual(crateLines([]), []);
  assert.match(collectedLine(entries), /^Signed out to you: /);
  assert.match(collectedLine([]), /Nothing waiting/);
});

test('taking a camp apart: a plant dug up, the whole camp packed up (review B7)', () => {
  assert.deepEqual(campPlantLines('Turncap spawn', null), ['Your turncap spawn, growing in the lamp’s light.']);
  assert.deepEqual(campPlantLines('Turncap spawn', 'Bob'), ['Bob’s turncap spawn, growing in the lamp’s light.']);
  assert.equal(uprootedLine('Turncap spawn'), 'You lift the turncap spawn whole, roots and all. It’s in your pack, ready to plant again.');
  assert.equal(CAMP_PACK_WORDS.pack.text, 'Pack up the camp');
  assert.match(CAMP_PACK_WORDS.ask.join(' '), /Nothing is lost/);
  // The refusal to take a lamp down over a camp points at packing it up.
  assert.match(homeErrorText('camp-not-empty'), /pack up the whole camp/);
});
