import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng, fnv1a32, fnv1a32Bytes, hash01, layoutHash01, rng01 } from '../src/lib/hash.ts';

/**
 * src/lib/hash.ts replaced the private hash and noise copies that the game
 * files kept. Layouts and art are seed-deterministic, so each replacement
 * must give exactly the old numbers: the old copies are kept here, verbatim,
 * as the reference.
 */

// ---- the old copies, verbatim

/** worlds.ts mulberry32 (and lib/wilds/gen-v1.ts, lib/wilds/outer.ts). */
function oldMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** wilds/tangle-art.ts seeded. */
function oldSeeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** area/ground-field.ts hash01 and wilds/tangle-art.ts h01. */
function oldImulH01(x: number, y: number, s = 0): number {
  let v = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791)) | 0;
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

/** commons-art.ts and mill-art.ts h01 (multiplies without Math.imul). */
function oldDriftedH01(x: number, y: number, s = 0): number {
  let v = (x * 73856093) ^ (y * 19349663) ^ (s * 83492791);
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

/** commons.ts hash and homeland.ts h32. */
function oldLayoutHash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** wilds/tangle-art.ts strHash (FNV-1a over UTF-16 code units). */
function oldStrHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** area/terrain.ts and scenes/world-dev-hooks.ts texture hashes. */
function oldBytesHash(d: ArrayLike<number>): number {
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
  return h >>> 0;
}

// ---- samples

const seeds = [0, 1, 2, 7, 42, 0x51ed270b, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff, 123456789, 2 ** 31 + 5];
const coords: number[] = [];
for (let i = -40; i <= 300; i++) coords.push(i);
coords.push(511, 1024, 4096, 65535);

test('rng01 is the mulberry32 the worlds and the Tangle art used', () => {
  for (const seed of seeds) {
    const a = rng01(seed);
    const b = oldMulberry32(seed);
    const c = oldSeeded(seed);
    for (let i = 0; i < 500; i++) {
      const v = a();
      assert.equal(v, b(), `seed ${seed} step ${i}`);
      assert.equal(v, c());
    }
  }
  // The float stream is Rng's integers over 2^32.
  const r = new Rng(99);
  const f = rng01(99);
  for (let i = 0; i < 20; i++) assert.equal(f(), r.next() / 2 ** 32);
});

test('hash01 is the ground field and Tangle art speckle, and the drifted commons/mill copy on integers', () => {
  for (const s of [0, 1, 2, 3, 5, 7, 11, 21, 33, 0x51ed270b]) {
    for (const x of coords) {
      for (let y = -8; y < 80; y += 3) {
        const v = hash01(x, y, s);
        assert.equal(v, oldImulH01(x, y, s));
        if (s < 1000) assert.equal(v, oldDriftedH01(x, y, s), `drifted ${x},${y},${s}`);
      }
    }
  }
  // Fractions truncate, as the imul copies did.
  assert.equal(hash01(3.7, -2.2, 1.9), oldImulH01(3.7, -2.2, 1.9));
});

test('layoutHash01 is the Commons and homeland layout hash, for every land seed', () => {
  for (const seed of seeds) {
    for (const x of coords.slice(0, 120)) {
      for (let y = 0; y < 60; y++) {
        for (const s of [seed, (seed * 3 + 1) >>> 0, seed % 10]) assert.equal(layoutHash01(x, y, s), oldLayoutHash(x, y, s));
      }
    }
  }
});

test('fnv1a32 is the Tangle art string hash on ids, and fnv1a32Bytes the texture hash', () => {
  for (const id of ['', 'wilds', 'wilds:outer-1:3,-2', 'oak', 'tangle-decor', 'birch-snag', 'A_b-9:z', 'home:12']) {
    assert.equal(fnv1a32(id), oldStrHash(id));
  }
  const bytes = new Uint8ClampedArray(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + (i >> 3)) & 255;
  assert.equal(fnv1a32Bytes(bytes), oldBytesHash(bytes));
  assert.equal(fnv1a32Bytes([]), oldBytesHash([]));
});
