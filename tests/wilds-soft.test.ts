import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN, fordLines, isWater, kept, largestPiece, openSides } from '../src/game/wilds/soft-tiles.ts';
import { paintGround, type GroundSource } from '../src/game/wilds/ground-paint.ts';
import { groundTable } from '../src/game/wilds/ground-table.ts';
import { wildsLook } from '../src/game/wilds/wilds-looks.ts';
import { TERRAIN } from '../src/lib/tile.ts';
import { wildsGround } from '../src/lib/wilds/data.ts';
import { fixtureTerrain, type FixtureName } from './wilds-fixture.ts';

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
  const wet = (x: number, _y: number) => x >= 10 && x <= 13;
  const all = fordLines([{ tx: 10, ty: 4 }], ford, wet, () => true);
  assert.deepEqual(all.map((s) => [s.tx, s.ty, s.across]).sort(), [[10, 5, true], [11, 5, true], [12, 5, true], [13, 5, true]]);
  // A chunk edge between x 11 and 12: each side places its own stones on the same line.
  const west = fordLines([{ tx: 10, ty: 4 }, { tx: 11, ty: 6 }], ford, wet, (x) => x <= 11);
  const east = fordLines([{ tx: 12, ty: 4 }], ford, wet, (x) => x >= 12);
  assert.deepEqual([...west, ...east].map((s) => `${s.tx},${s.ty}`).sort(), ['10,5', '11,5', '12,5', '13,5']);
  // A scrap of shallows in mid-river (water on every side) gets no stones.
  assert.deepEqual(fordLines([{ tx: 20, ty: 20 }], (x, y) => x === 20 && y === 20, () => true, () => true), []);
  assert.deepEqual(fordLines([{ tx: 20, ty: 20 }], (x, y) => x === 20 && y === 20, (x) => x >= 20, () => true), [], 'shallows touching only one bank get no crossing');
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


test('real generated fords show a connected line of stones through bends and across chunk edges', () => {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (const [names, start] of [
    [['ford-bend', 'ford-bend-east'], { tx: -75, ty: -61 }],
    [['ford-diagonal-west', 'ford-diagonal-east'], { tx: -97, ty: 43 }],
  ] as const) {
    const chunks = names.map((name: FixtureName) => fixtureTerrain(name));
    const tile = (tx: number, ty: number) => {
      const c = chunks.find((c) => Math.floor(tx / c.size) === c.cx && Math.floor(ty / c.size) === c.cy);
      return c ? { ground: c.ground[ty - c.cy * c.size]![tx - c.cx * c.size]!, solid: c.solid[ty - c.cy * c.size]![tx - c.cx * c.size]! } : null;
    };
    const ford = (tx: number, ty: number) => tile(tx, ty)?.ground === t('ford');
    const wet = (tx: number, ty: number) => {
      const g = tile(tx, ty)?.ground;
      return g === undefined || g === t('water') || g === t('ford');
    };
    const stones = fordLines([start], ford, wet, () => true);
    assert.ok(stones.length >= 4, `${names[0]}: the generated crossing must have visible stones`);
    const keys = new Set(stones.map((p) => `${p.tx},${p.ty}`));
    for (const p of stones) {
      assert.equal(ford(p.tx, p.ty), true, 'stones stay on the served ford');
      assert.equal(tile(p.tx, p.ty)?.solid, false, 'each stone is walkable');
    }
    const reached = new Set<string>();
    const stack = [stones[0]!];
    while (stack.length) {
      const p = stack.pop()!;
      const key = `${p.tx},${p.ty}`;
      if (reached.has(key)) continue;
      reached.add(key);
      for (const [dx, dy] of dirs) if (keys.has(`${p.tx + dx},${p.ty + dy}`)) stack.push({ ...p, tx: p.tx + dx, ty: p.ty + dy });
    }
    assert.equal(reached.size, stones.length, 'the stones form a continuous walk');
    const ends = stones.filter((p) => dirs.filter(([dx, dy]) => keys.has(`${p.tx + dx},${p.ty + dy}`)).length === 1);
    assert.equal(ends.length, 2, 'one line between the banks');
    for (const p of ends) assert.ok(dirs.some(([dx, dy]) => !wet(p.tx + dx, p.ty + dy)), 'the line reaches dry ground');
    const split = chunks.flatMap((c) => {
      const inside = (tx: number, ty: number) => Math.floor(tx / c.size) === c.cx && Math.floor(ty / c.size) === c.cy;
      return fordLines(stones.filter((p) => inside(p.tx, p.ty)), ford, wet, inside);
    });
    const sorted = (xs: typeof stones) => xs.map((p) => `${p.tx},${p.ty},${p.across}`).sort();
    assert.deepEqual(sorted(split), sorted(stones), 'chunks agree on the whole crossing');
    assert.deepEqual(sorted(fordLines([stones.at(-1)!], ford, wet, () => true)), sorted(stones), 'the seed does not change the line');
  }
});

test('a shallow-angle crossing wider than the old 256-tile cap keeps its complete stone path', () => {
  // Current content allows a four-tile river and a three-tile ford band.
  // A near-parallel route runs from (1,0) to (3,100): their overlap exceeds
  // 256 tiles despite those small widths. It meets the two banks far apart.
  const ford = (tx: number, ty: number) => tx >= 0 && tx < 4 && ty >= 0 && ty <= 100 && Math.abs(tx + 0.5 - (1 + ty / 50)) <= 1.5;
  const wet = (tx: number, _ty: number) => tx >= 0 && tx < 4;
  const seeds = [];
  for (let ty = 0; ty <= 100; ty++) for (let tx = 0; tx < 4; tx++) if (ford(tx, ty)) seeds.push({ tx, ty });
  assert.ok(seeds.length > 256);
  const stones = fordLines([seeds[0]!], ford, wet, () => true);
  assert.ok(stones.length > 0, 'the large crossing has stones');
  assert.ok(stones.some((p) => p.tx === 0), 'the west bank is reached');
  assert.ok(stones.some((p) => p.tx === 3), 'the east bank is reached');
  const sorted = (xs: typeof stones) => xs.map((p) => `${p.tx},${p.ty},${p.across}`).sort();
  assert.deepEqual(sorted(fordLines([seeds.at(-1)!], ford, wet, () => true)), sorted(stones), 'both ends choose the same complete component');
});
