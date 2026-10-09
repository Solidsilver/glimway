/** Fishing in the game (docs/design/crafts.md 5, lane G): the banks, a cast's phases, the float, the words. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandFrom,
  bandLine,
  bankFor,
  bankNear,
  bankOpen,
  castPhase,
  castReachPx,
  FISHING,
  fishingRefusal,
  FISHING_FALLBACK,
  floatTile,
  leaveReachPx,
  nextCastAt,
  predictedCast,
  rodPose,
  settleEnds,
  slippedOff,
  STILL_LINE,
  waterFor,
} from '../src/lib/fishing.ts';
import { calendarAt, CALENDAR } from '../src/lib/clock.ts';
import { ITEM_ERRORS } from '../src/content/errors.ts';

const POND = 'water:village:mill-pond';
const mid = (t: number) => t * 16 + 8;
/** The village pond (src/game/worlds.ts): water at 33–38 × 19–22, and the race at 32 × 20–22. */
const isWater = (tx: number, ty: number) => (tx >= 33 && tx <= 38 && ty >= 19 && ty <= 22) || (tx === 32 && ty >= 20 && ty <= 22);

test('the banks come from the content, and you cast from within a tile and a half of one', () => {
  assert.equal(castReachPx(), 24);
  assert.equal(leaveReachPx(), castReachPx(), 'standing anywhere the server takes a cast from never pulls the line in');
  assert.equal(bankNear('village', mid(36), mid(18))?.bank.id, 'north');
  assert.equal(bankNear('village', mid(39), mid(21))?.bank.id, 'east');
  assert.equal(bankNear('village', mid(32), mid(19))?.bank.id, 'race');
  assert.equal(bankNear('village', mid(32), mid(18))?.bank.id, 'race', 'a step back is still the bank');
  assert.equal(bankNear('village', mid(20), mid(18)), null);
  assert.equal(bankNear('woodland', mid(36), mid(18)), null, 'banks belong to their area');
  assert.equal(bankNear('village', mid(36), mid(18))?.water.id, POND);
});

test('the race is open all year; the north and east banks ice over in the Quiet', () => {
  const pond = waterFor(POND)!;
  const north = bankFor(pond, 'north')!;
  const race = bankFor(pond, 'race')!;
  for (const mark of new Set(CALENDAR.marks)) {
    assert.equal(bankOpen(race, mark), true, mark);
    assert.equal(bankOpen(north, mark), mark !== 'Quiet', mark);
  }
  assert.ok(calendarAt(0).mark, 'the calendar names a mark');
});

test('the float lands on the water in the bank’s facing, the race’s below the wheel', () => {
  const pond = waterFor(POND)!;
  assert.deepEqual(floatTile(bankFor(pond, 'north')!, mid(35), mid(18), isWater), { tx: 35, ty: 21 });
  assert.deepEqual(floatTile(bankFor(pond, 'east')!, mid(39), mid(20), isWater), { tx: 36, ty: 20 });
  // The wheel turns over (32, 20–21): the race's float goes to its foot.
  assert.deepEqual(floatTile(bankFor(pond, 'race')!, mid(32), mid(19), isWater), { tx: 32, ty: 22 });
  // From the bank tile nearest the hero.
  assert.deepEqual(floatTile(bankFor(pond, 'north')!, mid(38) + 6, mid(18), isWater), { tx: 38, ty: 21 });
  // Only as far as the water goes; none at all when the first tile out is dry.
  assert.deepEqual(floatTile(bankFor(pond, 'north')!, mid(35), mid(18), (tx, ty) => ty === 19), { tx: 35, ty: 19 });
  assert.equal(floatTile(bankFor(pond, 'north')!, mid(35), mid(18), () => false), null);
});

test('a cast waits for the bite, holds the fish, then lets it slip', () => {
  const cast = { readyAt: 1010, holdUntil: 1610 };
  assert.equal(castPhase(cast, 1000), 'waiting');
  assert.equal(castPhase(cast, 1010), 'ready');
  assert.equal(castPhase(cast, 1609.9), 'ready');
  assert.equal(castPhase(cast, 1610), 'lapsed');
});

