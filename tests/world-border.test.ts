import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { validateNear } from '../src/lib/api/near.ts';
import { WildsNearResultSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { borderRect, insideBorder } from '../src/lib/wilds/coords.ts';
import { onGrid } from '../src/lib/location.ts';
import { loadWilds } from '../src/lib/wilds/data.ts';
import { applyNear, insideNamedBorder, resetWilds, wildsBorder } from '../src/game/wilds/store.ts';
import { borderBounds, buildWildsWorld, DRIFT_VIEW_PX, followBorder } from '../src/game/wilds/wilds-world.ts';
import { CHUNK_PX } from '../src/game/wilds/coords.ts';

// The world border (0.14): the twin of server/internal/wilds InsideBorder.
// No frontier: every chunk inside the border is on the grid, however far
// from home, and nothing past it is.

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[];
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;
const B = loadWilds().border.chunks;

/** A near read centred at (cx, cy) with a border of `b` chunks, as the server writes it. */
function nearAt(cx: number, cy: number, b = B): JsonValue {
  const j = structuredClone(NEAR);
  j.center = { ...j.center, cx, cy };
  j.border = { rect: { minCx: -b, minCy: -b, maxCx: b, maxCy: b } };
  for (const k of ['entities', 'personalClaims', 'discoveries', 'lanterns', 'echoes', 'ground', 'ways', 'chunks']) j[k] = [];
  return j as JsonValue;
}

test('the border is content’s, the same on every side, and the grid stops there', () => {
  assert.equal(B, 4096);
  assert.deepEqual(borderRect(), { minCx: -B, minCy: -B, maxCx: B, maxCy: B });
  for (const [cx, cy] of [[0, 40], [0, 400], [-300, 9], [B, -B]] as const) {
    assert.ok(insideBorder(cx, cy), `${cx},${cy}`);
    assert.ok(onGrid(cx, cy), `${cx},${cy} on the grid`);
  }
  assert.equal(onGrid(B + 1, 0), false);
  assert.equal(onGrid(0, -B - 1), false);
});

test('a near read far from home validates; one past its own border, or without one, does not', () => {
  assert.doesNotThrow(() => validateNear(fromJson(WildsNearResultSchema, nearAt(0, 400)), 0, 400));
  assert.doesNotThrow(() => validateNear(fromJson(WildsNearResultSchema, nearAt(-B, B)), -B, B));
  assert.throws(() => validateNear(fromJson(WildsNearResultSchema, nearAt(B + 1, 0)), B + 1, 0));
  const none = nearAt(0, 400) as Record<string, any>;
  delete none.border;
  assert.throws(() => validateNear(fromJson(WildsNearResultSchema, none as JsonValue), 0, 400));
  // The answer's own border rules (content may have widened it on the server first).
  assert.doesNotThrow(() => validateNear(fromJson(WildsNearResultSchema, nearAt(B + 10, 0, B + 64)), B + 10, 0));
});

test('a near read names the border; forgetting the Wilds forgets it', () => {
  resetWilds({ quiet: true });
  assert.equal(wildsBorder(), null);
  assert.notEqual(applyNear(fromJson(WildsNearResultSchema, nearAt(0, 400))), null);
  assert.deepEqual(wildsBorder(), { minCx: -B, minCy: -B, maxCx: B, maxCy: B });
  assert.ok(insideNamedBorder(0, 401));
  assert.ok(insideNamedBorder(-B, -B));
  assert.equal(insideNamedBorder(B + 1, 0), false);
  resetWilds({ quiet: true });
  assert.equal(insideNamedBorder(0, 0), false);
});

test('the open world’s bounds are the border, and follow a wider one when a read names it', () => {
  resetWilds({ quiet: true });
  const open = buildWildsWorld().open!;
  assert.deepEqual(open.bounds, borderBounds());
  assert.deepEqual(open.bounds, { x: -B * CHUNK_PX, y: -B * CHUNK_PX, w: (2 * B + 1) * CHUNK_PX, h: (2 * B + 1) * CHUNK_PX });
  assert.equal(followBorder(open), false, 'no read yet: as built');
  applyNear(fromJson(WildsNearResultSchema, nearAt(0, 0, B + 64)));
  assert.equal(followBorder(open), true);
  assert.equal(open.bounds.x, -(B + 64) * CHUNK_PX);
  assert.equal(open.view.y, open.bounds.y - DRIFT_VIEW_PX);
  assert.equal(followBorder(open), false, 'unchanged: nothing to do');
  resetWilds({ quiet: true });
  assert.equal(followBorder(open), false, 'forgotten: kept until the next read');
});
