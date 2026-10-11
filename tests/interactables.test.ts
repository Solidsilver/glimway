import test from 'node:test';
import assert from 'node:assert/strict';
import { Interactables, type Interactable } from '../src/game/entities/interactables.ts';
import { bus, EV, type PromptPayload } from '../src/game/events.ts';

/**
 * The one interaction loop (src/game/entities/interactables.ts): features
 * register points, and the target is the highest rank in reach, then the
 * nearest. No markers here (they're built with the scene), so a bare scene
 * object is enough.
 */

const scene = {} as ConstructorParameters<typeof Interactables>[0];
const point = (id: string, x: number, y: number, more: Partial<Interactable> = {}): Interactable =>
  ({ id: id as Interactable['id'], x, y, label: id, activate: () => {}, ...more });
const hero = { x: 100, y: 100 };

function prompts(fn: () => void): PromptPayload[] {
  const seen: PromptPayload[] = [];
  const on = (p: PromptPayload) => seen.push(p);
  bus.on(EV.prompt, on);
  try {
    fn();
  } finally {
    bus.off(EV.prompt, on);
  }
  return seen;
}

test('the nearest point in reach is the target; out of reach is nothing', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  it.register('a', [point('touch:near', 110, 100), point('touch:far', 125, 100)]);
  it.update(hero, 0);
  assert.equal(it.currentTarget?.id, 'touch:near');
  it.update({ x: 200, y: 200 }, 0);
  assert.equal(it.currentTarget, null);
});

test('a higher rank wins over a nearer point, and each point has its own reach', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  it.register('people', [point('mara', 104, 100)]);
  it.register('wilds', [point('wilds:camp', 140, 100, { rank: 1, reach: 44 })]);
  it.update(hero, 0);
  assert.equal(it.currentTarget?.id, 'wilds:camp');
  it.update({ x: 90, y: 100 }, 0);
  assert.equal(it.currentTarget?.id, 'mara', 'the camp is 50 px off: out of its reach');
});

test('an unavailable point is passed over, and the prompt says what the target offers', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  let open = false;
  it.register('gather', [point('gather:3,4', 102, 100, { available: () => open, label: () => 'Chop the oak', verb: 'Chop' })]);
  it.register('touches', [point('touch:bench', 120, 100, { verb: 'Sit' })]);
  const first = prompts(() => it.update(hero, 0));
  assert.equal(it.currentTarget?.id, 'touch:bench');
  open = true;
  const second = prompts(() => it.update(hero, 0));
  assert.equal(it.currentTarget?.id, 'gather:3,4');
  assert.deepEqual(first, [{ label: 'touch:bench', verb: 'Sit' }]);
  assert.deepEqual(second, [{ label: 'Chop the oak', verb: 'Chop' }]);
});

test('registering again replaces the owner\'s points; a used-up point goes', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  const owner = {};
  it.register(owner, [point('paper:a', 105, 100, { activate: () => true }), point('paper:b', 300, 300)]);
  it.update(hero, 0);
  assert.equal(it.activate(), true);
  assert.deepEqual(it.list.map((p) => p.id), ['paper:b']);
  it.register(owner, [point('library', 300, 300)]);
  assert.deepEqual(it.list.map((p) => p.id), ['library']);
  it.update(hero, 0);
  assert.equal(it.activate(), false, 'nothing in reach');
});

test('a click finds a usable point under the cursor and in reach', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  it.register('a', [point('touch:sign', 120, 110), point('touch:shut', 100, 110, { available: () => false })]);
  assert.equal(it.pointAt({ x: 121, y: 101 }, hero)?.id, 'touch:sign');
  assert.equal(it.pointAt({ x: 100, y: 102 }, hero), null);
});

