import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/game/session.ts';
import { bus, EV, type RelocatePayload } from '../src/game/events.ts';
import { TravelHold } from '../src/game/scenes/travel-hold.ts';
import { createNewGame } from '../src/lib/state.ts';

// The session saves through window timers; hold them so nothing writes.
(globalThis as unknown as { window: unknown }).window = { setTimeout: () => 0, clearTimeout: () => {} };

/**
 * WorldScene's two kinds of standing still (G1, 2026-10-18 step-back): a
 * Turning holding play while the land loads is not a move away. A relocation
 * the server sends during the hold (a ways-home answer) is kept and taken as
 * the hold lets go, before a position sample can write the departure point
 * over it. The scene double does what WorldScene does with the hold: steps the
 * hero for a same-area relocation, leaves for another area, and samples.
 */
function scene(session: Session) {
  const travel = new TravelHold<RelocatePayload>();
  const area = session.state.area;
  const hero = { x: session.state.position.x, y: session.state.position.y };
  const rebuilds: RelocatePayload[] = [];
  const onRelocate = (p: RelocatePayload) => {
    if (!travel.relocate(p)) return;
    if (p.area === area) {
      hero.x = p.x;
      hero.y = p.y;
      return;
    }
    rebuilds.push(p);
    travel.leave();
  };
  bus.on(EV.relocate, onRelocate);
  return {
    travel,
    hero,
    rebuilds,
    sample: () => travel.note(session.state, hero),
    hold: (on: boolean) => {
      const kept = travel.hold(on);
      if (kept) onRelocate(kept);
    },
    off: () => bus.off(EV.relocate, onRelocate)
  };
}

/** The server's answer: the hero somewhere else (link.waysHome → refresh({ relocate: true })). */
function answer(session: Session, area: string, x: number, y: number): void {
  session.applyServer({ ...session.state, area, position: { x, y } }, { vitalsSource: 'demo', importedProfile: null }, { relocate: true });
}

test('a ways-home answer arriving while a Turning holds play moves the hero once the hold lifts', () => {
  const session = new Session({ ...createNewGame(), area: 'outdoors', position: { x: 100, y: 100 } });
  const s = scene(session);
  try {
    s.hold(true);
    // The answer was in flight as the Turning began.
    answer(session, 'outdoors', 1000, 1000);
    assert.deepEqual(session.state.position, { x: 1000, y: 1000 }, 'the session took the server’s place');
    assert.deepEqual(s.hero, { x: 100, y: 100 }, 'the held hero waits');
    // Samples during the hold never write the departure point back.
    assert.equal(s.sample(), false);
    assert.deepEqual(session.state.position, { x: 1000, y: 1000 });
    // The Turning lands: the kept relocation is taken before the next sample.
    s.hold(false);
    assert.deepEqual(s.hero, { x: 1000, y: 1000 });
    assert.equal(s.sample(), true);
    assert.deepEqual(session.state.position, { x: 1000, y: 1000 }, 'the destination stays');
    assert.equal(s.rebuilds.length, 0);
  } finally {
    s.off();
  }
});

test('a relocation into another area during the hold leaves once the hold lifts, and nothing samples over it', () => {
  const session = new Session({ ...createNewGame(), area: 'outdoors', position: { x: 100, y: 100 } });
  const s = scene(session);
  try {
    s.hold(true);
    answer(session, 'outdoors', 400, 400);
    // The latest answer wins.
    answer(session, 'in:village:library', 48, 64);
    assert.equal(s.rebuilds.length, 0, 'not while held');
    s.hold(false);
    assert.deepEqual(s.rebuilds, [{ area: 'in:village:library', x: 48, y: 64 }]);
    assert.equal(s.travel.leaving, true);
    // Leaving: the next build reads the save; this sprite never writes into it.
    assert.equal(s.sample(), false);
    assert.equal(session.state.area, 'in:village:library');
    assert.deepEqual(session.state.position, { x: 48, y: 64 });
  } finally {
    s.off();
  }
});

test('the hold lets go of nothing it did not keep, and a move away drops what it kept', () => {
  const hold = new TravelHold<string>();
  assert.equal(hold.relocate('now'), true, 'unheld: applied at once');
  hold.hold(true);
  assert.equal(hold.held, true);
  assert.equal(hold.still, true);
  assert.equal(hold.relocate('kept'), false);
  // A fall while held: the scene leaves, and the next build reads the save.
  hold.leave();
  assert.equal(hold.held, false);
  assert.equal(hold.relocate('late'), false);
  assert.equal(hold.hold(false), null);
  assert.equal(hold.still, true, 'still leaving');
  // A new build starts with neither.
  hold.reset();
  assert.equal(hold.still, false);
  hold.hold(true);
  assert.equal(hold.hold(false), null);
  const state = { position: { x: 0, y: 0 } };
  assert.equal(hold.note(state, { x: 10.4, y: 19.6 }), true);
  assert.deepEqual(state.position, { x: 10, y: 20 });
});
