import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serializeHomesteadVectors } from '../scripts/homestead-vectors.ts';
import { HOMESTEAD_DATA, checkPlacement, checkRemoval, cleanPostName, gateTile, parseHomeArea, type HomeInstance } from '../src/lib/homestead.ts';
import { LAND, generateLand, landAt, landSeed, postCost } from '../src/lib/homestead-land.ts';

test('committed homestead land vectors match the TypeScript generator', () => {
  assert.equal(
    readFileSync(new URL('../content/vectors/homestead.json', import.meta.url), 'utf8'),
    serializeHomesteadVectors(),
    'Run npm run vectors:homestead after intentional generator changes',
  );
});

test('every land keeps its home site, path and gate mouth clear', () => {
  const { site, gate } = HOMESTEAD_DATA.land;
  for (const world of ['guest', 'w1', 'w2']) {
    for (let g = 0; g < 40; g++) {
      const land = generateLand(landSeed(world, g));
      for (let y = site.y; y < site.y + site.h; y++) for (let x = site.x; x < site.x + site.w; x++) assert.equal(landAt(land, x, y), LAND.GRASS);
      for (let y = site.y + site.h; y < land.height; y++) for (let x = gate.x; x < gate.x + gate.w; x++) assert.equal(landAt(land, x, y), LAND.PATH);
    }
  }
});

test('lands differ by gate and by world', () => {
  const a = generateLand(landSeed('w1', 0)).tiles.join('');
  assert.notEqual(a, generateLand(landSeed('w1', 1)).tiles.join(''));
  assert.notEqual(a, generateLand(landSeed('w2', 0)).tiles.join(''));
});

test('lantern posts cost more each time', () => {
  const total = (n: number) => Object.values(postCost(n)).reduce((a, b) => a + b, 0);
  for (let n = 1; n < 8; n++) assert.ok(total(n) > total(n - 1));
});

test('gates alternate sides down the lane and home areas parse', () => {
  assert.deepEqual(gateTile(0), { tx: HOMESTEAD_DATA.commons.fenceX[0], ty: HOMESTEAD_DATA.commons.gateRows[0], side: 'west' });
  assert.equal(gateTile(1).side, 'east');
  const last = HOMESTEAD_DATA.commons.gateRows.at(-1)!;
  assert.equal(gateTile(HOMESTEAD_DATA.commons.gateRows.length * 2).ty, last + HOMESTEAD_DATA.commons.rowPitch);
  assert.equal(parseHomeArea('home:12'), 12);
  for (const bad of ['home:', 'home:01', 'home:-1', 'home:1x', 'commons', 'home:99999']) assert.equal(parseHomeArea(bad), null);
});

const post = (id: string, x: number | null, y: number | null): HomeInstance => ({ id, itemDef: 'lantern-post', scene: x === null ? null : 'outdoor', x, y, rotation: x === null ? null : 0, name: 'Ada’s Lamp' });

