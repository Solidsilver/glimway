import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarAt } from '../src/lib/calendar.ts';
import {
  assetPhrase,
  batchesAffordable,
  effectiveBatches,
  blankProjects,
  calendarLine,
  contributionLimits,
  mailBuckets,
  movableAssets,
  nextFestival,
  ordinal,
  settledLine,
  papersDue,
  projectProgress,
  RECIPES,
  turningNotice,
} from '../src/lib/village.ts';
import type { Mail } from '../src/lib/api/types.ts';

const EPOCH = Date.parse('2026-01-05T00:00:00Z') / 1000;
const DAY = 86400;

test('ordinals read naturally', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st']);
});

test('the date line names the wick, the day and the Mark (and a festival)', () => {
  // Sap is the 8th wick: 7 wicks of 7 days in, then the 3rd day.
  const sap3 = calendarAt(EPOCH + (7 * 7 + 2) * DAY + 3600);
  assert.equal(calendarLine(sap3), 'Sap-wick, 3rd day — Amberfall');
  const carting = calendarAt(EPOCH + (5 * 7 + 5) * DAY);
  assert.equal(carting.festival, 'Carting Day');
  assert.equal(calendarLine(carting), 'Cart-wick, 6th day — Carting · Carting Day');
});

test('Elara posts the Turning a day ahead, and says when before that', () => {
  const lastDay = calendarAt(EPOCH + 6 * DAY + 10);
  assert.deepEqual(turningNotice(lastDay, EPOCH + 6 * DAY + 10, 'en-GB'), { text: 'Dark of Thaw-wick — the outer Wilds will turn.', soon: true });
  const early = calendarAt(EPOCH + DAY);
  const n = turningNotice(early, EPOCH + DAY, 'en-GB');
  assert.equal(n.soon, false);
  assert.match(n.text, /in 6 days/);
});

test('the next festival is found ahead, today included', () => {
  assert.equal(nextFestival(EPOCH)!.name, 'The Breaking');
  const f = nextFestival(EPOCH + DAY)!;
  assert.equal(f.name, 'Carting Day');
  assert.equal(f.at, EPOCH + (5 * 7 + 5) * DAY);
});

test('you can give a project what you carry, never more than it still needs', () => {
  const p = { required: { timber: 200, stone: 80 }, contributed: { timber: 190, stone: 0 } };
  assert.deepEqual(contributionLimits(p, { timber: 50, stone: 3 }), { timber: 10, stone: 3 });
  assert.equal(Math.round(projectProgress(p) * 100), 68);
  assert.equal(blankProjects().length, 6);
});

test('late project papers wait for the lit road', () => {
  const held = (id: string) => id === 'adas-oil-receipts';
  const grantable = ['adas-oil-receipts', 'note-in-the-linseed-box', 'marens-notes-on-hubs-and-tyres'];
  assert.deepEqual(papersDue(grantable, held, false), ['marens-notes-on-hubs-and-tyres']);
  assert.deepEqual(papersDue(grantable, held, true), ['note-in-the-linseed-box', 'marens-notes-on-hubs-and-tyres']);
});

test('recipes: batches the pack pays for, capped at the server’s 100', () => {
  const table = RECIPES.find((r) => r.id === 'craft-oak-table')!;
  assert.equal(batchesAffordable(table, { timber: 17, fiber: 9 }), 2);
  assert.equal(batchesAffordable(table, { timber: 17 }), 0);
  const peg = RECIPES.find((r) => r.id === 'craft-wooden-peg')!;
  assert.equal(batchesAffordable(peg, { timber: 10_000 }), 100);
});

test('only unplaced decorations can move; materials list first', () => {
  const counts = { materials: { timber: 4, stone: 0 }, items: { 'tin-whistle': 1 }, decorations: { 'wooden-stool': 2, 'potted-fern': 1 } };
  const placed = [
    { id: 'a', itemDef: 'wooden-stool', scene: 'outdoor' as const, x: 0, y: 0, rotation: 0 as const },
    { id: 'b', itemDef: 'potted-fern', scene: 'indoor' as const, x: 0, y: 0, rotation: 0 as const },
  ];
  assert.deepEqual(movableAssets(counts, placed), [
    { kind: 'material', id: 'timber', qty: 4 },
    { kind: 'item', id: 'tin-whistle', qty: 1 },
    { kind: 'decoration', id: 'wooden-stool', qty: 1 },
  ]);
  assert.equal(assetPhrase({ kind: 'item', id: 'tin-whistle', qty: 1 }), 'a Tin Whistle');
  assert.equal(assetPhrase({ kind: 'material', id: 'timber', qty: 12 }), '12 timber');
  assert.equal(assetPhrase({ kind: 'decoration', id: 'wooden-stool', qty: 2 }), '2 Wooden Stools');
});

test('the mailbox sorts waiting, outgoing (recallable) and settled mail', () => {
  const m = (id: string, from: string, to: string, claimedAt: number | null, returnedAt?: number | null): Mail => ({
    id, worldId: 'w', fromId: from, toId: to, fromName: from, toName: to, asset: { kind: 'material', id: 'timber', qty: 1 }, sentAt: 1, claimedAt, ...(returnedAt !== undefined ? { returnedAt } : {}),
  });
  const b = mailBuckets([m('1', 'bob', 'me', null), m('2', 'me', 'bob', null), m('3', 'bob', 'me', 5), m('4', 'me', 'bob', null, 9)], 'me');
  assert.deepEqual(b.waiting.map((x) => x.id), ['1']);
  assert.deepEqual(b.outgoing.map((x) => x.id), ['2']);
  assert.deepEqual(b.history.map((x) => x.id), ['3', '4']);
});

test('settled mail says how it ended', () => {
  const m = (claimedAt: number | null, returnReason: Mail['returnReason']): Mail => ({ id: 'x', worldId: 'w', fromId: 'a', toId: 'b', fromName: 'a', toName: 'b', asset: { kind: 'item', id: 'tin-whistle', qty: 1 }, sentAt: 1, claimedAt, returnedAt: claimedAt ? null : 9, returnReason });
  assert.equal(settledLine(m(5, null)), 'collected');
  assert.equal(settledLine(m(null, 'recalled')), 'recalled');
  assert.equal(settledLine(m(null, 'expired')), 'returned after 30 days');
  assert.equal(settledLine(m(null, 'recipient-removed')), 'returned: they left the world');
});

test('the craft batch sent is the one shown, clamped to what is affordable now', () => {
  assert.equal(effectiveBatches(3, 4), 3);
  assert.equal(effectiveBatches(3, 1), 1, 'stock ran low: the stale choice of 3 is not sent');
  assert.equal(effectiveBatches(undefined, 0), 1, 'unaffordable still shows one batch');
  assert.equal(effectiveBatches(0, 5), 1);
});