test('a click uses each point’s click reach: 40 px by default, the working reach where the server measures', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  // A Wilds chest at (88, 96), as the review's case: its claim reaches 44 px.
  it.register('wilds', [point('wilds:chest', 88, 96, { reach: 44, clickReach: 44, rank: 1 })]);
  it.register('touches', [point('touch:sign', 200, 96)]);
  const cursor = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - 8 });
  assert.equal(it.pointAt(cursor({ x: 88, y: 96 }), { x: 88, y: 140 })?.id, 'wilds:chest', '44 px: in reach');
  assert.equal(it.pointAt(cursor({ x: 88, y: 96 }), { x: 88, y: 145 }), null, '49 px: the server would refuse it');
  assert.equal(it.pointAt(cursor({ x: 200, y: 96 }), { x: 200, y: 136 })?.id, 'touch:sign', '40 px for a sign, as before');
  assert.equal(it.pointAt(cursor({ x: 200, y: 96 }), { x: 200, y: 137 }), null);
});

test('a second choice on its own key rides with the prompt, and a change to it alone is news', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  let landed = false;
  it.register('fishing', [point('fish:line', 104, 100, { label: () => (landed ? 'Mill Roach! Keep it' : 'Pull the line in'), verb: () => (landed ? 'Keep' : 'Pull in'), alt: () => (landed ? { key: 'Q', label: 'Let it go' } : null) })]);
  assert.deepEqual(prompts(() => it.update(hero, 0)), [{ label: 'Pull the line in', verb: 'Pull in' }]);
  landed = true;
  assert.deepEqual(prompts(() => it.update(hero, 0)), [{ label: 'Mill Roach! Keep it', verb: 'Keep', alt: { key: 'Q', label: 'Let it go' } }]);
  assert.deepEqual(prompts(() => it.update(hero, 0)), [], 'said once');
});

test('pick answers for any feet what update would choose standing there (playtests read it: __fsTarget)', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  it.register('a', [point('touch:near', 110, 100), point('wilds:camp', 140, 100, { rank: 1, reach: 44 })]);
  for (const at of [hero, { x: 90, y: 100 }, { x: 200, y: 200 }]) {
    it.update(at, 0);
    assert.equal(it.pick(at), it.currentTarget);
  }
  const seen = it.debugTarget({ x: 90, y: 100 }, false);
  assert.equal(seen.target?.id, 'touch:near');
  assert.deepEqual(seen.near.map((p) => [p.id, p.usable]), [['touch:near', true]]);
});

// The open map's thicket and a fern three rows north (review 2026-10-11, game F4 /
// server 5): standing on a tile beside the thicket, the fern's dig point
// (gathering: tileBottom + 8, 36 px reach, rank 0) is 32 px from the hero's
// feet, and a dig in reach outranks clearing (paths: tileBottom, 56 px, rank -1)
// however near the thicket is. A spot search that rules ferns out by a square of
// tiles misses it; e2e/paths.spec.ts asks for the elected target instead.
test('with the spade in hand, a fern three rows north takes the prompt from the thicket beside you', () => {
  const it = new Interactables(scene, { reducedMotion: true });
  const stand = { tx: 10, ty: 10 };
  const feet = { x: stand.tx * 16 + 8, y: stand.ty * 16 + 8 };
  const fern = point('gather:10,7', stand.tx * 16 + 8, (stand.ty - 3) * 16 + 16 + 8, { reach: 36, label: 'Dig for seedlings' });
  const thicket = point('wilds:path-clear', (stand.tx + 1) * 16 + 8, stand.ty * 16 + 16, { reach: 56, rank: -1, label: 'Clear the thicket' });
  it.register('gathering', [fern]);
  it.register('paths', [thicket]);
  assert.equal(Math.hypot(feet.x - fern.x, feet.y - fern.y), 32);
  assert.equal(it.pick(feet)?.id, 'gather:10,7');
  // Half a tile further south the fern is out of reach, and the thicket (still in its own) has the prompt.
  assert.equal(it.pick({ x: feet.x, y: feet.y + 8 })?.id, 'wilds:path-clear');
});
