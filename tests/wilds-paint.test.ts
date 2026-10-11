import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN } from '../src/lib/tile.ts';
import { wildsGround } from '../src/lib/wilds/data.ts';
import { fnv1a32 } from '../src/lib/hash.ts';
import { paintDrift, fogDrift, paintGround, paintOf as paintBy, packGround, unpackGround, VOID, type GroundSource } from '../src/game/wilds/ground-paint.ts';
import { groundTable } from '../src/game/wilds/ground-table.ts';

const paintOf = (terrain: number | null) => paintBy(groundTable(), terrain);
import { wildsLook } from '../src/game/wilds/wilds-looks.ts';
import { terrainOf, type ChunkTerrain } from '../src/game/wilds/terrain.ts';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import { toBinary } from '@bufbuild/protobuf';
import { WildsChunkSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { frontierDistance } from '../src/game/wilds/window-plan.ts';
import { openMapChunk } from './wilds-fixture.ts';

const S = 24;
const PX = S * 16;
const t = (id: string) => (TERRAIN as Record<string, number>)[wildsGround(id).terrain]!;

/** A little world of chunks (the generator's own woods), with some open-map ground near the seams. */
function world(): { chunks: Map<string, ChunkTerrain>; src: GroundSource } {
  const chunks = new Map<string, ChunkTerrain>();
  for (const [cx, cy] of [[0, -4], [1, -4], [0, -3], [1, -3]] as const) {
    const c = terrainOf(decodeChunk(toBinary(WildsChunkSchema, openMapChunk('outer-1', { cx, cy }))));
    // Meadow, a river with its bank and a ford, paving and a laid path, across the edges.
    for (let y = 0; y < S; y++) {
      c.ground[y]![0] = t('meadow');
      c.ground[y]![1] = t('bank');
      c.ground[y]![S - 1] = t('water');
      c.solid[y]![S - 1] = true;
    }
    for (let x = 4; x < 9; x++) {
      c.ground[0]![x] = t('paving');
      c.ground[S - 1]![x] = t('laid-stone');
      c.ground[S - 2]![x] = t('ford');
    }
    chunks.set(`${cx},${cy}`, c);
  }
  const at = (tx: number, ty: number) => {
    const cx = Math.floor(tx / S);
    const cy = Math.floor(ty / S);
    const c = chunks.get(`${cx},${cy}`);
    return c ? { c, lx: tx - cx * S, ly: ty - cy * S } : null;
  };
  return {
    chunks,
    src: {
      ground: (tx, ty) => {
        const a = at(tx, ty);
        return a ? a.c.ground[a.ly]![a.lx]! : null;
      },
      solid: (tx, ty) => {
        const a = at(tx, ty);
        return !a || a.c.solid[a.ly]![a.lx]!;
      },
    },
  };
}

const G = wildsLook('outer', 'Carting').ground;
const SEED = fnv1a32('world-seed');

function paint(x0: number, y0: number, w: number, h: number, src: GroundSource): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  paintGround(out, x0, y0, w, h, src, G, SEED, groundTable());
  return out;
}

/** The pixel at world (wx, wy) of an image whose world origin is (x0, y0) and width w. */
const px = (img: Uint8ClampedArray, x0: number, y0: number, w: number, wx: number, wy: number) => {
  const i = ((wy - y0) * w + (wx - x0)) * 4;
  return [img[i], img[i + 1], img[i + 2], img[i + 3]];
};

test('ground lines up across chunk edges: a chunk painted past its edge agrees with its neighbour, pixel for pixel', () => {
  const { src } = world();
  const ax = 0;
  const ay = -4 * PX;
  const margin = 40;
  // Chunk (0, -4) painted 40 px into (1, -4) east and (0, -3) south.
  const a = paint(ax, ay, PX + margin, PX + margin, src);
  const east = paint(PX, ay, PX, PX, src);
  const south = paint(ax, -3 * PX, PX, PX, src);
  const corner = paint(PX, -3 * PX, PX, PX, src);
  let compared = 0;
  for (let wy = ay; wy < ay + PX + margin; wy++)
    for (let wx = ax; wx < ax + PX + margin; wx++) {
      if (wx < PX && wy < -3 * PX) continue;
      const other = wx >= PX && wy >= -3 * PX ? [corner, PX, -3 * PX] as const : wx >= PX ? [east, PX, ay] as const : [south, ax, -3 * PX] as const;
      assert.deepEqual(px(a, ax, ay, PX + margin, wx, wy), px(other[0], other[1], other[2], PX, wx, wy), `world pixel ${wx},${wy}`);
      compared++;
    }
  assert.ok(compared > 30_000);
  // The seam itself: the last column of one chunk and the first of the next differ no more than any two neighbouring columns do.
  const own = paint(ax, ay, PX, PX, src);
  for (let wy = ay; wy < ay + PX; wy++) assert.deepEqual(px(own, ax, ay, PX, PX - 1, wy), px(a, ax, ay, PX + margin, PX - 1, wy), 'painting further changes nothing already painted');
});

