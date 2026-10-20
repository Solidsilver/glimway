import test from 'node:test';
import assert from 'node:assert/strict';
import { FadeHold } from '../src/game/scenes/fade-hold.ts';

/**
 * WorldScene's dark start: the build's hold lifts once (its paint in, or the
 * timer), and only a newer build or a move away takes the fade-in from it.
 * A Turning that holds play as the scene starts is neither, so the world
 * still fades in (it once stayed dark under a live HUD).
 */

test('the hold lifts once, whichever of the paint or the timer comes first', () => {
  const hold = new FadeHold();
  const lift = hold.start();
  assert.equal(hold.active, true);
  assert.equal(lift(), true);
  assert.equal(hold.active, false);
  assert.equal(lift(), false);
});

test('a move away during the hold takes its fade-in (the move fades out instead)', () => {
  const hold = new FadeHold();
  const lift = hold.start();
  hold.cancel();
  assert.equal(hold.active, false);
  assert.equal(lift(), false);
});

test('a newer build’s hold is its own: the old one’s lift does nothing to it', () => {
  const hold = new FadeHold();
  const old = hold.start();
  hold.cancel();
  const lift = hold.start();
  assert.equal(old(), false);
  assert.equal(hold.active, true);
  assert.equal(lift(), true);
});
