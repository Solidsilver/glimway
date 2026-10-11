import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN, fordLines, isWater, kept, largestPiece, openSides } from '../src/game/wilds/soft-tiles.ts';
import { paintGround, type GroundSource } from '../src/game/wilds/ground-paint.ts';
import { groundTable } from '../src/game/wilds/ground-table.ts';
import { wildsLook } from '../src/game/wilds/wilds-looks.ts';
import { TERRAIN } from '../src/lib/tile.ts';
import { wildsGround } from '../src/lib/wilds/data.ts';

const t = (id: string) => (TERRAIN as Record<string, number>)[wildsGround(id).terrain]!;

test('a road tile’s open sides: neighbours off the road, and inner corners only where both sides stay paved', () => {
  const road = new Set(['0,0', '1,0', '0,1', '1,1', '2,1']);
  const same = (x: number, y: number) => road.has(`${x},${y}`);
  assert.equal(openSides(0, 0, same), OPEN.n | OPEN.w);
  assert.equal(openSides(1, 1, same), OPEN.s | OPEN.ne, 'south is open; north and east stay paved, so (2,0) off the road is an inner corner');
  assert.equal(openSides(1, 0, same) & OPEN.se, 0, 'a corner beside an open side is that side’s');
  const inner = new Set(['0,0', '1,0', '0,1']);
  assert.equal(openSides(0, 0, (x, y) => inner.has(`${x},${y}`)) & OPEN.se, OPEN.se, 'an inner corner');
});

test('worn edges: the middle of a tile always stays, an open side breaks away within half a tile, a closed tile is whole', () => {
  for (let n = 0; n <= 1; n += 0.25) {
    assert.equal(kept(0.5, 0.5, OPEN.n | OPEN.e | OPEN.s | OPEN.w, n, null), true, 'the middle stays');
    assert.equal(kept(0.5, 0.02, OPEN.n, n, null), false, 'the very edge goes');
    assert.equal(kept(0.5, 0.02, 0, n, null), true, 'no open side: whole');
  }
  assert.equal(kept(0.5, 0.5, 0, 0.5, 0.9), false, 'wear wears through where its noise is high');
  assert.equal(kept(0.5, 0.5, 0, 0.5, 0.2), true);
});

test('a ford’s stones: one line down the middle of the crossing, across the river’s whole width, agreed across a chunk edge', () => {
  // A river four tiles wide (x 10..13) running north-south; a route crosses
  // east-west, and its ford is three rows deep (y 4..6).
  const ford = (x: number, y: number) => x >= 10 && x <= 13 && y >= 4 && y <= 6;
  const wet = (x: number, y: number) => x >= 10 && x <= 13;
  const all = fordLines([{ tx: 10, ty: 4 }], ford, wet, () => true);
  assert.deepEqual(all.map((s) => [s.tx, s.ty, s.across]).sort(), [[10, 5, true], [11, 5, true], [12, 5, true], [13, 5, true]]);
  // A chunk edge between x 11 and 12: each side places its own stones on the same line.
  const west = fordLines([{ tx: 10, ty: 4 }, { tx: 11, ty: 6 }], ford, wet, (x) => x <= 11);
  const east = fordLines([{ tx: 12, ty: 4 }], ford, wet, (x) => x >= 12);
  assert.deepEqual([...west, ...east].map((s) => `${s.tx},${s.ty}`).sort(), ['10,5', '11,5', '12,5', '13,5']);
  // A scrap of shallows in mid-river (water on every side) gets no stones.
  assert.deepEqual(fordLines([{ tx: 20, ty: 20 }], (x, y) => x === 20 && y === 20, () => true, () => true), []);
  // A north-south crossing of an east-west river.
  const fordV = (x: number, y: number) => y >= 10 && y <= 12 && x >= 3 && x <= 5;
  const v = fordLines([{ tx: 3, ty: 10 }], fordV, (_x, y) => y >= 10 && y <= 12, () => true);
  assert.deepEqual(v.map((s) => [s.tx, s.ty, s.across]).sort(), [[4, 10, false], [4, 11, false], [4, 12, false]]);
});

test('a ford stone is cut out of its water: the water keyed out, stray specks dropped', () => {
  assert.equal(isWater(30, 59, 55), true);
  assert.equal(isWater(123, 116, 101), false, 'a stone');
  const T = 6;
  const mask = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const keep = largestPiece(mask, T);
  assert.equal(keep.reduce((a, b) => a + b, 0), 7, 'the big stone');
  assert.equal(keep[0], 0, 'a speck goes');
  assert.equal(keep[35], 0);
});

test('the ground has no tile squares: a verge in meadow paints meadow grass, and trodden earth ends round, not on tile lines', () => {
  // Meadow all round, one row of verge (a route's edge) and a single trodden tile.
  const ground = (tx: number, ty: number) => (ty === 10 ? t('verge') : tx === 5 && ty === 5 ? t('trodden') : t('meadow'));
  const src: GroundSource = { ground, solid: () => false };
  const G = wildsLook('tangle', null).ground;
  const out = new Uint8ClampedArray(384 * 384 * 4);
  paintGround(out, 0, 0, 384, 384, src, G, 1234, groundTable());
  const at = (x: number, y: number) => { const i = (y * 384 + x) * 4; return [out[i]!, out[i + 1]!, out[i + 2]!].join(','); };
  const meadow = new Set(G.meadow.map((c) => c.join(',')));
  const moss = new Set(G.moss.map((c) => c.join(',')));
  let m = 0;
  let o = 0;
  for (let x = 40; x < 340; x++) {
    const c = at(x, 10 * 16 + 8);
    if (meadow.has(c)) m++;
    if (moss.has(c)) o++;
  }
  assert.ok(m > o * 3, `the verge row is mostly meadow (${m} meadow, ${o} moss)`);
  // The trodden tile: its middle is earth, its corners are grass (a round patch, not a square).
  const trodden = new Set(G.trodden.map((c) => c.join(',')));
  assert.ok(trodden.has(at(5 * 16 + 8, 5 * 16 + 8)) || !meadow.has(at(5 * 16 + 8, 5 * 16 + 8)), 'earth in the middle');
  let cornersGrass = 0;
  for (const [x, y] of [[80, 80], [95, 80], [80, 95], [95, 95]] as const) if (!trodden.has(at(x, y))) cornersGrass++;
  assert.ok(cornersGrass >= 3, 'the corners are grass');
});
