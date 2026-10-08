import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRecord, memoryOutboxStore, OUTBOX_LIFETIME_MS } from '../src/lib/api/outbox.ts';
import contract from '../content/contract.json' with { type: 'json' };
import { ackReport, env, markOk, online, refuse, rig, S, seed, stepOk, tick, type Answer, type Rig } from './helpers/link-rig.ts';

/**
 * Review round 1, findings 5, 7 and 8: nothing that may have been sent is
 * dropped without a state read, an untrustworthy answer never advances the
 * head, and every waiting caller hears back.
 */

const craftAnswer: Answer = { body: { state: S({ version: 2 }), result: { recipeId: 'plank', output: { kind: 'material', id: 'timber', qty: 1 }, inventory: {} } } };
const craft = (r: Rig) => r.link.mutate({ kind: 'craft', fields: { recipeId: 'plank', qty: 1 } });
const stateRead = (over = {}): Answer => ({ body: { state: S({ version: 2, ...over }), leaseActive: true } });

// ---------------------------------------------------------------- 5. reconciliation

test('an expired sent head is never replayed and stays until a state read succeeds', async (t) => {
  const clock = { now: 10 * OUTBOX_LIFETIME_MS };
  const store = memoryOutboxStore();
  const record = emptyRecord('fixture-account', 'dev');
  record.entries = [{ id: 1, kind: 'mark', path: '/api/story/mark', key: 'k1', body: JSON.stringify({ op: { lease: '', key: 'k1' }, mark: 'seen:old', where: { area: 'village', x: 1, y: 1 } }), contract: contract.number, createdAt: 0, sent: true, barrier: false, offline: true }];
  record.nextId = 2;
  seed(store, record);
  const r = await rig(t, { store, record, clock });
  r.server.on('GET /api/state', 'network');
  await online(r);
  await r.link.flush();
  assert.equal(r.server.sent('POST /api/story/mark').length, 0, 'an expired key is never sent again');
  assert.equal(r.link.outbox.length, 1, 'a failed read keeps it');
  r.server.on('GET /api/state', { body: { state: null, leaseActive: true } });
  await online(r);
  await r.link.flush();
  assert.equal(r.link.outbox.length, 1, 'a malformed read keeps it too');
  r.server.on('GET /api/state', stateRead());
  await online(r);
  await r.link.flush();
  assert.equal(r.link.outbox.length, 0);
  assert.equal(r.server.sent('POST /api/story/mark').length, 0);
});

test('a lease lost during that read stops everything and keeps the head', async (t) => {
  const clock = { now: 10 * OUTBOX_LIFETIME_MS };
  const store = memoryOutboxStore();
  const record = emptyRecord('fixture-account', 'dev');
  record.entries = [{ id: 1, kind: 'mark', path: '/api/story/mark', key: 'k1', body: JSON.stringify({ op: { lease: '', key: 'k1' }, mark: 'seen:old', where: { area: 'village', x: 1, y: 1 } }), contract: contract.number, createdAt: 0, sent: true, barrier: false, offline: true }];
  record.nextId = 2;
  seed(store, record);
  const r = await rig(t, { store, record, clock });
  r.server.on('GET /api/state', { body: { state: S(), leaseActive: false } });
  await online(r);
  await r.link.flush();
  assert.equal(r.link.status, 'superseded');
  assert.equal(r.link.outbox.length, 1);
});

test('an offline logout that drops unsent work keeps what may have been sent', async (t) => {
  const store = memoryOutboxStore();
  const r = await rig(t, { store });
  await online(r);
  r.server.on('POST /api/story/mark', 'network');
  r.link.mark('seen:sent');
  await r.link.flush();
  r.link.mark('seen:unsent');
  await tick();
  assert.equal(r.link.status, 'offline');
  assert.deepEqual(await r.link.dropUnsent(), { kept: 1 });
  const stored = await store.load('fixture-account', 'dev');
  assert.deepEqual(stored!.entries.map((e) => JSON.parse(e.body).mark), ['seen:sent']);
  assert.equal(stored!.loggedOut, true);
  assert.equal(r.server.sent('GET /api/state').length, 0, 'no read was possible, so nothing sent was dropped');
});

// ---------------------------------------------------------------- 7. untrustworthy answers

test('an answer with another operation’s result never settles the head', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/quest/step', markOk(S({ version: 2, quest: 'accepted' }), 'seen:x'), stepOk(S({ version: 2, quest: 'accepted' })));
  r.link.questStep('accept');
  r.link.mark('seen:behind');
  await r.link.flush();
  assert.equal(r.link.outbox.length, 2, 'kept, and nothing behind it went');
  assert.equal(r.session.state.quest, 'accepted', 'still predicted');
  assert.equal(r.server.sent('POST /api/story/mark').length, 0);
});

