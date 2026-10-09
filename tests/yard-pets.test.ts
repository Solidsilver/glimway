import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_LAND } from './land-fixture.ts';
import { BLOCK_S, SEGMENT_MAX_S, SEGMENT_MIN_S, WALK_PX_S, blockSegments, yardPetAt, yardTiles, type YardHome } from '../src/lib/yard-pets.ts';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';
import { LAND, effectiveKind, homeLights, isLit } from '../src/lib/homestead-land.ts';
import { TILE, tileAt } from '../src/lib/tile.ts';

const home: YardHome = { landSeed: 1234, cleared: [], items: [] };
const tiles = yardTiles(home, FIXTURE_LAND);
const lights = homeLights([]);

test('yard pets: there are lit, walkable tiles to wander, and nap spots beside a tree or the cottage', () => {
  assert.ok(tiles.walk.length > 0);
  assert.ok(tiles.nap.length > 0 && tiles.nap.length <= tiles.walk.length);
  const site = HOMESTEAD_DATA.land.site;
  for (const [x, y] of tiles.walk) {
    assert.ok(isLit(lights, x, y), `unlit ${x},${y}`);
    const k = effectiveKind(FIXTURE_LAND, new Set(), x, y);
    assert.ok(k === LAND.GRASS || k === LAND.PATH, `solid ${x},${y}`);
    assert.ok(!(x >= site.x && x < site.x + site.w && y >= site.y && y < site.y + site.h), 'never inside the cottage');
  }
});

test('yard pets: where a pet is depends only on the seed, the pet, its slot and the clock', () => {
  const t0 = 1_791_000_000;
  for (let s = 0; s < 400; s++) {
    const now = t0 + s * 7.3;
    assert.deepEqual(yardPetAt(yardTiles(home, FIXTURE_LAND), 'Cat-Siamese', 1, now), yardPetAt(tiles, 'Cat-Siamese', 1, now));
  }
  const a = yardPetAt(tiles, 'Cat-Siamese', 1, t0);
  const b = yardPetAt(tiles, 'Owl-Spooky', 2, t0);
  const c = yardPetAt(yardTiles({ ...home, landSeed: 99 }, FIXTURE_LAND), 'Cat-Siamese', 1, t0);
  assert.ok(JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(a) !== JSON.stringify(c), 'different pets and seeds wander differently');
});

test('yard pets: a pet never stands on (or targets) an unlit or solid tile, and never jumps', () => {
  const walk = new Set(tiles.walk.map(([x, y]) => `${x},${y}`));
  const t0 = 1_791_000_000 - 3 * BLOCK_S;
  let prev = yardPetAt(tiles, 'Fox-Golden', 3, t0)!;
  const naps = { n: 0 };
  for (let s = 1; s < 6 * BLOCK_S; s++) {
    const p = yardPetAt(tiles, 'Fox-Golden', 3, t0 + s)!;
    if (p.pose !== 'walk') assert.ok(walk.has(`${tileAt(p.x)},${tileAt(p.y)}`), `at rest off the walkable ground: ${p.x},${p.y}`);
    if (p.pose === 'nap') naps.n++;
    // At most a walking second's worth of ground between two seconds (no teleports, block edges included).
    assert.ok(Math.hypot(p.x - prev.x, p.y - prev.y) <= WALK_PX_S + 0.001, `jumped at ${s}`);
    prev = p;
  }
  assert.ok(naps.n > 0, 'some segments are naps');
});

test('yard pets: segments last 30 to 90 s and fill each block exactly', () => {
  for (let block = 2_980_000; block < 2_980_200; block++) {
    const segs = blockSegments(tiles, 'Cat-Siamese', 1, block);
    assert.equal(segs[0].start, block * BLOCK_S);
    assert.equal(segs.at(-1)!.end, (block + 1) * BLOCK_S);
    for (const [i, s] of segs.entries()) {
      assert.ok(s.end - s.start >= SEGMENT_MIN_S && s.end - s.start <= SEGMENT_MAX_S, `${s.end - s.start}`);
      if (i > 0) assert.equal(s.start, segs[i - 1].end);
    }
  }
});

test('yard pets: nowhere lit to stand is nowhere', () => {
  assert.equal(yardPetAt({ seed: 1, walk: [], nap: [] }, 'Cat-Siamese', 1, 0), null);
  assert.equal(TILE, 16);
});
