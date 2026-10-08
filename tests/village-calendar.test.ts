import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The village's calendar against the dev clock: a server read that comes
 * back after the clock moved must not put the real date back (the HUD
 * stayed on today; village, residents and review5 specs flaked on it).
 */

const timers: (() => void)[] = [];
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void) => (timers.push(fn), timers.length),
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void) => (timers.push(fn), timers.length);

const { villageFor } = await import('../src/game/village.ts');
const { setGameNow } = await import('../src/game/clock.ts');
const { calendarAt } = await import('../src/lib/calendar.ts');
const { createNewGame } = await import('../src/lib/state.ts');

test('a server calendar that lands after the dev clock moved gives way to the moved day', async () => {
  let answer!: (v: unknown) => void;
  const today = calendarAt(Math.floor(Date.now() / 1000));
  const session = {
    state: createNewGame(),
    link: { api: { calendar: () => new Promise((r) => (answer = r)) } },
  } as never;
  const village = villageFor(session);
  const reading = village.loadCalendar();
  // The dev clock moves to another wick while the server's read is out.
  const moved = today.startsAt + 9 * 7 * 86400 + 3600;
  village.setDevNow(moved);
  answer(today);
  const shown = await reading;
  assert.equal(village.calendarSource, 'local');
  assert.deepEqual(shown, calendarAt(moved));
  assert.notEqual(village.calendar.wickNumber, today.wickNumber);
  setGameNow(null);
});
