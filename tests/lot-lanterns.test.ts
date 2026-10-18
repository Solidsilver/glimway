import test from 'node:test';
import assert from 'node:assert/strict';
import { HOMESTEAD_DATA, checkPlacement, checkRemoval, type HomeInstance } from '../src/lib/homestead.ts';
import { backlandAt, backlandAtPixel, backlandChunk, inBackland, lanternStake, lotAt, lotLit } from '../src/lib/lots.ts';
import { lanternFrame, lanternHasRoom, lanternLines, lanternLook } from '../src/lib/lot-lantern.ts';

const R = HOMESTEAD_DATA.lotLantern;

test('lot lantern rules: hearth oil, three wicks, one a flask, on a back-line stake', () => {
  assert.equal(R.oil, 'hearth-oil');
  assert.equal(R.maxWicks, 3);
  assert.equal(R.wicksPerOil, 1);
  assert.ok(R.stakeY >= 2 && R.stakeY <= 20 && R.stakeY % 2 === 0, 'the layouts put stakes on even rows 2..20');
});

test('lantern states: dark, lit, dimming; their stake frames and readouts', () => {
  assert.equal(lanternLook(null), 'dark');
  assert.equal(lanternLook({ lit: false, oil: 0, dimming: false }), 'dark');
  assert.equal(lanternLook({ lit: true, oil: 2, dimming: false }), 'lit');
  assert.equal(lanternLook({ lit: true, oil: 0, dimming: true }), 'dimming');
  assert.equal(lanternLook({ lit: true, oil: 0, dimming: false }), 'dimming', 'the last wick is dimming');
  assert.equal(lanternFrame('dark'), 'lantern-stake-0');
  assert.equal(lanternFrame('lit'), 'lantern-stake-1');
  assert.equal(lanternFrame('dimming'), 'lantern-stake-2');
  assert.match(lanternLines(null, 3, 'West Row 1')[0]!, /dark/);
  assert.match(lanternLines({ lit: true, oil: 2, dimming: false }, 3, 'West Row 1')[0]!, /2 of 3 wicks/);
  assert.match(lanternLines({ lit: true, oil: 0, dimming: false }, 3, 'West Row 1')[0]!, /is dimming: .*last wick.*gutters for a wick/);
  assert.match(lanternLines({ lit: true, oil: 0, dimming: true }, 3, 'West Row 1')[0]!, /goes dark at the turning/);
});

test('a lantern takes a flask while there is room for its wicks', () => {
  assert.ok(lanternHasRoom(null, 3, 1));
  assert.ok(lanternHasRoom({ lit: true, oil: 2, dimming: false }, 3, 1));
  assert.ok(!lanternHasRoom({ lit: true, oil: 3, dimming: false }, 3, 1));
  assert.ok(lanternHasRoom({ lit: false, oil: 3, dimming: false }, 3, 1), 'a dark lantern starts empty');
});

test('backland geometry: the chunk behind each lot, stored lot-local past it', () => {
  for (let g = 0; g < 8; g++) {
    const { cx, cy } = backlandChunk(g);
    assert.equal(cx, g % 2 ? 3 : -3);
    assert.equal(backlandAt(cx, cy), g);
    assert.equal(lotAt(g % 2 ? 2 : -2, cy), g);
    assert.equal(backlandAtPixel(cx * 24 * 16 + 40, cy * 24 * 16 + 40), g);
    assert.deepEqual(lanternStake(g, 12), { x: g % 2 ? 23 : 0, y: 12 });
  }
  assert.equal(backlandAt(-2, 1), null);
  assert.equal(backlandAt(-3, 0), null);
  assert.ok(inBackland(-24, 0, 0) && inBackland(-1, 23, 0) && !inBackland(0, 5, 0) && !inBackland(24, 5, 0));
  assert.ok(inBackland(24, 0, 1) && inBackland(47, 23, 1) && !inBackland(23, 5, 1) && !inBackland(-1, 5, 1));
});

test('lotLit: the lot proper always, the backland only while the lantern burns', () => {
  assert.ok(lotLit(5, 5, 0, false));
  assert.ok(!lotLit(0, 5, 0, true), 'the lantern line itself stays public');
  assert.ok(!lotLit(-5, 5, 0, false));
  assert.ok(lotLit(-5, 5, 0, true));
  assert.ok(lotLit(30, 5, 1, true));
  assert.ok(!lotLit(-5, 5, 1, true), 'an east lot has no backland to the west');
});

const piece = (id: string, itemDef: string, at?: [number, number]): HomeInstance =>
  at ? { id, itemDef, scene: 'outdoor', x: at[0], y: at[1], rotation: 0, name: null } : { id, itemDef, scene: null, x: null, y: null, rotation: null, name: null };

test('placing in the backland: refused while dark, the lantern lights it all, posts and the stable stay home', () => {
  const home = { gate: 0, tier: 2, items: [] as HomeInstance[], plants: [] };
  const stool = piece('s', 'wooden-stool');
  const open = () => true;
  assert.equal(checkPlacement(home, stool, 'outdoor', -10, 10, 0), 'unlit');
  assert.equal(checkPlacement(home, stool, 'outdoor', -10, 10, 0, HOMESTEAD_DATA, undefined, open), null);
  assert.equal(checkPlacement(home, stool, 'outdoor', -10, 10, 0, HOMESTEAD_DATA, undefined, (x, y) => !(x === -10 && y === 10)), 'land-blocked');
  assert.equal(checkPlacement({ ...home, gate: 1 }, stool, 'outdoor', 30, 10, 0, HOMESTEAD_DATA, undefined, open), null);
  assert.equal(checkPlacement({ ...home, gate: 1 }, stool, 'outdoor', -10, 10, 0, HOMESTEAD_DATA, undefined, open), 'out-of-bounds');
  assert.equal(checkPlacement(home, piece('p', HOMESTEAD_DATA.lanternPosts.item), 'outdoor', -10, 10, 0, HOMESTEAD_DATA, undefined, open), 'land-blocked');
  assert.equal(checkPlacement(home, piece('b', HOMESTEAD_DATA.stable.item), 'outdoor', -10, 10, 0, HOMESTEAD_DATA, undefined, open), 'land-blocked');
  // Overlaps count out there as on the lot.
  const placed = { ...home, items: [piece('t', 'wooden-stool', [-10, 10])] };
  assert.equal(checkPlacement(placed, stool, 'outdoor', -10, 10, 0, HOMESTEAD_DATA, undefined, open), 'placement-overlap');
});

test('a post never holds up the backland: its pieces stand in the lantern light', () => {
  const post = piece('p', HOMESTEAD_DATA.lanternPosts.item, [12, 14]);
  const home = { items: [post, piece('t', 'wooden-stool', [-10, 10])] };
  assert.equal(checkRemoval(home, post), null);
});