test('placement outdoors needs lit, open ground and posts hold up the land past them', () => {
  const s = HOMESTEAD_DATA.land.startLight;
  const stool: HomeInstance = { id: 's', itemDef: 'wooden-stool', scene: null, x: null, y: null, rotation: null };
  const home = { tier: 0, items: [stool] as HomeInstance[] };
  // Inside the home's light, off the reserved site and path.
  assert.equal(checkPlacement(home, stool, 'outdoor', s.x + 3, s.y + 3, 0), null);
  const far = s.x + s.radius + 4;
  assert.equal(checkPlacement(home, stool, 'outdoor', far, s.y, 0), 'unlit');
  // A post at the edge of the light lights the ground beyond it.
  const p1 = post('p1', s.x + s.radius, s.y);
  const lit = { tier: 0, items: [stool, p1] };
  assert.equal(checkPlacement(lit, stool, 'outdoor', far, s.y, 0), null);
  assert.equal(checkPlacement({ tier: 0, items: [stool] }, post('p2', null, null), 'outdoor', far + 2, s.y, 0), 'unlit');
  // Something standing only in a post's light keeps that post where it is.
  const placed = { ...stool, scene: 'outdoor' as const, x: far, y: s.y, rotation: 0 as const };
  assert.equal(checkRemoval({ items: [placed, p1] }, p1), 'post-holds-land');
  assert.equal(checkPlacement({ tier: 0, items: [placed, p1] }, p1, 'outdoor', s.x - 3, s.y + 3, 0), 'post-holds-land');
  // Obstacles block until cleared.
  const land = generateLand(landSeed('guest', 0));
  let tree: [number, number] | null = null;
  for (let y = 0; y < land.height && !tree; y++) for (let x = 0; x < land.width && !tree; x++) if (landAt(land, x, y) === LAND.TREE && (x - s.x) ** 2 + (y - s.y) ** 2 <= s.radius ** 2) tree = [x, y];
  if (tree) {
    assert.equal(checkPlacement(home, stool, 'outdoor', tree[0], tree[1], 0, HOMESTEAD_DATA, { land, cleared: new Set() }), 'land-blocked');
    assert.equal(checkPlacement(home, stool, 'outdoor', tree[0], tree[1], 0, HOMESTEAD_DATA, { land, cleared: new Set([`${tree[0]},${tree[1]}`]) }), null);
  }
});

test('post names are tidied and bounded', () => {
  assert.equal(cleanPostName('  The   Wren  '), 'The Wren');
  assert.equal(cleanPostName('   '), null);
  assert.equal(cleanPostName('x'.repeat(HOMESTEAD_DATA.lanternPosts.nameMax + 1)), null);
  assert.equal(cleanPostName('bell\u0007'), null);
});

test('posts cannot hold each other up away from the home’s light (review finding 2)', () => {
  const s = HOMESTEAD_DATA.land.startLight;
  const r = HOMESTEAD_DATA.lanternPosts.radius;
  const { width: W, height: H } = HOMESTEAD_DATA.land;
  const d2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2;
  const reserved = (x: number, y: number) => HOMESTEAD_DATA.outdoorReserved.some((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
  for (let seed = 1; seed < 400; seed++) {
    const land = generateLand(seed);
    const ground = { land, cleared: new Set<string>() };
    const open = (x: number, y: number) => landAt(land, x, y) === LAND.GRASS && !reserved(x, y);
    for (let ax = 1; ax < W - 1; ax++)
      for (let ay = 1; ay < H - 1; ay++) {
        const da = d2(ax, ay, s.x, s.y);
        if (da > s.radius ** 2 || da <= (s.radius - 1) ** 2 || !open(ax, ay)) continue;
        for (let bx = 1; bx < W - 1; bx++)
          for (let by = 1; by < H - 1; by++) {
            if (d2(bx, by, ax, ay) > r * r || d2(bx, by, s.x, s.y) <= s.radius ** 2 || !open(bx, by)) continue;
            for (let cx = 1; cx < W - 1; cx++)
              for (let cy = 1; cy < H - 1; cy++) {
                if ((cx === bx && cy === by) || d2(cx, cy, bx, by) > r * r || d2(cx, cy, s.x, s.y) <= s.radius ** 2 || d2(cx, cy, ax, ay) <= r * r || !open(cx, cy)) continue;
                const a = post('a', ax, ay);
                const b = post('b', bx, by);
                // A walks off to ground lit only by B, which only A lit: refused.
                assert.equal(checkPlacement({ tier: 1, items: [a, b] }, a, 'outdoor', cx, cy, 0, HOMESTEAD_DATA, ground), 'unlit');
                // A chain back to the home's light still extends it.
                assert.equal(checkPlacement({ tier: 1, items: [a] }, post('b', null, null), 'outdoor', bx, by, 0, HOMESTEAD_DATA, ground), null);
                return;
              }
          }
      }
  }
  assert.fail('no land with the floating-pair layout');
});
