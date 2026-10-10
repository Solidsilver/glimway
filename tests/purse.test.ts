import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '@bufbuild/protobuf';
import { PurseLineSchema, PurseReadSchema, PurseSchema, PurseTopUpSchema } from '../src/lib/gen/glimway/v1/purse_pb.js';
import { PlayerStateSchema } from '../src/lib/gen/glimway/v1/state_pb.js';
import {
  habiticaGoldOf,
  lineText,
  logDate,
  parseAmount,
  parseBuy,
  purseLog,
  purseOf,
  sellerChoices,
  signed,
  topUpOutcome,
  topUpView,
  GLIMS_PER_DAY,
  GOLD_PER_GLIM,
  goldFor,
  maxGlims,
  TOP_UPS_PER_DAY,
  type TopUpView,
} from '../src/lib/purse.ts';
import { predict, predictGlims, type Prediction } from '../src/lib/api/predict.ts';
import { glimsCount, glimsPhrase, purseCopy } from '../src/content/purse.ts';
import { createNewGame } from '../src/lib/state.ts';
import { ITEM_ERRORS, PURSE_ERRORS, VILLAGE_ERRORS, purseErrorText } from '../src/content/errors.ts';
import { sellerFor } from '../src/lib/items.ts';
import { assetPhrase } from '../src/lib/village.ts';
import { emptyRecord, normalizeRecord } from '../src/lib/api/outbox.ts';

const topUp = (over: Partial<TopUpView> = {}): TopUpView => ({ id: 't1', amount: 40, glims: 20, state: 'moved', goldBefore: 1240, goldAfter: 1200, startedAt: 1_760_000_000, settledAt: 1_760_000_002, leftover: false, note: '', ...over });

test('an amount is a whole number from 1 to the most allowed, and nothing else', () => {
  assert.equal(parseAmount('', 100), null);
  assert.equal(parseAmount('0', 100), null);
  assert.equal(parseAmount('1', 100), 1);
  assert.equal(parseAmount('100', 100), 100);
  assert.equal(parseAmount('101', 100), null);
  assert.equal(parseAmount('1,240', 2000), 1240);
  assert.equal(parseAmount(' 12 ', 100), 12);
  assert.equal(parseAmount('2.5', 100), null);
  assert.equal(parseAmount('-3', 100), null);
  assert.equal(parseAmount('1e2', 1000), null);
  assert.equal(parseAmount('abc', 100), null);
  assert.equal(parseAmount('1', 0), null);
});

test('Max is what Habitica’s gold pays for at two a glim, within today’s cap (silas-yard.md 1.5)', () => {
  assert.equal(GOLD_PER_GLIM, 2);
  assert.equal(GLIMS_PER_DAY, 30);
  assert.equal(maxGlims(1240, 30), 30);
  assert.equal(maxGlims(41, 30), 20);
  assert.equal(maxGlims(1240, 12), 12);
  assert.equal(maxGlims(1, 30), 0);
  assert.equal(maxGlims(1240, 0), 0);
  assert.equal(maxGlims(1240, -3), 0);
  // The request's amount is the gold: two for each glim.
  assert.equal(goldFor(20), 40);
});

test('the consent card reads Habitica gold from the sync’s own read, floored', () => {
  assert.equal(habiticaGoldOf({ stats: { gp: 1240.987 } }), 1240);
  assert.equal(habiticaGoldOf({ stats: { gp: 0 } }), 0);
  assert.equal(habiticaGoldOf({ stats: {} }), null);
  assert.equal(habiticaGoldOf({ stats: { gp: -4 } }), null);
  assert.equal(habiticaGoldOf(undefined), null);
});

test('every top-up outcome is said in plain words (silas-yard.md 1.5)', () => {
  assert.equal(topUpOutcome(topUp({ state: 'working', settledAt: null })), null);
  assert.equal(topUpOutcome(topUp()), '20 glims caught the light. Habitica: 1,240 → 1,200 gold.');
  assert.equal(topUpOutcome(topUp({ amount: 2, glims: 1, goldAfter: 1238 })), '1 glim caught the light. Habitica: 1,240 → 1,238 gold.');
  assert.equal(topUpOutcome(topUp({ goldBefore: null, goldAfter: null })), '20 glims caught the light.');
  assert.equal(topUpOutcome(topUp({ note: 'checked' })), purseCopy.movedChecked(20, 40));
  assert.match(topUpOutcome(topUp({ note: 'checked' }))!, /went down by 40, so 20 glims caught the light/);
  assert.equal(topUpOutcome(topUp({ state: 'not-enough', goldAfter: null })), purseCopy.notEnough);
  assert.equal(topUpOutcome(topUp({ state: 'not-moved', goldAfter: null })), purseCopy.notMoved);
  assert.equal(topUpOutcome(topUp({ state: 'not-moved', note: 'habitica-auth', goldBefore: null, goldAfter: null })), purseCopy.tokenRefused);
  assert.equal(topUpOutcome(topUp({ state: 'unconfirmed', goldAfter: null })), purseCopy.unconfirmed);
  // A leftover reward adds its warning to any line.
  assert.equal(topUpOutcome(topUp({ state: 'not-moved', leftover: true })), `${purseCopy.notMoved} ${purseCopy.leftover}`);
  assert.match(purseCopy.leftover, /don’t buy it/);
});