test('a disagreeing copy at the same version and a failed read: the head and everything behind it wait', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', markOk(S({ version: 1, marks: ['seen:a'] }), 'seen:a'));
  r.server.on('GET /api/state', 'network');
  r.link.mark('seen:a');
  r.link.mark('seen:b');
  await r.link.flush();
  assert.deepEqual(r.link.outbox.map((e) => JSON.parse(e.body).mark), ['seen:a', 'seen:b']);
  assert.deepEqual(r.session.state.flags, ['seen:a', 'seen:b']);
  assert.equal(r.server.sent('POST /api/story/mark').length, 1);
});

test('the same disagreement settles once a read says what the world holds', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', markOk(S({ version: 1, marks: ['seen:a'] }), 'seen:a'));
  r.server.on('GET /api/state', stateRead({ marks: ['seen:a'] }));
  r.link.mark('seen:a');
  await r.link.flush();
  assert.equal(r.link.outbox.length, 0);
  assert.deepEqual(r.session.state.flags, ['seen:a']);
});

// ---------------------------------------------------------------- 8. waiting callers

for (const [name, answer, code, status, kept] of [
  ['reload-needed', refuse('reload-needed'), 'pending', 'online', 1],
  ['a stateless invalid-json', refuse('invalid-json', undefined, 400), 'pending', 'online', 1],
  ['unauthorized', refuse('unauthorized', undefined, 401), 'pending', 'signed-out', 1],
  ['superseded', refuse('superseded'), 'pending', 'superseded', 1],
  ['no answer', 'network', 'pending', 'offline', 1],
] as const) {
  test(`an awaited craft answered ${name} hears ${code}, the world unfreezes, and it is kept`, { timeout: 5000 }, async (t) => {
    const r = await rig(t);
    await online(r);
    r.server.on('POST /api/craft', answer as Answer, craftAnswer);
    const res = await craft(r);
    assert.deepEqual(res, { ok: false, code });
    assert.equal(r.link.busy, false);
    assert.equal(r.session.remoteBusy, false);
    assert.equal(r.link.status, status);
    assert.equal(r.link.outbox.length, kept);
  });
}

test('lease loss and sign-out keep unsent awaited work too, and its caller hears pending', { timeout: 5000 }, async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('superseded'));
  r.link.mark('seen:a');
  const res = craft(r);
  assert.deepEqual(await res, { ok: false, code: 'pending' });
  assert.deepEqual(r.link.outbox.map((e) => e.kind), ['mark', 'mutation'], 'kept for the take-over');
  assert.equal(r.link.busy, false);
});

test('an awaited spend whose report barrier can’t be had: offline, never sent, nothing frozen', { timeout: 5000 }, async (t) => {
  const r = await rig(t, { state: S({ hp: 10 }) });
  await online(r, S({ hp: 10 }));
  r.session.state.hp = 6;
  r.server.on('POST /api/report', 'network');
  assert.equal(await r.link.spend({ kind: 'rest' }), 'offline');
  assert.equal(r.server.sent('POST /api/spend').length, 0);
  assert.equal(r.link.outbox.length, 0);
  assert.equal(r.link.busy, false);
});

test('an awaited spend under a paused queue hears back at once', { timeout: 5000 }, async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('reload-needed'));
  r.link.mark('seen:a');
  await r.link.flush();
  assert.equal(await r.link.spend({ kind: 'rest' }), 'error');
  assert.equal(r.link.busy, false);
  void ackReport;
  void env;
});

test('a refusal’s removal is stored before anything behind it goes', async (t) => {
  const store = memoryOutboxStore();
  const r = await rig(t, { store });
  await online(r);
  r.server.on('POST /api/quest/step', refuse('not-next-step', S({ version: 2 })));
  r.server.on('POST /api/story/mark', markOk(S({ version: 3, marks: ['seen:b'] }), 'seen:b'));
  // Every write after the refusal fails until the store recovers.
  let refused = false;
  r.server.beforeSend.push((c) => {
    if (c.path === '/api/quest/step') refused = true;
  });
  store.fail = (op) => op === 'save' && refused;
  r.link.questStep('accept');
  r.link.mark('seen:b');
  await r.link.flush();
  assert.equal(r.server.sent('POST /api/story/mark').length, 0, 'held until the refusal is durable');
  store.fail = null;
  await new Promise((res) => setTimeout(res, 2100));
  await r.link.flush();
  assert.equal(r.server.sent('POST /api/story/mark').length, 1);
  assert.equal((await store.load('fixture-account', 'dev'))!.entries.length, 0);
});
