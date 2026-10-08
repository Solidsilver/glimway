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