test('a state’s top-ups, and a full day before the server sends any', () => {
  assert.deepEqual(purseOf(null), { glimsLeft: GLIMS_PER_DAY, topUpsLeft: TOP_UPS_PER_DAY, working: null });
  const s = create(PlayerStateSchema, { purse: create(PurseSchema, { topUpsLeft: 1, glimsLeft: 12, working: create(PurseTopUpSchema, { id: 'w', amount: 6, glims: 3, state: 'working', startedAt: 9 }) }) });
  const p = purseOf(s);
  assert.equal(p.glimsLeft, 12);
  assert.equal(p.topUpsLeft, 1);
  assert.deepEqual(p.working, { id: 'w', amount: 6, glims: 3, state: 'working', goldBefore: null, goldAfter: null, startedAt: 9, settledAt: null, leftover: false, note: '' });
  assert.equal(purseOf(create(PlayerStateSchema, { purse: create(PurseSchema, { topUpsLeft: 2, glimsLeft: -1 }) })).glimsLeft, 0);
});

test('a top-up row from before the 2:1 credit says its glims from its gold', () => {
  assert.equal(topUpView(create(PurseTopUpSchema, { id: 'old', amount: 40, state: 'moved' })).glims, 20);
  assert.equal(topUpView(create(PurseTopUpSchema, { id: 'new', amount: 40, glims: 20, state: 'moved' })).glims, 20);
});

test('glims show down at once for a spend and up for a letter collected, never below zero; arrivals are never XP-earned', () => {
  const s = { ...createNewGame(), glims: 10, xpGlims: 8 };
  const after = (pending: Prediction[]) => pending.reduce((st, op) => predict(st, op, { profile: null }), s);
  assert.equal(after([{ kind: 'glims', delta: 20 }, { kind: 'glims', delta: -6 }, { kind: 'none' }, { kind: 'glims', delta: 10 }]).glims, 34);
  assert.equal(after([{ kind: 'glims', delta: -50 }]).glims, 0);
  assert.equal(after([]).glims, 10);
  // A spend uses the other glims first: 2 gifted go, then 1 earned.
  assert.deepEqual([predictGlims(s, -3).glims, predictGlims(s, -3).xpGlims], [7, 7]);
  assert.deepEqual([predictGlims(s, -1).glims, predictGlims(s, -1).xpGlims], [9, 8]);
  // Glims that arrive (a letter collected) are never XP-earned.
  assert.equal(predictGlims(s, 5).xpGlims, 8);
});