test('a predicted cast takes its band’s wait, then the hold', () => {
  assert.deepEqual(predictedCast('healthy', 1000), { readyAt: 1010, holdUntil: 1610 });
  assert.deepEqual(predictedCast('low', 1000), { readyAt: 1030, holdUntil: 1630 });
  assert.deepEqual(predictedCast('very-low', 1000), { readyAt: 1060, holdUntil: 1660 });
  // A band this build doesn't know: the first band's wait.
  assert.deepEqual(predictedCast('mystery', 1000), { readyAt: 1000 + FISHING.bands[0]!.waitSeconds, holdUntil: 1000 + FISHING.bands[0]!.waitSeconds + FISHING.holdSeconds });
  assert.equal(nextCastAt(null), 0);
  assert.equal(nextCastAt(1000), 1008);
});

test('the banks read the water in words; refusals are plain', () => {
  assert.equal(bandLine('healthy'), 'Little rings among the reeds.');
  assert.equal(bandLine('very-low'), 'Very still here. Try another bank, or let it rest.');
  assert.equal(bandLine('still'), STILL_LINE);
  assert.equal(bandLine(''), null);
  assert.equal(bandLine(undefined), null);
  for (const code of ['already-casting', 'cast-too-soon', 'water-still', 'no-cast', 'not-yet', 'wrong-tool', 'too-far-away', 'offline']) {
    const words = fishingRefusal(code);
    assert.notEqual(words, FISHING_FALLBACK, code);
    assert.ok(!words.includes(code), `${code} is said in words, not as its code`);
  }
  assert.equal(fishingRefusal('something-new'), FISHING_FALLBACK);
});

test('the rod is held out toward the float, a little above its line, and mirrored to the left', () => {
  const hand = { x: 100, y: 100 };
  const right = rodPose(hand, { x: 140, y: 100 }, 1);
  assert.equal(right.flipX, false);
  assert.ok(right.tip.x > hand.x && right.tip.y < hand.y, 'tip up and out to the right');
  const left = rodPose(hand, { x: 60, y: 100 }, 1);
  assert.equal(left.flipX, true);
  assert.ok(Math.abs(left.tip.x - (2 * hand.x - right.tip.x)) < 1e-9 && Math.abs(left.tip.y - right.tip.y) < 1e-9, 'the mirror image');
  assert.ok(Math.abs(left.rotation + right.rotation) < 1e-9);
  // Down the race: the tip reaches down toward the water, but never straight down.
  const down = rodPose(hand, { x: 101, y: 160 }, 1);
  assert.ok(down.tip.y > hand.y);
  assert.ok(Math.atan2(down.tip.y - hand.y, down.tip.x - hand.x) <= 1.1 + 1e-9);
  // The tip is the rod's length from the grip, whatever the angle.
  for (const p of [right, left, down]) assert.ok(Math.abs(Math.hypot(p.tip.x - hand.x, p.tip.y - hand.y) - Math.hypot(115, 53) / 4) < 1e-9);
});

test('an empty water reads as still, however the server spells it', () => {
  assert.equal(bandFrom(''), 'still');
  assert.equal(bandFrom('still'), 'still');
  assert.equal(bandFrom('low'), 'low');
  assert.equal(bandLine(bandFrom('')), STILL_LINE);
});

test('a fish slips off after the hold, whether it’s on the line or reeled onto the bank', () => {
  const cast = { readyAt: 1010, holdUntil: 1610 };
  assert.equal(slippedOff(null, null, 5000), false, 'nothing out');
  assert.equal(slippedOff(cast, null, 1609), false);
  assert.equal(slippedOff(cast, null, 1610), true);
  // Reeled in but not yet kept: the server refuses a settle after hold_until, so it goes then too.
  assert.equal(slippedOff(null, cast, 1609), false);
  assert.equal(slippedOff(null, cast, 1610), true);
});

test('only a definitive settle refusal takes the fish off the bank; a transient one keeps it there', () => {
  for (const code of ['no-cast', 'not-yet', 'wrong-tool']) assert.equal(settleEnds(code), true, code);
  for (const code of ['busy', 'pending', 'offline', 'unknown', 'superseded', 'bad-response']) assert.equal(settleEnds(code), false, code);
});

test('a lost answer is said as the rest of the game says it: it may have gone through', () => {
  assert.equal(fishingRefusal('pending'), ITEM_ERRORS.pending);
  assert.equal(fishingRefusal('resolved'), ITEM_ERRORS.resolved);
});
