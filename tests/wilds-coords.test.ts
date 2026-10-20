import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/wilds-coords.json' with { type: 'json' };
import { borderRect, cellOf, cellPlaceId, chunkOf, chunksInFromBorder, epochKindAt, footprintAt, insideBorder, localOf, ring, tier, tileOfPixel } from '../src/lib/wilds/coords.ts';

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

test('footprints, tiers, epochs, rings, cells and the world border (shared vectors)', () => {
  for (const c of vectors.chunks) {
    const [cx, cy] = c.chunk as [number, number];
    const { x, y } = cellOf(cx, cy);
    assert.deepEqual(
      { footprint: footprintAt(cx, cy)?.id ?? '', tier: tier(cx, cy), epochKind: epochKindAt(cx, cy), inside: insideBorder(cx, cy), ring: ring(cx, cy), cell: [x, y] },
      { footprint: c.footprint, tier: c.tier, epochKind: c.epochKind, inside: c.inside, ring: c.ring, cell: c.cell },
      `chunk ${c.chunk}`,
    );
  }
  assert.equal(borderRect().maxCx, vectors.border.chunks);
  for (const [cx, cy] of vectors.border.inside as [number, number][]) assert.equal(insideBorder(cx, cy), true, `${cx},${cy}`);
  for (const [cx, cy] of vectors.border.outside as [number, number][]) assert.equal(insideBorder(cx, cy), false, `${cx},${cy}`);
  assert.equal(chunksInFromBorder(vectors.border.chunks, 0), 0);
  assert.equal(chunksInFromBorder(0, -vectors.border.chunks - 1), -1);
  assert.equal(cellPlaceId(-1, 2), 'place:-1:2');
});
