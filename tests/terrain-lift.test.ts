import test from 'node:test';
import assert from 'node:assert/strict';
import { CRAG, SLOPE, STEEP, SLOPE_UNIT, emptySurface, gradientSquared, SLOPE_WALK_LIMIT } from '../src/game/terrain/surface.ts';
import { TerrainStore } from '../src/game/terrain/store.ts';
import { buildWindow } from '../src/game/terrain/window-field.ts';
import { CHUNK_PX, bakeChunk, type Baked } from '../src/game/terrain/bake.ts';
import { MAX_LEVEL, TILE_PX, liftRows, liftSlope, type LiftCurve } from '../src/game/terrain/field.ts';
import { neededChunks } from '../src/game/terrain/need.ts';
import { readTerrainSettings, terrainCurve, TERRAIN_DEFAULT } from '../src/game/terrain/settings.ts';
import { sunAt } from '../src/game/terrain/sun.ts';
import { EDGE_DEFAULT } from '../src/game/terrain/edges.ts';

const HALO = 24;
const COMPRESSED: LiftCurve = { knee: 4, above: 1 };

/** A store over chunks (0, -1)…(0, 3) with ground of height h(tx, ty) at world corners. */
function storeOf(h: (tx: number, ty: number) => number): TerrainStore {
  const store = new TerrainStore(() => Promise.reject(new Error('none')));
  for (let cy = -1; cy <= 3; cy++)
    for (let cx = -1; cx <= 1; cx++) {
      const s = emptySurface(24, 24);
      for (let y = 0; y <= 24; y++) for (let x = 0; x <= 24; x++) s.corners[y * 25 + x] = Math.round(h(cx * 24 + x, cy * 24 + y) * SLOPE_UNIT);
      for (let y = 0; y < 24; y++)
        for (let x = 0; x < 24; x++) {
          const c = (dx: number, dy: number) => s.corners[(y + dy) * 25 + x + dx]!;
          s.kind[y * 24 + x] = gradientSquared(c(0, 0), c(1, 0), c(1, 1), c(0, 1)) > SLOPE_WALK_LIMIT * SLOPE_WALK_LIMIT ? STEEP : SLOPE;
        }
      store.put(cx, cy, s);
    }
  return store;
}

/** A plateau at level 12 over tile rows 30–60, flat 0 round it: its top lifted far north of its own chunks. */
const plateau = storeOf((_tx, ty) => (ty >= 30 && ty <= 60 ? 12 : 0));
const albedo = new Uint8ClampedArray(CHUNK_PX * CHUNK_PX * 4).fill(160);

function bake(store: TerrainStore, cx: number, cy: number, curve?: LiftCurve, quick = false, paint: Uint8ClampedArray | null = albedo): Baked {
  const win = buildWindow(store, cx * 24 - HALO, cy * 24 - HALO, 24 + 2 * HALO, 24 + 2 * HALO);
  return bakeChunk({ win, cx, cy, albedo: paint, lift: true, curve, quick, sun: sunAt(0.3), sunStrength: 1, edges: EDGE_DEFAULT });
}

/** Pixels of world rect (x, y, w, h) no image draws (alpha 0 or outside all). */
function uncovered(images: Baked[], x: number, y: number, w: number, h: number): number {
  const hit = new Uint8Array(w * h);
  for (const b of images)
    for (let j = 0; j < b.h; j++) {
      const wy = b.y + j - y;
      if (wy < 0 || wy >= h) continue;
      for (let i = 0; i < b.w; i++) {
        const wx = b.x + i - x;
        if (wx >= 0 && wx < w && b.rgba[(j * b.w + i) * 4 + 3]) hit[wy * w + wx] = 1;
      }
    }
  return hit.reduce((a, v) => a + (v ? 0 : 1), 0);
}

test('the lift curve: 3 rows a level at full height; compressed past the knee, continuous and never falling', () => {
  assert.equal(liftRows(15, 3), 45);
  assert.equal(liftRows(4, 3, COMPRESSED), 12);
  assert.equal(liftRows(15, 3, COMPRESSED), 23, 'level 15 is 368 px, under a chunk');
  assert.equal(liftSlope(2, 3, COMPRESSED), 3);
  assert.equal(liftSlope(6, 3, COMPRESSED), 1);
  for (const curve of [undefined, COMPRESSED, { knee: 4, above: 0 }, { knee: 9, above: 2.5 }]) {
    let last = liftRows(0, 3, curve);
    for (let z = 0; z <= MAX_LEVEL; z += 0.01) {
      const r = liftRows(z, 3, curve);
      assert.ok(r >= last - 1e-9, `never falls at ${z}`);
      assert.ok(r - last < 3 * 0.01 + 1e-6, `no jump at ${z}`);
      last = r;
    }
  }
});

test('settings: compressed by default (knee 4, 16 px), checked when read back', () => {
  assert.deepEqual(terrainCurve(TERRAIN_DEFAULT), { knee: 4, above: 1 });
  assert.equal(terrainCurve({ ...TERRAIN_DEFAULT, tall: 'full' }), undefined);
  const r = readTerrainSettings({ tall: 'squashed', tallKnee: 40, tallStep: -1 });
  assert.deepEqual([r.tall, r.tallKnee, r.tallStep], [TERRAIN_DEFAULT.tall, TERRAIN_DEFAULT.tallKnee, TERRAIN_DEFAULT.tallStep]);
  assert.deepEqual(terrainCurve(readTerrainSettings({ tall: 'compressed', tallKnee: 6, tallStep: 0 })), { knee: 6, above: 0 });
});

