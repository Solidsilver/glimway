import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '@bufbuild/protobuf';
import { PurseLineSchema, PurseReadSchema, PurseSchema, PurseTopUpSchema } from '../src/lib/gen/glimway/v1/purse_pb.js';
import { PlayerStateSchema } from '../src/lib/gen/glimway/v1/state_pb.js';
import {
  goldPrice,
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
  TOP_UPS_PER_DAY,
  type TopUpView,
} from '../src/lib/purse.ts';
import { predictPurse, type Prediction } from '../src/lib/api/predict.ts';
import { purseCopy } from '../src/content/purse.ts';
import { ITEM_ERRORS, PURSE_ERRORS, VILLAGE_ERRORS, purseErrorText } from '../src/content/errors.ts';
import { sellerFor } from '../src/lib/items.ts';
import { assetPhrase } from '../src/lib/village.ts';
import { emptyRecord, normalizeRecord } from '../src/lib/api/outbox.ts';

const topUp = (over: Partial<TopUpView> = {}): TopUpView => ({ id: 't1', amount: 200, state: 'moved', goldBefore: 1240, goldAfter: 1040, startedAt: 1_760_000_000, settledAt: 1_760_000_002, leftover: false, note: '', ...over });

test('an amount is a whole number from 1 to the gold shown, and nothing else', () => {
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
  // Habitica's cap holds even when more is shown.
  assert.equal(parseAmount('100000000', 1e12), null);
});

test('the consent card reads Habitica gold from the sync’s own read, floored', () => {
  assert.equal(habiticaGoldOf({ stats: { gp: 1240.987 } }), 1240);
  assert.equal(habiticaGoldOf({ stats: { gp: 0 } }), 0);
  assert.equal(habiticaGoldOf({ stats: {} }), null);
  assert.equal(habiticaGoldOf({ stats: { gp: -4 } }), null);
  assert.equal(habiticaGoldOf(undefined), null);
});

test('every top-up outcome is said in plain words (design 2.1)', () => {
  assert.equal(topUpOutcome(topUp({ state: 'working', settledAt: null })), null);
  assert.equal(topUpOutcome(topUp()), '200 gold moved into your purse. Habitica: 1,240 → 1,040.');
  assert.equal(topUpOutcome(topUp({ note: 'checked' })), purseCopy.movedChecked(200));
  assert.match(topUpOutcome(topUp({ note: 'checked' }))!, /went down by 200, so it’s in your purse/);
  assert.equal(topUpOutcome(topUp({ state: 'not-enough', goldAfter: null })), purseCopy.notEnough);
  assert.equal(topUpOutcome(topUp({ state: 'not-moved', goldAfter: null })), purseCopy.notMoved);
  assert.equal(topUpOutcome(topUp({ state: 'not-moved', note: 'habitica-auth', goldBefore: null, goldAfter: null })), purseCopy.tokenRefused);
  assert.equal(topUpOutcome(topUp({ state: 'unconfirmed', goldAfter: null })), purseCopy.unconfirmed);
  // A leftover reward adds its warning to any line.
  assert.equal(topUpOutcome(topUp({ state: 'not-moved', leftover: true })), `${purseCopy.notMoved} ${purseCopy.leftover}`);
  assert.match(purseCopy.leftover, /don’t buy it/);
});

test('a state’s purse, and an empty one before the server sends any', () => {
  assert.deepEqual(purseOf(null), { gold: 0, topUpsLeft: TOP_UPS_PER_DAY, working: null });
  const s = create(PlayerStateSchema, { purse: create(PurseSchema, { gold: 240, topUpsLeft: 1, working: create(PurseTopUpSchema, { id: 'w', amount: 5, state: 'working', startedAt: 9 }) }) });
  const p = purseOf(s);
  assert.equal(p.gold, 240);
  assert.equal(p.topUpsLeft, 1);
  assert.deepEqual(p.working, { id: 'w', amount: 5, state: 'working', goldBefore: null, goldAfter: null, startedAt: 9, settledAt: null, leftover: false, note: '' });
});

test('gold shows down at once for a spend and up for a letter collected, never below zero; the top-up is never predicted', () => {
  const s = create(PlayerStateSchema, { purse: create(PurseSchema, { gold: 20, topUpsLeft: 2 }) });
  const pending: Prediction[] = [{ kind: 'gold', delta: -6 }, { kind: 'none' }, { kind: 'gold', delta: 10 }];
  assert.equal(predictPurse(s, pending).gold, 24);
  assert.equal(predictPurse(s, [{ kind: 'gold', delta: -50 }]).gold, 0);
  assert.equal(predictPurse(s, []).gold, 20);
  assert.equal(predictPurse(null, [{ kind: 'gold', delta: 5 }]).gold, 5);
});

