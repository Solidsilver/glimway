/**
 * This wick's rumour and the turning (docs/design/open-map.md 2.10): a
 * rumour read before the turning is the last wick's, so until the state is
 * read again Elara names no place, and the rumour watch keeps asking for the
 * read until it lands. (Round 3: near a turning, the screen could name the
 * last wick's find for as long as the read took, or a whole wick when the
 * one read the turning asked for didn't happen.)
 */
import './helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

const { calendarAt } = await import('../src/lib/calendar.ts');
const { rumourOfThisWick, rumourSentence } = await import('../src/lib/wilds/rumour.ts');
const { elaraRumourChoice, ELARA_RUMOUR } = await import('../src/content/open-map.ts');
const { setGameNow } = await import('../src/game/clock.ts');
const { watchRumour, forgetRumourWatch } = await import('../src/game/rumour-watch.ts');
const { bus, EV } = await import('../src/game/events.ts');
const { online, rig, S, tick } = await import('./helpers/link-rig.ts');

/** A turning a while from now (never a fixed date). */
const turning = calendarAt(Math.floor(Date.now() / 1000) + 30 * 86400).nextTurning;

const RUMOUR = { epoch: 'wick-a', place: 'place:1:-1', site: 'rumour:3:-3', landmark: 'split-oak', compass: 'ne', ring: 2, pastRiver: false, opened: false };
const withRumour = (version: number, r = RUMOUR) => ({ ...S({ version }), rumour: r });

test('a rumour read before the turning is the last wick’s; one read after is this wick’s', () => {
  assert.equal(rumourOfThisWick(turning - 60, turning - 1), true);
  assert.equal(rumourOfThisWick(turning - 60, turning + 60), false, 'read a minute before, asked a minute after');
  assert.equal(rumourOfThisWick(turning + 1, turning + 3600), true);
  assert.equal(rumourOfThisWick(null, turning), false, 'never read on this page');
  assert.equal(rumourOfThisWick(turning - 0.5, turning + 0.25), false, 'the world’s clock in fractions of a second');
});

test('the link holds its rumour stale from the turning until a read lands after it', async (t) => {
  t.after(() => setGameNow(null));
  setGameNow(turning - 120);
  const r = await rig(t);
  await online(r, withRumour(1));
  assert.equal(r.link.rumour?.epoch, 'wick-a');
  assert.equal(r.link.rumourStale, false, 'read this wick');
  // The turning passes; nothing has been read since.
  setGameNow(turning + 30);
  assert.equal(r.link.rumourStale, true, 'its rumour is the last wick’s now');
  // The read the turning asks for brings this wick's.
  r.server.on('GET /api/state', { body: { state: withRumour(2, { ...RUMOUR, epoch: 'wick-b', landmark: 'meadow-oak', site: 'rumour:2:-7' }), leaseActive: true } });
  await r.link.refreshState();
  assert.equal(r.link.rumour?.epoch, 'wick-b');
  assert.equal(r.link.rumourStale, false);
});

test('Elara names no place from the last wick: she says it has turned', () => {
  const told = elaraRumourChoice('turned');
  assert.equal(told.text, ELARA_RUMOUR.ask);
  assert.deepEqual(told.reply, [ELARA_RUMOUR.turned]);
  assert.ok(!told.reply.join(' ').includes(rumourSentence(RUMOUR)));
  // This wick's, read: the place, as before.
  assert.ok(elaraRumourChoice(RUMOUR).reply.join(' ').includes(rumourSentence(RUMOUR)));
});

test('the rumour watch asks for the read again, each check, until it lands', async (t) => {
  t.after(() => forgetRumourWatch());
  let asked = 0;
  const link = { rumourStale: true, refreshState: async () => void asked++ };
  watchRumour({ link } as never);
  assert.equal(asked, 1, 'stale on the first look: a read');
  // The read didn't land (an answer pending, or offline): the next look asks again.
  (bus.emit as (e: string) => void)(EV.clock);
  await tick();
  assert.equal(asked, 2);
  link.rumourStale = false;
  (bus.emit as (e: string) => void)(EV.clock);
  assert.equal(asked, 2, 'landed: no more reads until the next turning');
});
