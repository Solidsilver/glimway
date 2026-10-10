import test from 'node:test';
import assert from 'node:assert/strict';
import { EV } from '../src/game/event-names.ts';
import { env, online, refuse, rig, S, tick } from './helpers/link-rig.ts';

/** A state with `glims` and the top-up's day (design 2.5: two top-ups a UTC day; silas-yard.md 1.5: 30 glims). */
function withPurse(glims: number, over: Parameters<typeof S>[0] = {}): Record<string, any> {
  const s = S({ balance: glims, ...over });
  s.purse = { topUpsLeft: 2, working: null, glimsLeft: 30 };
  return s;
}

const topUpRow = (over: Record<string, unknown> = {}) => ({ id: 'tu-1', amount: 200, state: 'moved', goldBefore: 1240, goldAfter: 1040, startedAt: 1000, settledAt: 1002, leftover: false, note: '', glims: 100, ...over });

test('a buy names the seller and the good, never a currency; a refusal comes back', async (t) => {
  const r = await rig(t, { state: withPurse(2) });
  await online(r, withPurse(2));
  r.server.on('POST /api/items/buy', refuse('insufficient-glims', withPurse(2)));
  const res = await r.link.mutate({ kind: 'items', op: 'buy', fields: { seller: 'silas-yard', good: 'stone' } });
  assert.deepEqual(res, { ok: false, code: 'insufficient-glims' });
  const sent = r.server.sent('POST /api/items/buy')[0]!.body;
  assert.equal(sent.pay, undefined);
  assert.equal(sent.good, 'stone');
  assert.equal(r.link.outbox.length, 0);
});

test('a glims give and a glim letter carry an amount in place of an asset', async (t) => {
  const r = await rig(t, { state: withPurse(40) });
  await online(r, withPurse(40));
  r.server.on('POST /api/items/give', refuse('not-together', withPurse(40)));
  r.server.on('POST /api/mail', refuse('recipient-unavailable', withPurse(40)));
  await r.link.mutate({ kind: 'items', op: 'give', fields: { toId: 'friend', glims: 15 } }, { glims: -15 });
  await r.link.mutate({ kind: 'mail-send', fields: { toId: 'friend', glims: 20 } }, { glims: -20 });
  const give = r.server.sent('POST /api/items/give')[0]!.body;
  assert.equal(give.glims, 15);
  assert.equal(give.asset ?? null, null);
  const mail = r.server.sent('POST /api/mail')[0]!.body;
  assert.equal(mail.glims, 20);
  assert.equal(mail.asset ?? null, null);
});

test('a glims spend shows on the balance until its answer, and a refusal puts it back', async (t) => {
  const r = await rig(t, { state: withPurse(40) });
  await online(r, withPurse(40));
  assert.equal(r.session.state.glims, 40);
  let during = -1;
  r.server.beforeSend.push((c) => {
    if (c.path === '/api/items/give') during = r.session.state.glims;
  });
  r.server.on('POST /api/items/give', refuse('not-together', withPurse(40)));
  await r.link.mutate({ kind: 'items', op: 'give', fields: { toId: 'friend', glims: 15 } }, { glims: -15 });
  assert.equal(during, 25, 'down at once');
  assert.equal(r.session.state.glims, 40, 'back after the refusal');
  // A glim letter collected shows its glims at once too.
  r.server.on('POST /api/mail/m1/claim', refuse('mail-not-found', withPurse(40)));
  during = -1;
  r.server.beforeSend.push((c) => {
    if (c.path.startsWith('/api/mail')) during = r.session.state.glims;
  });
  await r.link.mutate({ kind: 'mail-claim', id: 'm1' }, { glims: 12 });
  assert.equal(during, 52);
  assert.equal(r.session.state.glims, 40);
});

test('a buy shows its price on the balance until the answer', async (t) => {
  const r = await rig(t, { state: withPurse(10) });
  await online(r, withPurse(10));
  let during = -1;
  r.server.beforeSend.push((c) => {
    if (c.path === '/api/items/buy') during = r.session.state.glims;
  });
  r.server.on('POST /api/items/buy', refuse('sold-out', withPurse(10)));
  await r.link.mutate({ kind: 'items', op: 'buy', fields: { seller: 'silas-yard', good: 'stone' } }, { glims: -4 });
  assert.equal(during, 6);
  assert.equal(r.session.state.glims, 10);
});

test('the top-up carries the token in its one request and never in the outbox', async (t) => {
  const r = await rig(t, { state: withPurse(0) });
  await online(r, withPurse(0));
  const after = withPurse(100, { version: 7 });
  after.purse.topUpsLeft = 1;
  after.purse.glimsLeft = 0;
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
  assert.equal(r.link.purse.topUpsLeft, 1);
  assert.equal(r.link.purse.glimsLeft, 0);
  assert.equal(res.ok && res.topUp.glims, 100);
});

test('a top-up refused before it starts says why, and nothing is kept to send again', async (t) => {
  const r = await rig(t, { state: withPurse(0) });
  await online(r, withPurse(0));
  r.server.on('POST /api/purse/top-up', refuse('top-up-limit'));
  assert.deepEqual(await r.link.topUp('tok', 5), { ok: false, code: 'top-up-limit' });
  r.server.on('POST /api/purse/top-up', 'network');
  assert.deepEqual(await r.link.topUp('tok', 5), { ok: false, code: 'offline' }, 'sent, so it may have started');
  assert.equal(r.server.sent('POST /api/purse/top-up').length, 2, 'a lost answer is never sent again by itself');
  assert.equal(r.link.outbox.length, 0);
});

test('a top-up needs a connection, and says it was never sent', async (t) => {
  const r = await rig(t, { state: withPurse(0) });
  assert.deepEqual(await r.link.topUp('tok', 5), { ok: false, code: 'offline', sent: false });
  assert.equal(r.server.sent('POST /api/purse/top-up').length, 0);
});

test('the purse read decodes the log, and a working top-up shows', async (t) => {
  const r = await rig(t, { state: withPurse(10) });
  await online(r, withPurse(10));
  r.server.on('GET /api/purse', {
    body: {
      state: withPurse(10),
      result: {
        purse: { topUpsLeft: 1, glimsLeft: 30, working: topUpRow({ state: 'working', goldAfter: null, settledAt: null }) },
        topUps: [topUpRow({ state: 'working', goldAfter: null, settledAt: null })],
        lines: [{ at: 5, delta: -6, reason: 'market-buy', itemDef: 'timber', qty: 4, otherName: '', mailId: '', mailState: '', seller: 'Silas' }],
      },
    },
  });
  r.server.on('GET /api/state', { body: { state: withPurse(10, { version: 3 }), leaseActive: true } });
  const read = await r.link.purseRead();
  assert.ok(read.ok);
  assert.equal(read.ok && read.value.topUps[0]!.state, 'working');
  assert.equal(read.ok && read.value.lines[0]!.seller, 'Silas');
  // One read shape (the domain reads' { state, result }): a bare read, or one
  // under an Envelope's oneof, is refused rather than read as empty.
  const purse = { purse: { topUpsLeft: 1, glimsLeft: 30, working: null }, topUps: [], lines: [] };
  r.server.on('GET /api/purse', { body: purse });
  assert.deepEqual(await r.link.purseRead(), { ok: false, code: 'bad-response' }, 'a bare read');
  r.server.on('GET /api/purse', { body: { state: withPurse(10), purseRead: purse } });
  assert.deepEqual(await r.link.purseRead(), { ok: false, code: 'bad-response' }, 'an envelope case');
});