test('the purse log: top-ups from their rows, every line with the other player, newest first, at most 50', () => {
  const read = create(PurseReadSchema, {
    topUps: [create(PurseTopUpSchema, { id: 'a', amount: 200, state: 'moved', goldBefore: 1240, goldAfter: 1040, startedAt: 100, settledAt: 101 }), create(PurseTopUpSchema, { id: 'b', amount: 500, state: 'unconfirmed', goldBefore: 1740, startedAt: 50, settledAt: 90 })],
    lines: [
      create(PurseLineSchema, { at: 101, delta: 200, reason: 'habitica-topup' }),
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
    'Top-up · 200 gold · moved',
    'Top-up · 500 gold · not confirmed',
    'Letter to Bram came back uncollected',
  ]);
  assert.equal(log[4]!.detail, 'Habitica 1,240 → 1,040');
  assert.equal(log[5]!.detail, 'Habitica 1,740 → ?');
  assert.equal(log[5]!.delta, null);
  assert.deepEqual(log.map((e) => e.delta), [15, -20, 12, -6, 200, null, 30]);
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
  assert.equal(l('something-new'), 'Gold');
  assert.equal(signed(-6), '− 6');
  assert.equal(signed(1240), '+ 1,240');
  assert.equal(logDate(Date.UTC(2026, 9, 9, 12) / 1000), '9 Oct');
});

test('a seller’s talk offers each price as its own choice; Silas sells for gold only', () => {
  const finn = sellerFor('finns-mill-door')!;
  assert.deepEqual(sellerChoices(finn).map((c) => c.action), ['buy:finns-mill-door:flour', 'buy:finns-mill-door:flour:gold', 'buy:finns-mill-door:willow-rod', 'buy:finns-mill-door:willow-rod:gold']);
  assert.equal(sellerChoices(finn)[1]!.text, 'Buy a sack of flour · 2 gold');
  assert.equal(sellerChoices(sellerFor('hazels-kitchen')!).length, 2);
  assert.equal(sellerChoices(sellerFor('madder-stall')!).length, 2);
  const silas = sellerFor('silas-yard')!;
  const yard = sellerChoices(silas, { reply: true });
  assert.deepEqual(yard.map((c) => c.action), ['buy:silas-yard:timber:gold', 'buy:silas-yard:stone:gold', 'buy:silas-yard:fiber:gold']);
  assert.deepEqual(yard.map((c) => c.text), ['Buy timber ×4 · 6 gold', 'Buy stone ×4 · 8 gold', 'Buy fiber ×4 · 5 gold']);
  assert.ok(yard.every((c) => c.reply?.[0]?.startsWith('Offcuts from the yard')));
  assert.equal(goldPrice('silas-yard', 'stone'), 8);
  assert.equal(goldPrice('silas-yard', 'nothing'), null);
});

test('a buy action names its currency; anything else isn’t a buy', () => {
  assert.deepEqual(parseBuy('finns-mill-door:flour'), { seller: 'finns-mill-door', good: 'flour', pay: 'embers' });
  assert.deepEqual(parseBuy('finns-mill-door:flour:gold'), { seller: 'finns-mill-door', good: 'flour', pay: 'gold' });
  assert.equal(parseBuy('finns-mill-door:flour:gems'), null);
  assert.equal(parseBuy('finns-mill-door'), null);
});

test('a gold letter reads as gold', () => {
  assert.equal(assetPhrase({ kind: 'gold', id: 'gold', qty: 20 }), '20 gold');
  assert.equal(assetPhrase({ kind: 'gold', id: 'gold', qty: 1240 }), '1,240 gold');
});

test('gold refusals have their words in every table that can see them', () => {
  for (const code of ['purse-busy', 'top-up-limit', 'needs-habitica', 'invalid-quantity', 'login-rate-limited', 'login-user-rate-limited', 'login-busy']) assert.ok(PURSE_ERRORS[code], code);
  assert.match(purseErrorText('top-up-limit'), /midnight UTC/);
  assert.match(purseErrorText('something-else'), /Nothing moved/);
  assert.ok(ITEM_ERRORS['insufficient-gold']);
  assert.ok(VILLAGE_ERRORS['insufficient-gold']);
  assert.ok(VILLAGE_ERRORS['own-stock']);
  // Owner's answer 9: Glimway's off hand is "at your belt" in the copy.
  assert.doesNotMatch(ITEM_ERRORS['off-hand-closed']!, /off hand/);
  assert.doesNotMatch(ITEM_ERRORS['not-for-the-off-hand']!, /off hand/);
});

test('an outbox entry keeps its predicted purse change, and only a mutation may carry one', () => {
  const base = { id: 1, kind: 'mutation', path: '/api/items/give', key: 'k', body: '{}', contract: 6, createdAt: 1, sent: false, barrier: false, offline: false };
  const r = normalizeRecord({ ...emptyRecord('a', 'd'), nextId: 4, entries: [{ ...base, gold: -15 }, { ...base, id: 2, kind: 'mark', path: '/api/story/mark', gold: 9 }, { ...base, id: 3, gold: 2.5 }] });
  assert.equal(r!.entries[0]!.gold, -15);
  assert.equal(r!.entries[1]!.gold, undefined);
  assert.equal(r!.entries[2]!.gold, undefined);
});

test('topUpView carries absent wrappers as null', () => {
  const v = topUpView(create(PurseTopUpSchema, { id: 'x', amount: 3, state: 'not-moved', note: 'habitica-auth' }));
  assert.equal(v.goldBefore, null);
  assert.equal(v.settledAt, null);
});
