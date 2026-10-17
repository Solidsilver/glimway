import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '@bufbuild/protobuf';
import { WaysHomeBindingSchema } from '../src/lib/gen/glimway/v1/lamps_pb.js';
import { STILL_PX, WAYS_HOME_LINES, WAY_ITEM, WayPause, bindingLit, boundLampName, pauseMs, wayOf } from '../src/lib/ways-home.ts';
import { itemDef, usableNow } from '../src/lib/items.ts';
import { CRAFTING } from '../src/lib/workshop.ts';

const binding = (o: Partial<{ lampId: string; lampName: string; state: string; kind: string }> = {}) =>
  create(WaysHomeBindingSchema, { lampId: 'lamp-stone:2:-1', state: 'lit', kind: 'stone', ...o });

test('ways home: the items, their pause from content, and no generic Use button', () => {
  assert.equal(wayOf('homing-turncap'), 'turncap');
  assert.equal(wayOf('lamp-ash-pouch'), 'pouch');
  assert.equal(wayOf('amber'), null);
  assert.equal(pauseMs('turncap'), 3000);
  assert.equal(pauseMs('pouch'), 3000);
  for (const id of Object.values(WAY_ITEM)) {
    const d = itemDef(id);
    assert.ok(d, id);
    assert.equal(usableNow(d!), false, `${id} has its own button, not Use`);
  }
  assert.equal(itemDef('homing-turncap')!.use![0]!.target, 'hearthwick:arch');
  assert.equal(itemDef('lamp-ash')!.kind, 'material');
});

test('ways home: both recipes are bench recipes found on their pages', () => {
  const turncap = CRAFTING.recipes.find((r) => r.id === 'craft-homing-turncap');
  const pouch = CRAFTING.recipes.find((r) => r.id === 'craft-lamp-ash-pouch');
  assert.deepEqual(turncap?.materials, { 'turncap-spawn': 1, amber: 2 });
  assert.deepEqual(pouch?.materials, { 'lamp-ash': 1, fiber: 2 });
  assert.equal(turncap?.page, 'recipe-homing-turncap');
  assert.equal(pouch?.page, 'recipe-lamp-ash-pouch');
  for (const r of [turncap!, pouch!]) assert.equal(itemDef(r.page)?.kind, 'paper');
});

test('the pause holds while you stand still, and is done once its time has passed', () => {
  const p = new WayPause(1000, { x: 100, y: 100 }, 3000);
  assert.equal(p.tick(1500, { x: 100, y: 100 }, false), 'holding');
  assert.equal(p.progress(2500), 0.5);
  // A nudge isn't a step.
  assert.equal(p.tick(2000, { x: 100 + STILL_PX, y: 100 }, false), 'holding');
  assert.equal(p.tick(3999, { x: 101, y: 101 }, false), 'holding');
  assert.equal(p.tick(4000, { x: 101, y: 101 }, false), 'done');
  assert.equal(p.progress(9000), 1);
  // Once done it stays done, even if you walk off afterwards.
  assert.equal(p.tick(4100, { x: 300, y: 300 }, false), 'done');
});

test('moving lets go of the pause, and it stays let go', () => {
  const p = new WayPause(0, { x: 10, y: 10 }, 3000);
  assert.equal(p.tick(800, { x: 10, y: 10 + STILL_PX + 1 }, false), 'moved');
  assert.equal(p.tick(800, { x: 10, y: 10 }, false), 'moved');
  assert.equal(p.tick(5000, { x: 10, y: 10 }, false), 'moved', 'standing back still does not resume it');
});

test('a fight closing in lets go of the pause; moving is said first', () => {
  const p = new WayPause(0, { x: 0, y: 0 }, 3000);
  assert.equal(p.tick(100, { x: 0, y: 0 }, true), 'fight');
  assert.equal(p.tick(4000, { x: 0, y: 0 }, false), 'fight');
  const q = new WayPause(0, { x: 0, y: 0 }, 3000);
  assert.equal(q.tick(100, { x: 50, y: 0 }, true), 'moved');
});

test('the pause can be let go from outside (a panel took the screen)', () => {
  const p = new WayPause(0, { x: 0, y: 0 }, 3000);
  p.cancel();
  assert.equal(p.tick(3500, { x: 0, y: 0 }, false), 'moved');
  const done = new WayPause(0, { x: 0, y: 0 }, 1000);
  assert.equal(done.tick(1000, { x: 0, y: 0 }, false), 'done');
  done.cancel();
  assert.equal(done.tick(1200, { x: 0, y: 0 }, false), 'done', 'a pause already done stays done');
});

test('a bound lamp is called by its naming, or by its kind', () => {
  assert.equal(boundLampName(binding()), 'Common lamp');
  assert.equal(boundLampName(binding({ kind: 'camp' })), 'Way-lamp');
  assert.equal(boundLampName(binding({ lampName: 'First past the Whitequiet' })), 'First past the Whitequiet');
  assert.equal(WAYS_HOME_LINES.bound(binding({ kind: 'camp' })), 'Your pouch is bound to the way-lamp.');
  assert.equal(WAYS_HOME_LINES.arrivedBeside(binding({ lampName: 'First past the Whitequiet' })), 'Beside First past the Whitequiet. The ash is spent.');
  assert.equal(WAYS_HOME_LINES.boundTo(binding()), 'Bound to common lamp.');
  assert.match(WAYS_HOME_LINES.boundTo(binding({ state: 'packed' })), /Pell/);
  assert.match(WAYS_HOME_LINES.boundTo(binding({ state: 'elsewhere' })), /another world/);
  assert.equal(bindingLit(binding()), true);
  assert.equal(bindingLit(binding({ state: 'unlit' })), false);
  assert.equal(bindingLit(null), false);
});