test('the void: baking only the 3×3 leaves the view empty where the plateau two chunks south is lifted into it', () => {
  // The view is chunk (0, 0)'s square; the 3×3 round it reaches chunk row 1 only.
  const view = { x: 0, y: 0, w: CHUNK_PX, h: CHUNK_PX };
  const three = [bake(plateau, 0, -1), bake(plateau, 0, 0), bake(plateau, 0, 1)];
  const gap = uncovered(three, view.x, view.y, view.w, view.h);
  assert.ok(gap > 1000, `the old window leaves a void (${gap} px)`);
  // The view's needed chunks reach row 2, where the plateau's south half lies.
  const need = neededChunks(view, (z) => TILE_PX * liftRows(z, 3), (cx, cy) => plateau.top(cx, cy), 24);
  assert.ok(need.some(([cx, cy]) => cx === 0 && cy === 2), `needs (0, 2): ${JSON.stringify(need)}`);
  const all = need.filter(([cx]) => cx === 0).map(([cx, cy]) => bake(plateau, cx, cy));
  assert.equal(uncovered(all, view.x, view.y, view.w, view.h), 0, 'nothing in view is empty');
});

test('compressed: the plateau lifts less, the view needs fewer chunks south, and still nothing is empty', () => {
  const view = { x: 0, y: 0, w: CHUNK_PX, h: CHUNK_PX };
  const lift = (z: number) => TILE_PX * liftRows(z, 3, COMPRESSED);
  const full = neededChunks(view, (z) => TILE_PX * liftRows(z, 3), (cx, cy) => plateau.top(cx, cy), 24);
  const need = neededChunks(view, lift, (cx, cy) => plateau.top(cx, cy), 24);
  assert.ok(need.length <= full.length);
  const images = need.filter(([cx]) => cx === 0).map(([cx, cy]) => bake(plateau, cx, cy, COMPRESSED));
  assert.equal(uncovered(images, view.x, view.y, view.w, view.h), 0);
  const tall = bake(plateau, 0, 2);
  const low = bake(plateau, 0, 2, COMPRESSED);
  assert.ok(low.y > tall.y, `lifted less (${low.y} vs ${tall.y})`);
  assert.equal(tall.y + tall.h, low.y + low.h, 'the face still meets the ground in front at the same row');
});

test('flat ground needs only the chunks under the view; unknown ground is taken at the highest level', () => {
  const view = { x: 40, y: 40, w: 300, h: 200 };
  const lift = (z: number) => TILE_PX * liftRows(z, 3);
  assert.deepEqual(neededChunks(view, lift, () => 0, 24), [[0, 0]]);
  const unknown = neededChunks(view, lift, () => Number.NaN, 24);
  assert.ok(unknown.some(([, cy]) => cy === 2) && !unknown.some(([, cy]) => cy > 2), JSON.stringify(unknown));
  assert.equal(neededChunks(view, lift, () => Number.NaN, 2).length, 2, 'the budget holds');
  assert.deepEqual(neededChunks(view, () => 0, () => Number.NaN, 24), [[0, 0]], 'top-down: the view only');
});

test('a placeholder bake draws the same shape as the real one, from plain ground when there is no paint', () => {
  const full = bake(plateau, 0, 1);
  const quick = bake(plateau, 0, 1, undefined, true, null);
  assert.deepEqual([quick.x, quick.y, quick.w, quick.h], [full.x, full.y, full.w, full.h]);
  for (let i = 3; i < full.rgba.length; i += 4) assert.equal(quick.rgba[i], full.rgba[i]);
  assert.equal(quick.edges, 0, 'no edges in a placeholder');
});

test('the store knows each chunk\'s highest ground', () => {
  assert.equal(plateau.top(0, 0), 0);
  assert.equal(plateau.top(0, 1), 12);
  assert.ok(Number.isNaN(plateau.top(9, 9)));
});

test('closed ground: its border is marked on the walkable side even with no drop, and it is drawn as rock, not one grey', () => {
  const flat = storeOf(() => 1);
  // Crag over the east half of chunk (0, 0), at the same height as the ground beside it.
  const s = flat.surface(0, 0)!;
  for (let y = 0; y < 24; y++) for (let x = 12; x < 24; x++) s.kind[y * 24 + x] = CRAG;
  flat.version++;
  const win = buildWindow(flat, -HALO, -HALO, 24 + 2 * HALO, 24 + 2 * HALO);
  const b = bakeChunk({ win, cx: 0, cy: 0, albedo, lift: false, sun: sunAt(0.5), sunStrength: 0, edges: EDGE_DEFAULT });
  assert.ok(b.edges > 0, 'the border counts as an edge');
  const lum = (x: number, y: number) => { const o = (y * b.w + x) * 4; return b.rgba[o]! + b.rgba[o + 1]! + b.rgba[o + 2]!; };
  const y = 100;
  assert.ok(lum(12 * 16 - 1, y) < lum(12 * 16 - 8, y) * 0.8, `darker beside the border (${lum(12 * 16 - 1, y)} vs ${lum(12 * 16 - 8, y)})`);
  // Rock: ledges and blocks make many distinct tones, not a flat grey.
  const tones = new Set<number>();
  for (let x = 13 * 16; x < 23 * 16; x++) for (let yy = 40; yy < 340; yy += 7) tones.add(Math.round(lum(x, yy) / 6));
  assert.ok(tones.size > 20, `${tones.size} tones on the crag`);
});
