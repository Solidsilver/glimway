import { PLACES } from '../src/lib/places.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/wilds-coords.json' with { type: 'json' };
import { cellOf, cellPlaceId, chunkOf, epochKindAt, footprintAt, insideFrontier, localOf, ring, tier, tileOfPixel } from '../src/lib/wilds/coords.ts';

test('signed tiles fall into floor-divided chunks (shared vectors)', () => {
  for (const c of vectors.chunkOf) {
    const { cx, cy } = chunkOf(c.tile[0]!, c.tile[1]!);
    const { lx, ly } = localOf(c.tile[0]!, c.tile[1]!);
    assert.deepEqual([cx, cy, lx, ly], [...c.chunk, ...c.local], `tile ${c.tile}`);
  }
  for (const c of vectors.tileOfPixel) {
    const { tx, ty } = tileOfPixel(c.pixel[0]!, c.pixel[1]!);
    assert.deepEqual([tx, ty], c.tile, `pixel ${c.pixel}`);
  }
});

test('footprints, tiers, epochs, rings, cells and the frontier (shared vectors)', () => {
  for (const c of vectors.chunks) {
    const [cx, cy] = c.chunk as [number, number];
    const { x, y } = cellOf(cx, cy);
    assert.deepEqual(
      { footprint: footprintAt(cx, cy)?.id ?? '', tier: tier(cx, cy), epochKind: epochKindAt(cx, cy), inside: insideFrontier(cx, cy), ring: ring(cx, cy), cell: [x, y] },
      { footprint: c.footprint, tier: c.tier, epochKind: c.epochKind, inside: c.inside, ring: c.ring, cell: c.cell },
      `chunk ${c.chunk}`,
    );
  }
  const [x0, y0, x1, y1] = vectors.frontier.rect as [number, number, number, number];
  let inside = 0;
  let fresh = 0;
  for (let cy = y0 - 5; cy <= y1 + 5; cy++) {
    for (let cx = x0 - 5; cx <= x1 + 5; cx++) {
      if (insideFrontier(cx, cy)) { inside++; if (!footprintAt(cx, cy) && !PLACES.fixed.some(p => cx >= p.cx && cx < p.cx + p.width && cy >= p.cy && cy < p.cy + p.height)) fresh++; }
    }
  }
  assert.deepEqual([inside, fresh], [vectors.frontier.chunks, vectors.frontier.new]);
  assert.equal(cellPlaceId(-1, 2), 'place:-1:2');
});
