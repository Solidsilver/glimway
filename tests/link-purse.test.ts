import test from 'node:test';
import assert from 'node:assert/strict';
import { EV } from '../src/game/event-names.ts';
import { env, online, refuse, rig, S, tick } from './helpers/link-rig.ts';

/** A state with gold in the purse (design 2.5: two top-ups a UTC day). */
function withPurse(gold: number, over: Parameters<typeof S>[0] = {}): Record<string, any> {
  const s = S(over);
  s.purse = { gold, topUpsLeft: 2, working: null };
  return s;
}

const topUpRow = (over: Record<string, unknown> = {}) => ({ id: 'tu-1', amount: 200, state: 'moved', goldBefore: 1240, goldAfter: 1040, startedAt: 1000, settledAt: 1002, leftover: false, note: '', ...over });

test('a gold buy shows the purse down at once, and a refusal puts it back', async (t) => {
  const r = await rig(t, { state: withPurse(20) });
  await online(r, withPurse(20));
  assert.equal(r.link.purse.gold, 20);
  const release = r.server.hold('POST /api/items/buy');
  r.server.on('POST /api/items/buy', refuse('insufficient-gold', withPurse(20)));
  const buying = r.link.mutate({ kind: 'items', op: 'buy', fields: { seller: 'silas-yard', good: 'stone', pay: 'gold' } }, { gold: -8 });
  await tick();
  await tick();
  assert.equal(r.link.purse.gold, 12, 'shown down before the answer');
  const shown = r.events.filter(([e]) => e === EV.purse).map(([, p]) => (p as { gold: number }).gold);
  assert.ok(shown.includes(12), 'the interface heard it');
  // The request names the currency; the price is the server's.
  assert.equal(r.server.sent('POST /api/items/buy')[0]!.body.pay, 'gold');
  release();
  const res = await buying;
  assert.deepEqual(res, { ok: false, code: 'insufficient-gold' });
  assert.equal(r.link.purse.gold, 20, 'rolled back');
  assert.equal(r.link.outbox.length, 0);
});

test('a gold give and a gold letter carry an amount in place of an asset', async (t) => {
  const r = await rig(t, { state: withPurse(40) });
  await online(r, withPurse(40));
  r.server.on('POST /api/items/give', refuse('not-together', withPurse(40)));
  r.server.on('POST /api/mail', refuse('recipient-unavailable', withPurse(40)));
  await r.link.mutate({ kind: 'items', op: 'give', fields: { toId: 'friend', gold: 15 } }, { gold: -15 });
  await r.link.mutate({ kind: 'mail-send', fields: { toId: 'friend', gold: 20 } }, { gold: -20 });
  const give = r.server.sent('POST /api/items/give')[0]!.body;
  assert.equal(give.gold, 15);
  assert.equal(give.asset ?? null, null);
  const mail = r.server.sent('POST /api/mail')[0]!.body;
  assert.equal(mail.gold, 20);
  assert.equal(mail.asset ?? null, null);
  assert.equal(r.link.purse.gold, 40);
});

test('the top-up carries the token in its one request and never in the outbox', async (t) => {
  const r = await rig(t, { state: withPurse(0) });
  await online(r, withPurse(0));
  const after = withPurse(200, { version: 7 });
  after.purse.topUpsLeft = 1;
  r.server.beforeSend.push((c) => {
    if (c.path === '/api/purse/top-up') {
      // While the request is out, nothing stored holds the token.
      assert.doesNotMatch(JSON.stringify([...r.store.records.values()]), /secret-token/);
    }
  });
  r.server.on('POST /api/purse/top-up', env(after, { purseTopUp: { topUp: topUpRow() } }));
  const res = await r.link.topUp('secret-token', 200);
  assert.ok(res.ok);
  assert.equal(res.ok && res.topUp.state, 'moved');
  const sent = r.server.sent('POST /api/purse/top-up')[0]!.body;
  assert.equal(sent.token, 'secret-token');
  assert.equal(sent.amount, 200);
  assert.equal(sent.op.lease, 'L1');
  assert.ok(sent.op.key);
  assert.equal(r.link.outbox.length, 0);
  assert.doesNotMatch(JSON.stringify([...r.store.records.values()]), /secret-token/);
  assert.equal(r.link.purse.gold, 200);
  assert.equal(r.link.purse.topUpsLeft, 1);
});

test('a top-up refused before it starts says why, and nothing is kept to send again', async (t) => {
  const r = await rig(t, { state: withPurse(0) });
  await online(r, withPurse(0));
  r.server.on('POST /api/purse/top-up', refuse('top-up-limit'));
  assert.deepEqual(await r.link.topUp('tok', 5), { ok: false, code: 'top-up-limit' });
  r.server.on('POST /api/purse/top-up', 'network');
  assert.deepEqual(await r.link.topUp('tok', 5), { ok: false, code: 'offline' });
  assert.equal(r.server.sent('POST /api/purse/top-up').length, 2, 'a lost answer is never sent again by itself');
  assert.equal(r.link.outbox.length, 0);
});

test('a top-up needs a connection', async (t) => {
  const r = await rig(t, { state: withPurse(0) });
  assert.deepEqual(await r.link.topUp('tok', 5), { ok: false, code: 'offline' });
  assert.equal(r.server.sent('POST /api/purse/top-up').length, 0);
});

test('the purse read decodes the log, and a working top-up shows', async (t) => {
  const r = await rig(t, { state: withPurse(10) });
  await online(r, withPurse(10));
  r.server.on('GET /api/purse', {
    body: {
      purse: { gold: 10, topUpsLeft: 1, working: topUpRow({ state: 'working', goldAfter: null, settledAt: null }) },
      topUps: [topUpRow({ state: 'working', goldAfter: null, settledAt: null })],
      lines: [{ at: 5, delta: -6, reason: 'market-buy', itemDef: 'timber', qty: 4, otherName: '', mailId: '', mailState: '', seller: 'Silas' }],
    },
  });
  r.server.on('GET /api/state', { body: { state: withPurse(10, { version: 3 }), leaseActive: true } });
  const read = await r.link.purseRead();
  assert.ok(read.ok);
  assert.equal(read.ok && read.value.topUps[0]!.state, 'working');
  assert.equal(read.ok && read.value.lines[0]!.seller, 'Silas');
});
