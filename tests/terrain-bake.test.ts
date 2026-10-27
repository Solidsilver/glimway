import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeSurface } from '../src/game/terrain/surface.ts';
import { TerrainStore } from '../src/game/terrain/store.ts';
import { buildWindow } from '../src/game/terrain/window-field.ts';
import { CHUNK_PX, bakeChunk } from '../src/game/terrain/bake.ts';
import { sunAt } from '../src/game/terrain/sun.ts';
import { EDGE_DEFAULT } from '../src/game/terrain/edges.ts';

const vectors = JSON.parse(readFileSync(new URL('../content/vectors/slopes-surface.json', import.meta.url), 'utf8')) as { chunks: { name: string; cx: number; cy: number; b64: string }[] };
const store = new TerrainStore(() => Promise.reject(new Error('none')));
for (const v of vectors.chunks) if (v.name !== 'override-probe') store.put(v.cx, v.cy, decodeSurface(Uint8Array.from(Buffer.from(v.b64, 'base64'))));
const albedo = new Uint8ClampedArray(CHUNK_PX * CHUNK_PX * 4).fill(160);

function bake(name: string, lift: boolean, halo = 8) {
  const v = vectors.chunks.find((c) => c.name === name)!;
  const win = buildWindow(store, v.cx * 24 - halo, v.cy * 24 - halo, 24 + 2 * halo, 24 + 2 * halo);
  return { v, b: bakeChunk({ win, cx: v.cx, cy: v.cy, albedo, lift, sun: sunAt(0.3), sunStrength: 1, edges: EDGE_DEFAULT }) };
}

test('top-down: the chunk square, opaque, at its world px', () => {
  const { v, b } = bake('flat', false);
  assert.deepEqual([b.x, b.y, b.w, b.h], [v.cx * CHUNK_PX, v.cy * CHUNK_PX, CHUNK_PX, CHUNK_PX]);
  for (let i = 3; i < b.rgba.length; i += 4) assert.equal(b.rgba[i], 255);
  assert.equal(b.edges, 0, 'flat ground has no edges');
});

test('the outcrop cliff: edges read in both looks; the lift is taller and placed north', () => {
  const top = bake('cliff', false).b;
  assert.ok(top.edges > 0, `top-down edges ${top.edges}`);
  const { v, b } = bake('cliff', true);
  assert.ok(b.edges > 0);
  assert.ok(b.y < v.cy * CHUNK_PX, 'lifted north');
  assert.ok(b.h >= CHUNK_PX - 2);
});