test('a patch packed for the painter thread paints exactly as on the main thread', () => {
  const { src } = world();
  const here = paint(0, -4 * PX, PX, PX, src);
  const away = paint(0, -4 * PX, PX, PX, unpackGround(packGround(src, 0, -4 * PX, PX, PX)));
  assert.deepEqual(away, here);
});

test('the open map’s grounds each paint as their own kind', () => {
  assert.equal(paintOf(t('meadow')).cat, 'meadow');
  assert.equal(paintOf(t('bank')).cat, 'bank');
  assert.equal(paintOf(t('ford')).cat, 'ford');
  assert.equal(paintOf(t('paving')).cat, 'paving');
  assert.equal(paintOf(t('laid-stone')).cat, 'laid');
  assert.equal(paintOf(t('laid-plank')).cat, 'laid');
  assert.deepEqual(paintOf(t('path')), { cat: 'moss', trail: 1 });
  assert.equal(paintOf(null).cat, 'woods', 'nothing known (past the frontier): deep woods');
  // A meadow is lighter than the woods floor it borders.
  const lum = (c: number[]) => c[0]! * 0.3 + c[1]! * 0.59 + c[2]! * 0.11;
  assert.ok(lum(G.meadow[3]!) > lum(G.woods[3]!));
});

test('painting a chunk: the budget (8 ms on the owner’s phone) — measured here and reported', (tc) => {
  const { src } = world();
  const out = new Uint8ClampedArray(PX * PX * 4);
  const times: number[] = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    paintGround(out, 0, -4 * PX, PX, PX, src, G, SEED, groundTable());
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[3]!;
  tc.diagnostic(`ground paint per chunk (384×384 px, node): median ${median.toFixed(1)} ms, best ${times[0]!.toFixed(1)} ms`);
  const drift = new Uint8ClampedArray(PX * PX * 4);
  const f = { minCx: -4, minCy: -8, maxCx: 4, maxCy: 0 };
  const start = performance.now();
  paintDrift(drift, 5 * PX, -4 * PX, PX, PX, G, { land: 'meadow', river: true }, SEED);
  fogDrift(drift, 5 * PX, -4 * PX, PX, PX, (wx, wy) => frontierDistance(f, wx, wy));
  tc.diagnostic(`drift paint per chunk (node): ${(performance.now() - start).toFixed(1)} ms`);
  // A guard against a painter gone quadratic, not the phone budget itself (see the report).
  assert.ok(median < 400, `${median} ms`);
});

test('the drift fogs into the void, deeper the further past the frontier', () => {
  const drift = new Uint8ClampedArray(PX * 4);
  const f = { minCx: -4, minCy: -8, maxCx: 4, maxCy: 0 };
  paintDrift(drift, 5 * PX, -4 * PX, PX, 1, G, null, SEED);
  const before = drift.slice();
  fogDrift(drift, 5 * PX, -4 * PX, PX, 1, (wx, wy) => frontierDistance(f, wx, wy));
  const off = (i: number, from: Uint8ClampedArray) => Math.abs(from[i * 4]! - VOID[0]) + Math.abs(from[i * 4 + 1]! - VOID[1]) + Math.abs(from[i * 4 + 2]! - VOID[2]);
  // At the edge the land still shows; half a chunk out it is all but the void.
  for (let i = PX / 2; i < PX; i++) assert.ok(off(i, drift) <= 6, `pixel ${i} is fog`);
  assert.ok(off(0, drift) < off(0, before) || off(0, before) === 0, 'the edge is fogged a little');
  assert.ok([0, 1, 2, 3].some((i) => off(i, drift) > 6), 'and still shows the land');
});
