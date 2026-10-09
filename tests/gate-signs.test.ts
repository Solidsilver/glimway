import test from 'node:test';
import assert from 'node:assert/strict';
import { gateSignAt } from '../src/game/area/exits.ts';
import type { ExitDef, WorldData } from '../src/game/worlds.ts';

// The owner's playtest: the gate sign you're told to read is drawn, under
// its exit's label, a tile and more inside the edge.
const world = { width: 40, height: 30 } as WorldData;
const exit = (e: Partial<ExitDef>): ExitDef => ({ tx: 0, ty: 12, tw: 1, th: 3, to: 'woodland', entry: { tx: 1, ty: 1 }, ...e }) as ExitDef;

test('gate signs: a named edge exit has a post under its label, inside the edge', () => {
  const west = gateSignAt(world, exit({}))!;
  assert.deepEqual(west, { x: 26, y: 13.5 * 16 - 20 + 15 });
  assert.ok(west.x >= 16 + 8, 'more than a tile in from the west edge');
  const east = gateSignAt(world, exit({ tx: 39 }))!;
  assert.equal(east.x, 40 * 16 - 26);
  const north = gateSignAt(world, exit({ tx: 18, ty: 0, tw: 3, th: 1 }))!;
  assert.deepEqual(north, { x: 19.5 * 16, y: 22 + 15 });
});

test('gate signs: doorways, stairs and unnamed or hidden exits have none', () => {
  assert.equal(gateSignAt(world, exit({ label: null })), null);
  assert.equal(gateSignAt(world, exit({ label: '' })), null);
  assert.equal(gateSignAt(world, exit({ kind: 'door' })), null);
  assert.equal(gateSignAt(world, exit({ kind: 'stair' })), null);
  assert.ok(gateSignAt(world, exit({ kind: 'edge', label: 'Brackenwood Path' })));
});