test('the Glim log: top-ups from their rows, every line with the other player, newest first, at most 50', () => {
  const read = create(PurseReadSchema, {
    topUps: [create(PurseTopUpSchema, { id: 'a', amount: 40, glims: 20, state: 'moved', goldBefore: 1240, goldAfter: 1200, startedAt: 100, settledAt: 101 }), create(PurseTopUpSchema, { id: 'b', amount: 20, glims: 10, state: 'unconfirmed', goldBefore: 1740, startedAt: 50, settledAt: 90 })],
    lines: [
      create(PurseLineSchema, { at: 101, delta: 20, reason: 'habitica-topup' }),
      create(PurseLineSchema, { at: 10, delta: 620, reason: 'currency-merge', qty: 1240 }),
      create(PurseLineSchema, { at: 110, delta: -6, reason: 'market-buy', itemDef: 'timber', qty: 4, seller: 'Silas' }),
      create(PurseLineSchema, { at: 120, delta: 12, reason: 'shelf-sale', itemDef: 'timber', qty: 1, otherName: 'Ivy' }),
      create(PurseLineSchema, { at: 130, delta: -20, reason: 'mail-send', otherName: 'Ivy', mailId: 'm1', mailState: 'waiting' }),
      create(PurseLineSchema, { at: 140, delta: 15, reason: 'gift', otherName: 'Bram' }),
      create(PurseLineSchema, { at: 80, delta: 30, reason: 'mail-return', otherName: 'Bram' }),
    ],
  });
  const log = purseLog(read);
  assert.deepEqual(log.map((e) => e.text), [
    'Handed to you by Bram',
    'Sent to Ivy in a letter · waiting',
    'Ivy bought timber from your shelf',
    'Bought timber ×4 from Silas',
    'Top-up · 20 glims · moved',
    'Top-up · 10 glims · not confirmed',
    'Letter to Bram came back uncollected',
    'Your purse’s 1,240 gold, turned into glims (two gold each)',
  ]);
  assert.equal(log[4]!.detail, 'Habitica 1,240 → 1,200 gold');
  assert.equal(log[5]!.detail, 'Habitica 1,740 → ?');
  assert.equal(log[5]!.delta, null);
  assert.deepEqual(log.map((e) => e.delta), [15, -20, 12, -6, 20, null, 30, 620]);
  const many = create(PurseReadSchema, { lines: Array.from({ length: 70 }, (_, i) => create(PurseLineSchema, { at: i, delta: -1, reason: 'give', otherName: 'Ivy' })) });
  assert.equal(purseLog(many).length, 50);
  assert.equal(purseLog(many)[0]!.at, 69);
});

test('every ledger reason has its words', () => {
  const l = (reason: string, over: Record<string, unknown> = {}) => lineText({ reason, itemDef: '', qty: 0, otherName: 'Ivy', mailState: '', seller: '', ...over });
  assert.equal(l('purse-settle'), 'Top-up · settled by the owner');
  assert.equal(l('shelf-buy', { itemDef: 'flour', qty: 1 }), 'Bought flour from Ivy’s shelf');
  assert.equal(l('market-buy', { itemDef: 'flour', qty: 2, seller: 'Finn' }), 'Bought flour ×2 from Finn');
  assert.equal(l('mail-claim'), 'In a letter from Ivy');
  assert.equal(l('mail-recall'), 'Letter to Ivy recalled');
  assert.equal(l('mail-send', { mailState: 'collected' }), 'Sent to Ivy in a letter · collected');
  assert.equal(l('mail-send', { mailState: 'came-back' }), 'Sent to Ivy in a letter · came back');
  assert.equal(l('give'), 'Handed to Ivy');
  assert.equal(l('shelf-sale', { itemDef: 'whittled-fox', qty: 1 }), 'Ivy bought a whittled fox from your shelf');
  assert.equal(l('currency-merge'), 'Your purse’s gold, turned into glims (two gold each)');
  assert.equal(l('currency-merge', { qty: 30 }), 'Your purse’s 30 gold, turned into glims (two gold each)');
  // Every glim spend (silas-yard.md 1.6; lane G-B's reasons).
  assert.equal(l('spend'), 'Spent on a rest, a lantern or the chest');
  assert.equal(l('quest'), 'Paid along a quest');
  assert.equal(l('mend', { itemDef: 'whittled-fox' }), 'Paid to mend a whittled fox');
  assert.equal(l('homestead-deed'), 'A deed from Silas');
  assert.equal(l('homestead-upgrade'), 'Building work by Silas');
  assert.equal(l('homestead-buy', { itemDef: 'wooden-stool' }), 'Bought a wooden stool from Silas');
  assert.equal(l('homestead-clear'), 'Silas cleared a tile on your land');
  assert.equal(l('something-new'), 'Glims');
  assert.equal(signed(-6), '− 6');
  assert.equal(signed(1240), '+ 1,240');
  assert.equal(logDate(Date.UTC(2026, 9, 9, 12) / 1000), '9 Oct');
});

test('a seller’s talk offers each good once, at its one price in glims', () => {
  const finn = sellerFor('finns-mill-door')!;
  assert.deepEqual(sellerChoices(finn).map((c) => c.action), ['buy:finns-mill-door:flour', 'buy:finns-mill-door:willow-rod']);
  assert.equal(sellerChoices(finn)[0]!.text, 'Buy a sack of flour · 1 glim');
  assert.equal(sellerChoices(sellerFor('hazels-kitchen')!).length, 1);
  assert.equal(sellerChoices(sellerFor('madder-stall')!).length, 1);
  const silas = sellerFor('silas-yard')!;
  const yard = sellerChoices(silas, { reply: true });
  assert.deepEqual(yard.map((c) => c.action), ['buy:silas-yard:timber', 'buy:silas-yard:stone', 'buy:silas-yard:fiber']);
  assert.deepEqual(yard.map((c) => c.text), ['Buy timber ×4 · 3 glims', 'Buy stone ×4 · 4 glims', 'Buy fiber ×4 · 3 glims']);
  assert.ok(yard.every((c) => c.reply?.[0]?.startsWith('Offcuts from the yard')));
  assert.deepEqual(silas.goods.map((g) => [g.glims, g.cap]), [[3, 3], [4, 3], [3, 3]]);
});

