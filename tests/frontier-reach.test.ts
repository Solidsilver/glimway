import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { validateNear } from '../src/lib/api/near.ts';
import { WildsNearResultSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { frontierRect, heldReach, inHeldSlack, insideFrontier, setHeldReach } from '../src/lib/wilds/coords.ts';
import { onGrid } from '../src/lib/location.ts';
import { loadWilds } from '../src/lib/wilds/data.ts';
import { applyNear, insideNamedFrontier, resetWilds, wildsFrontier } from '../src/game/wilds/store.ts';
import { buildWildsWorld, DRIFT_VIEW_PX, followFrontier } from '../src/game/wilds/wilds-world.ts';

// Frontier reach from held land (lamps.md 2.2): the twin of
// server/internal/frontier. Held chunks push the frontier out by the
// content's heldSlack, never further south than its southLimit.

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[];
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;

/** The static frontier's northmost chunk in column cx. */
function northEdge(cx: number): number {
  for (let cy = -64; cy < 8; cy++) if (insideFrontier(cx, cy, undefined, [])) return cy;
  throw new Error(`no frontier in column ${cx}`);
}

const EX = 2;
const EY = northEdge(EX);

test('held chunks push the frontier out by the slack, no further south', () => {
  setHeldReach([]);
  assert.equal(loadWilds().frontier.heldSlack, 3);
  assert.equal(insideFrontier(EX, EY - 1), false);
  const before = frontierRect();
  setHeldReach([{ cx: EX, cy: EY }]);
  assert.deepEqual(heldReach(), [{ cx: EX, cy: EY }]);
  for (let d = 1; d <= 3; d++) {
    assert.ok(insideFrontier(EX, EY - d), `${d} out`);
    assert.ok(insideFrontier(EX + d, EY - d), `${d} out, diagonal`);
  }
  assert.equal(insideFrontier(EX, EY - 4), false);
  assert.equal(onGrid(EX, EY - 3), true, 'the location seam agrees');
  const after = frontierRect();
  assert.equal(after.minCy, Math.min(before.minCy, EY - 3));
  assert.deepEqual([after.minCx, after.maxCx, after.maxCy], [before.minCx, before.maxCx, before.maxCy]);
  // Passed explicitly, keys win over the set ones.
  assert.equal(insideFrontier(EX, EY - 1, undefined, []), false);
  // The south limit holds for held land too.
  const south = loadWilds().frontier.southLimit;
  assert.equal(inHeldSlack(40, south + 1, [{ cx: 40, cy: south }]), false);
  assert.equal(inHeldSlack(43, south - 3, [{ cx: 40, cy: south }]), true);
  assert.ok(frontierRect([{ cx: 40, cy: south }]).maxCy <= south);
  setHeldReach([]);
  assert.deepEqual(frontierRect(), before);
});

/** A near read centred in the slack of a camp on the edge, as the server writes it. */
function slackNear(held: boolean): JsonValue {
  const j = structuredClone(NEAR);
  j.center = { ...j.center, cx: EX, cy: EY - 2 };
  const r = frontierRect(held ? [{ cx: EX, cy: EY }] : []);
  j.frontier = { rect: r, ...(held ? { held: [{ realm: j.center.realm, layer: 0, cx: EX, cy: EY }] } : {}) };
  for (const k of ['entities', 'personalClaims', 'discoveries', 'lanterns', 'echoes', 'ground', 'glimpse', 'ways', 'chunks']) j[k] = [];
  return j as JsonValue;
}

test('the near read takes its own held keys: a centre in the slack is on the grid only when they name it', () => {
  setHeldReach([]);
  assert.doesNotThrow(() => validateNear(fromJson(WildsNearResultSchema, slackNear(true)), EX, EY - 2));
  assert.throws(() => validateNear(fromJson(WildsNearResultSchema, slackNear(false)), EX, EY - 2));
  const bad = slackNear(true) as Record<string, any>;
  bad.frontier.held[0].layer = 1;
  assert.throws(() => validateNear(fromJson(WildsNearResultSchema, bad as JsonValue), EX, EY - 2));
});

test('a near read sets the world’s held reach; forgetting the Wilds clears it', () => {
  resetWilds({ quiet: true });
  assert.notEqual(applyNear(fromJson(WildsNearResultSchema, slackNear(true))), null);
  assert.ok(insideNamedFrontier(EX, EY - 3));
  assert.equal(insideNamedFrontier(EX, EY - 4), false);
  assert.equal(wildsFrontier()!.minCy, Math.min(frontierRect([]).minCy, EY - 3));
  // A later read without the hold (it lapsed at the turning) takes it back.
  assert.notEqual(applyNear(fromJson(WildsNearResultSchema, { ...(slackNear(false) as Record<string, any>), center: { ...NEAR.center } })), null);
  assert.equal(insideNamedFrontier(EX, EY - 1), false);
  applyNear(fromJson(WildsNearResultSchema, slackNear(true)));
  resetWilds({ quiet: true });
  assert.deepEqual(heldReach(), []);
  assert.equal(insideFrontier(EX, EY - 1), false);
});

test('the open world’s bounds follow the near read’s frontier, and wait for one', () => {
  resetWilds({ quiet: true });
  const open = buildWildsWorld().open!;
  const built = { ...open.bounds };
  assert.equal(followFrontier(open), false, 'no read yet: as built');
  applyNear(fromJson(WildsNearResultSchema, slackNear(true)));
  assert.equal(followFrontier(open), true);
  assert.ok(open.bounds.y < built.y, 'pushed north');
  assert.equal(open.view.y, open.bounds.y - DRIFT_VIEW_PX);
  assert.equal(followFrontier(open), false, 'unchanged: nothing to do');
  resetWilds({ quiet: true });
  assert.equal(followFrontier(open), false, 'forgotten: kept until the next read');
});
