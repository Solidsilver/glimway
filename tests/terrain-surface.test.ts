import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIFF, SLOPE_UNIT, SLOPE_WALK_LIMIT, decodeSurface, decodeTerrainBatch, encodeSurface, gradientSquared, surfaceStep, surfaceWalkable, tileCorners } from '../src/game/terrain/surface.ts';

// content/vectors/slopes-surface.json, written by the server
// (server/internal/wilds/slopes_vectors_test.go): both decoders agree on
// every chunk's kinds, walkable tiles, open steps and faces.
interface VectorChunk {
  name: string; cx: number; cy: number; w: number; h: number; b64: string;
  kinds: string; walkable: string; steps: string; flags: string; unreachable: string;
  overrides: number; cornerSum: number; faces: number[][]; resolved: number[][]; gradients: number[][];
}
const vectors = JSON.parse(readFileSync(new URL('../content/vectors/slopes-surface.json', import.meta.url), 'utf8')) as {
  recipe: string; unit: number; limit: number; chunks: VectorChunk[]; reject: { name: string; b64: string }[];
};
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));

test('the shared contract constants', () => {
  assert.equal(vectors.unit, SLOPE_UNIT);
  assert.equal(vectors.limit, SLOPE_WALK_LIMIT);
  assert.equal(vectors.recipe, 'slopes-gen@1');
});

for (const v of vectors.chunks) {
  test(`decodes the ${v.name} vector as the server does`, () => {
    const raw = bytes(v.b64);
    const s = decodeSurface(raw);
    assert.equal(s.w, v.w);
    assert.equal(s.h, v.h);
    assert.equal(s.overrideTiles.length, v.overrides);
    assert.equal(s.corners.reduce((a, q) => a + q, 0), v.cornerSum);
    let kinds = '', walk = '', steps = '', flags = '', unreach = '';
    for (let i = 0; i < s.w * s.h; i++) {
      kinds += s.kind[i];
      walk += surfaceWalkable(s, i) ? '1' : '0';
      let open = 0;
      for (let d = 0; d < 4; d++) if (surfaceStep(s, i, d) >= 0) open |= 1 << d;
      steps += open.toString(16);
      flags += s.flags[i]!.toString(16);
      unreach += s.unreachable[i];
    }
    assert.equal(kinds, v.kinds);
    assert.equal(walk, v.walkable);
    assert.equal(steps, v.steps);
    assert.equal(flags, v.flags);
    assert.equal(unreach, v.unreachable);
    const faces: number[][] = [];
    for (let i = 0; i < s.w * s.h; i++) if (s.kind[i] === CLIFF) faces.push([i, s.faceTop[i]!, s.faceBottom[i]!, s.faceRow[i]!, s.faceRows[i]!]);
    assert.deepEqual(faces, v.faces ?? []);
    for (const [i, ...c] of v.resolved) assert.deepEqual(tileCorners(s, i!), c);
    for (const [i, g] of v.gradients) {
      const c = tileCorners(s, i!);
      assert.equal(gradientSquared(c[0]!, c[1]!, c[2]!, c[3]!), g);
    }
    // Canonical: encoding again gives the same bytes.
    assert.deepEqual(encodeSurface(s), raw);
  });
}

test('a cliff chunk and its east neighbour share their border corners', () => {
  const west = decodeSurface(bytes(vectors.chunks.find((c) => c.name === 'cliff')!.b64));
  const east = decodeSurface(bytes(vectors.chunks.find((c) => c.name === 'cliff-east')!.b64));
  for (let y = 0; y <= 24; y++) assert.equal(west.corners[y * 25 + 24], east.corners[y * 25]);
});

for (const r of vectors.reject) {
  test(`refuses the ${r.name} envelope`, () => {
    assert.throws(() => decodeSurface(bytes(r.b64)));
  });
}

test('the centre-gradient trap fails at its corner, in every rotation', () => {
  // (0,0,64,0): its centre passes; its SE corner's squared gradient is 8,192.
  for (const c of [[0, 0, 64, 0], [0, 64, 0, 0], [64, 0, 0, 0], [0, 0, 0, 64]]) assert.ok(gradientSquared(c[0]!, c[1]!, c[2]!, c[3]!) > SLOPE_WALK_LIMIT ** 2);
  assert.equal(gradientSquared(0, 0, 64, 0), 8192);
});

test('a batch reply decodes chunk by chunk', () => {
  const a = bytes(vectors.chunks[0]!.b64);
  const b = bytes(vectors.chunks.at(-1)!.b64);
  const head = (cx: number, cy: number, n: number) => {
    const h = new Uint8Array(10);
    const v = new DataView(h.buffer);
    v.setInt32(0, cx, true);
    v.setInt32(4, cy, true);
    v.setUint16(8, n, true);
    return h;
  };
  const raw = Uint8Array.from([...head(-3, 7, a.length), ...a, ...head(2, -1, b.length), ...b]);
  const got = decodeTerrainBatch(raw);
  assert.deepEqual(got.map((g) => [g.cx, g.cy, g.surface.w]), [[-3, 7, 24], [2, -1, 3]]);
  assert.throws(() => decodeTerrainBatch(raw.subarray(0, raw.length - 1)));
});