test('a buy action is a seller and a good; anything else isn’t a buy', () => {
  assert.deepEqual(parseBuy('finns-mill-door:flour'), { seller: 'finns-mill-door', good: 'flour' });
  assert.equal(parseBuy('finns-mill-door:flour:gold'), null);
  assert.equal(parseBuy('finns-mill-door'), null);
});

test('a glim letter reads as glims: "12 glims", "a glim", never coins', () => {
  assert.equal(assetPhrase({ kind: 'glims', id: 'glims', qty: 20 }), '20 glims');
  assert.equal(assetPhrase({ kind: 'glims', id: 'glims', qty: 1240 }), '1,240 glims');
  assert.equal(assetPhrase({ kind: 'glims', id: 'glims', qty: 1 }), 'a glim');
  assert.equal(glimsPhrase(12), '12 glims');
  assert.equal(glimsCount(1), '1 glim');
  for (const text of Object.values(purseCopy)) if (typeof text === 'string') assert.doesNotMatch(text, /glim coins|embers?\b/i, text);
});

test('the consent card’s words follow 1.5: picks glims, shows the gold, two for each', () => {
  assert.equal(purseCopy.consentTitle, 'Turn Habitica gold into glims');
  assert.equal(purseCopy.youHave(1240), 'You have 1,240 gold on Habitica.');
  assert.equal(purseCopy.rate(20, GOLD_PER_GLIM), 'Two gold for each glim: 20 glims costs 40 gold.');
  assert.equal(purseCopy.glimsLeft(30, 2), 'Today you can still get 30 glims, in up to 2 top-ups.');
  assert.equal(purseCopy.glimsLeft(1, 1), 'Today you can still get a glim, in up to one top-up.');
  assert.equal(purseCopy.get(20), 'Get 20 glims');
  assert.equal(purseCopy.max, 'Max');
  assert.match(purseCopy.spends, /Glims can’t be turned back into gold/);
});

test('top-up and glim refusals have their words in every table that can see them', () => {
  for (const code of ['purse-busy', 'top-up-limit', 'top-up-cap', 'needs-habitica', 'invalid-quantity', 'login-rate-limited', 'login-user-rate-limited', 'login-busy']) assert.ok(PURSE_ERRORS[code], code);
  assert.match(purseErrorText('top-up-limit'), /midnight UTC/);
  assert.match(purseErrorText('top-up-cap'), /more glims than top-ups can bring today/);
  assert.match(purseErrorText('something-else'), /Nothing moved/);
  assert.ok(ITEM_ERRORS['insufficient-glims']);
  assert.ok(VILLAGE_ERRORS['insufficient-glims']);
  assert.ok(VILLAGE_ERRORS['own-stock']);
  // Owner's answer 9: Glimway's off hand is "at your belt" in the copy.
  assert.doesNotMatch(ITEM_ERRORS['off-hand-closed']!, /off hand/);
  assert.doesNotMatch(ITEM_ERRORS['not-for-the-off-hand']!, /off hand/);
});

test('an outbox entry keeps its predicted glims change, and only a mutation may carry one', () => {
  const base = { id: 1, kind: 'mutation', path: '/api/items/give', key: 'k', body: '{}', contract: 7, createdAt: 1, sent: false, barrier: false, offline: false };
  const r = normalizeRecord({ ...emptyRecord('a', 'd'), nextId: 4, entries: [{ ...base, glims: -15 }, { ...base, id: 2, kind: 'mark', path: '/api/story/mark', glims: 9 }, { ...base, id: 3, glims: 2.5 }] });
  assert.equal(r!.entries[0]!.glims, -15);
  assert.equal(r!.entries[1]!.glims, undefined);
  assert.equal(r!.entries[2]!.glims, undefined);
});

test('topUpView carries absent wrappers as null', () => {
  const v = topUpView(create(PurseTopUpSchema, { id: 'x', amount: 3, state: 'not-moved', note: 'habitica-auth' }));
  assert.equal(v.goldBefore, null);
  assert.equal(v.settledAt, null);
});
