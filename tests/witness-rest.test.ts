import test from 'node:test';
import assert from 'node:assert/strict';
import { WitnessRest } from '../src/game/entities/witness-rest.ts';

/** The waiting warden's rest for someone else's naming ends in real time, whatever the frame rate. */

test('the rest ends at its real-time deadline, on slow frames too', () => {
  const rest = new WitnessRest();
  let rose = 0;
  rest.start(1000, 4200, () => rose++);
  // 40 ms frames (an unfocused window on a slow machine): a game-delta timer
  // clamped to 16.7 ms a frame would still be resting at 10 s.
  let now = 1000;
  let endedAt = 0;
  while (now < 1000 + 12_000) {
    now += 40;
    if (rest.tick(now)) endedAt = now;
  }
  assert.equal(rose, 1);
  assert.ok(endedAt >= 5200 && endedAt < 5200 + 40, `ended at ${endedAt - 1000} ms`);
  assert.equal(rest.resting(now), false);
});

test('a later naming lengthens the rest, and only its end is told', () => {
  const rest = new WitnessRest();
  const told: string[] = [];
  rest.start(0, 4200, () => told.push('first'));
  assert.equal(rest.tick(2000), false);
  rest.start(2000, 4200, () => told.push('second'));
  assert.equal(rest.tick(4300), false, 'still resting for the second');
  assert.ok(rest.resting(4300));
  assert.equal(rest.tick(6200), true);
  assert.deepEqual(told, ['second']);
  assert.equal(rest.tick(9000), false, 'once');
});

test('cleared, nothing is told', () => {
  const rest = new WitnessRest();
  let rose = 0;
  rest.start(0, 100, () => rose++);
  rest.clear();
  assert.equal(rest.tick(500), false);
  assert.equal(rose, 0);
});
