import test from 'node:test';
import assert from 'node:assert/strict';
import { BESIDE_PX, HOP_PX, SETTLE_MS, TRAIL_PX, followStep, hopAt, startState, type FollowInput, type PetState } from '../src/game/entities/pet-follower.ts';
import { STEP_MS } from '../src/game/hero-motion.ts';

const input = (o: Partial<FollowInput> = {}): FollowInput => ({ x: 100, y: 100, walking: false, faceRight: false, seat: null, viewMidX: 200, time: 0, dt: 16, ...o });

/** Run frames until the pet stops moving (or a cap). */
function run(s: PetState, o: (t: number) => Partial<FollowInput>, from: number, frames: number): PetState {
  let state = s;
  for (let f = 0; f < frames; f++) {
    const time = from + f * 16;
    state = followStep(state, input({ time, ...o(time) }));
  }
  return state;
}

test('pet follower: it trails behind, on the side away from where the hero faces', () => {
  const s = run(startState(100, 100), () => ({ walking: true, faceRight: true }), 0, 300);
  assert.ok(Math.abs(s.x - (100 - TRAIL_PX)) < 0.5, `x ${s.x}`);
  const left = run(s, () => ({ walking: true, faceRight: false }), 5000, 300);
  assert.ok(Math.abs(left.x - (100 + TRAIL_PX)) < 0.5, `x ${left.x}`);
  assert.equal(left.pose, 'follow');
});

test('pet follower: it turns to face where it is going', () => {
  let s = startState(100, 100);
  s = followStep(s, input({ x: 300, walking: true, faceRight: true }));
  assert.equal(s.faceRight, true);
  s = run(s, () => ({ x: -200, walking: true, faceRight: false }), 16, 10);
  assert.equal(s.faceRight, false);
});

test('pet follower: after about 6 s standing it settles beside the hero, away from the camera edge, and stays', () => {
  // Walk until t=1000, then stand.
  let s = run(startState(100, 100), (t) => ({ walking: t < 1000 }), 0, 100);
  assert.equal(s.pose, 'follow');
  s = run(s, () => ({}), 1600, Math.ceil(SETTLE_MS / 16) + 200);
  assert.equal(s.pose, 'settled');
  // The hero (x 100) is left of the view's middle (200): the pet sits on the right.
  assert.ok(Math.abs(s.x - (100 + BESIDE_PX)) < 0.5, `x ${s.x}`);
  assert.equal(s.faceRight, false, 'it faces its hero');
  const later = run(s, () => ({ viewMidX: 0 }), 20000, 50);
  assert.equal(later.side, s.side, 'a settled pet does not hop sides when the camera moves');
  // Near the right edge it settles on the left.
  const right = run(startState(400, 100), () => ({ x: 400, viewMidX: 200 }), SETTLE_MS + 10, 300);
  assert.ok(Math.abs(right.x - (400 - BESIDE_PX)) < 0.5, `x ${right.x}`);
});

test('pet follower: it sits when the hero sits, at the seat\'s side', () => {
  const s = run(startState(100, 100), () => ({ seat: { x: 150, y: 120, facing: 'right' } }), 0, 300);
  assert.equal(s.pose, 'sit');
  assert.ok(Math.abs(s.x - (150 - BESIDE_PX)) < 0.5);
  const l = run(s, () => ({ seat: { x: 150, y: 120, facing: 'left' } }), 6000, 300);
  assert.ok(Math.abs(l.x - (150 + BESIDE_PX)) < 0.5);
});

test('pet follower: hops are 2 px on every other step, only moving, never with reduced motion', () => {
  assert.equal(hopAt(STEP_MS * 1 + 1, true, false), -HOP_PX);
  assert.equal(hopAt(STEP_MS * 2 + 1, true, false), 0);
  assert.equal(hopAt(STEP_MS + 1, false, false), 0);
  assert.equal(hopAt(STEP_MS + 1, true, true), 0);
});

test('pet follower: the follow does not depend on the frame rate', () => {
  const at60 = run(startState(0, 100), () => ({ walking: true, faceRight: true }), 0, 30);
  let at30 = startState(0, 100);
  for (let f = 0; f < 15; f++) at30 = followStep(at30, input({ walking: true, faceRight: true, time: f * 32, dt: 32 }));
  assert.ok(Math.abs(at60.x - at30.x) < 0.5, `${at60.x} vs ${at30.x}`);
});
