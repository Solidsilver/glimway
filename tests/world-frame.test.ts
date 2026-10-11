import test from 'node:test';
import assert from 'node:assert/strict';
import { playHold, runFrame, type PlayHold, type WorldFrame } from '../src/game/scenes/world-frame.ts';

/**
 * WorldScene's frame (shared-fights.md 1.8, lane F-A): observation runs
 * every frame, held or not; this player's play only when nothing holds it.
 */

const free = { ui: false, transitioning: false, cinematic: false, persisting: false, placing: false };

test('play is held by a panel, a transition, a cinematic, a sync’s write or placing a piece; else it runs', () => {
  assert.equal(playHold(free), null);
  const reasons: [keyof typeof free, PlayHold][] = [
    ['ui', 'ui'],
    ['transitioning', 'transition'],
    ['cinematic', 'cinematic'],
    ['persisting', 'persisting'],
    ['placing', 'placing']
  ];
  for (const [key, why] of reasons) assert.equal(playHold({ ...free, [key]: true }), why);
});

function recorder(hold: () => PlayHold | null) {
  const log: string[] = [];
  const frame: WorldFrame = {
    observe: (t, dt) => log.push(`observe ${t} ${dt}`),
    hold: () => {
      log.push('hold?');
      return hold();
    },
    still: (t, dt) => log.push(`still ${t} ${dt}`),
    play: (t, dt) => log.push(`play ${t} ${dt}`)
  };
  return { frame, log };
}

test('a frame observes first, then plays', () => {
  const { frame, log } = recorder(() => null);
  runFrame(frame, 1000, 0.016);
  assert.deepEqual(log, ['observe 1000 0.016', 'hold?', 'play 1000 0.016']);
});

test('observation goes on while play is held (a menu open): the hero holds still instead of playing', () => {
  for (const why of ['ui', 'transition', 'cinematic', 'persisting', 'placing'] as const) {
    const { frame, log } = recorder(() => why);
    runFrame(frame, 5, 0.05);
    assert.deepEqual(log, ['observe 5 0.05', 'hold?', 'still 5 0.05'], why);
  }
});

test('the hold is asked after observing, so observation can start or end it the same frame', () => {
  let held: PlayHold | null = 'ui';
  const { frame, log } = recorder(() => held);
  const observe = frame.observe;
  frame.observe = (t, dt) => {
    observe(t, dt);
    held = null; // the panel closed while observing
  };
  runFrame(frame, 0, 0.01);
  assert.deepEqual(log, ['observe 0 0.01', 'hold?', 'play 0 0.01']);
});
