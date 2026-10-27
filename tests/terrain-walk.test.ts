import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeSurface, emptySurface, CLIFF } from '../src/game/terrain/surface.ts';
import { TerrainStore } from '../src/game/terrain/store.ts';
import { fits, moveFeet, nearestWalkable, sweep, type Feet } from '../src/game/terrain/walk.ts';

const vectors = JSON.parse(readFileSync(new URL('../content/vectors/slopes-surface.json', import.meta.url), 'utf8')) as { chunks: { name: string; cx: number; cy: number; b64: string }[] };
const surf = (name: string) => {
  const v = vectors.chunks.find((c) => c.name === name)!;
  return { ...v, s: decodeSurface(Uint8Array.from(Buffer.from(v.b64, 'base64'))) };
};
const never = () => Promise.reject(new Error('no fetch in tests'));

/** A flat chunk at (0,0) rising evenly eastward: `rise` 1/256 levels a tile. */
function ramp(rise: number) {
  const s = emptySurface(24, 24);
  for (let y = 0; y <= 24; y++) for (let x = 0; x <= 24; x++) s.corners[y * 25 + x] = x * rise;
  return s;
}

test('field-space walking: open slopes walk, unknown ground is closed', () => {
  const t = new TerrainStore(never);
  t.put(0, 0, ramp(32));
  const w: Feet = { x: 8, y: 200, hw: 5, fh: 4 };
  moveFeet(t, w, 100, 0);
  assert.ok(Math.abs(w.x - 108) < 1e-9);
  // East of the chunk nothing is known: closed.
  const e: Feet = { x: 24 * 16 - 8, y: 200, hw: 5, fh: 4 };
  const r = moveFeet(t, e, 20, 0);
  assert.equal(r.bx, true);
  assert.ok(e.x <= 24 * 16 - 5);
});

test('slope speed: linear uphill slowdown, downhill quickening, none across', () => {
  const t = new TerrainStore(never);
  t.put(0, 0, ramp(32)); // 0.125 level a tile: half the walking limit
  const grad = (x: number, y: number) => t.gradientAt(x, y);
  const up: Feet = { x: 40, y: 200, hw: 5, fh: 4 };
  sweep(t, up, 64, 0, grad, 60, 6);
  assert.ok(Math.abs(up.x - 40 - 64 * 0.7) < 0.01, `uphill ${up.x - 40}`);
  const down: Feet = { x: 300, y: 200, hw: 5, fh: 4 };
  sweep(t, down, -64, 0, grad, 60, 6);
  assert.ok(Math.abs(300 - down.x - 64 * 1.03) < 0.01, `downhill ${300 - down.x}`);
  const across: Feet = { x: 100, y: 100, hw: 5, fh: 4 };
  sweep(t, across, 0, 64, grad, 60, 6);
  assert.equal(across.y, 164);
});

test('a dash is swept: it cannot jump a closed tile', () => {
  const t = new TerrainStore(never);
  const s = ramp(0);
  s.kind[10 * 24 + 6] = 1; // steep
  t.put(0, 0, s);
  const w: Feet = { x: 3 * 16 + 8, y: 10 * 16 + 10, hw: 5, fh: 4 };
  sweep(t, w, 120, 0, null, 0, 0);
  assert.ok(w.x < 6 * 16 - 4, `stopped at ${w.x}`);
  const near = nearestWalkable(t, 6, 10)!;
  assert.equal(Math.max(Math.abs(near[0] - 6), Math.abs(near[1] - 10)), 1);
  assert.equal(t.walkable(near[0], near[1]), true);
});

test('the generated outcrop: its south face blocks, its gentle side walks', () => {
  const c = surf('cliff');
  const t = new TerrainStore(never);
  t.put(c.cx, c.cy, c.s);
  const i = [...c.s.kind].findIndex((k) => k === CLIFF);
  assert.ok(i >= 0);
  const tx = c.cx * 24 + (i % 24);
  const ty = c.cy * 24 + Math.floor(i / 24);
  assert.equal(t.walkable(tx, ty), false);
  assert.equal(t.closedAt(tx, ty), true);
  // From the first walkable tile below the face, walking north stops at the face.
  let y = ty + 1;
  while (y < c.cy * 24 + 24 && !t.walkable(tx, y)) y++;
  if (y < c.cy * 24 + 24) {
    const w: Feet = { x: tx * 16 + 8, y: y * 16 + 12, hw: 5, fh: 4 };
    moveFeet(t, w, 0, -64);
    assert.ok(w.y > ty * 16 + 16, 'stopped below the face');
    assert.equal(fits(t, w, w.x, ty * 16 + 12), false);
  }
});
