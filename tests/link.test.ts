import test from 'node:test';
import assert from 'node:assert/strict';
import { EV } from '../src/game/event-names.ts';
import { emptyRecord, memoryOutboxStore, OUTBOX_LIFETIME_MS, type OutboxRecord } from '../src/lib/api/outbox.ts';
import contract from '../content/contract.json' with { type: 'json' };
import { FIXTURES_BY_KEY } from '../src/lib/habitica/fixtures.ts';
import { ackReport, BASE, env, FakeLocks, fakeServer, markOk, online, play, refuse, rig, S, seed, stepOk, tick, toasts, type Answer } from './helpers/link-rig.ts';

/**
 * The client on operations (design server-first 2.4) against a scripted
 * server: adoption by version, prediction and rollback, the outbox's order,
 * persistence and replay, ownership, reports and barriers.
 */

// ---------------------------------------------------------------- adoption

test('a state is adopted only at an equal or higher version', async (t) => {
  const r = await rig(t, { state: S({ version: 5, balance: 3 }) });
  r.server.on('POST /api/play', play(S({ version: 4, balance: 9 })));
  await r.link.reconnect(false);
  assert.equal(r.link.rev, 5, 'an older answer never moves the client back in time');
  assert.equal(r.session.state.embers, 3);
  r.server.on('GET /api/state', { body: { state: S({ version: 7, balance: 8 }), leaseActive: true } });
  await r.link.beat(true);
  assert.equal(r.link.rev, 7);
  assert.equal(r.session.state.embers, 8);
});

test('an unrelated answer never heals the combat overlay', async (t) => {
  const r = await rig(t, { state: S({ version: 2, hp: 40 }) });
  await online(r, S({ version: 2, hp: 40 }));
  r.session.state.hp = 22; // hit on screen, not yet reported
  r.server.on('GET /api/state', { body: { state: S({ version: 3, hp: 40, balance: 5 }), leaseActive: true } });
  await r.link.beat(true);
  assert.equal(r.session.state.embers, 5);
  assert.equal(r.session.state.hp, 22);
});

test('a reload after a Wilds claim starts in the Wilds, not offline', async (t) => {
  const r = await rig(t, { state: S({ area: 'wilds:outer-1', x: 424, y: 744 }) });
  assert.deepEqual([r.session.state.area, r.session.state.wildsRegion, r.session.state.position], ['wilds', 'outer-1', { x: 424, y: 744 }]);
  await online(r, S({ area: 'wilds:inner-1', x: 50, y: 60 }));
  assert.equal(r.link.status, 'online');
  r.link.mark('seen:a');
  r.server.on('POST /api/story/mark', markOk(S({ version: 2, area: 'wilds:outer-1', marks: ['seen:a'] }), 'seen:a'));
  await r.link.flush();
  assert.deepEqual(r.server.sent('POST /api/story/mark')[0]!.body.where, { area: 'wilds:outer-1', x: 424, y: 744 }, 'where names the region back');
});

// ---------------------------------------------------------------- prediction

test('a quest step shows at once, and its answer brings what the server granted', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/quest/step', stepOk(S({ version: 2, quest: 'accepted', marks: ['seen:gate'] })));
  r.link.questStep('accept');
  assert.equal(r.session.state.quest, 'accepted', 'predicted before the answer');
  await r.link.flush();
  const [sent] = r.server.sent('POST /api/quest/step');
  assert.equal(sent.body.to, 'accepted');
  assert.equal(sent.body.quest, 'lantern-road');
  assert.deepEqual(sent.body.where, { area: 'village', x: 400, y: 300 });
  assert.equal(sent.body.op.lease, 'L1');
  assert.ok(!('baseRev' in sent.body) && !('progress' in sent.body));
  assert.equal(r.link.outbox.length, 0);
  assert.deepEqual(r.session.state.flags, ['seen:gate']);
});

test('a refused step rolls back, takes the steps after it along, and says so once', async (t) => {
  const r = await rig(t);
  await online(r);
  const release = r.server.hold('POST /api/quest/step');
  r.server.on('POST /api/quest/step', refuse('not-next-step', S({ version: 2, balance: 1 })));
  r.server.on('POST /api/story/mark', markOk(S({ version: 3, balance: 1, marks: ['met:mara'] }), 'met:mara'));
  r.link.questStep('accept');
  r.link.questStep('find-clue');
  r.link.mark('met:mara');
  assert.equal(r.session.state.quest, 'clue-found');
  assert.deepEqual(r.session.state.flags, ['met:mara']);
  release();
  await r.link.flush();
  assert.equal(r.session.state.quest, 'new', 'both steps rolled back');
  assert.equal(r.server.sent('POST /api/quest/step').length, 1, 'the dependent step was never sent');
  assert.equal(r.server.sent('POST /api/story/mark').length, 1, 'an unrelated mark still goes');
  assert.deepEqual(r.session.state.flags, ['met:mara']);
  assert.equal(r.session.state.embers, 1, 'the refusal’s state is adopted');
  assert.equal(toasts(r).filter((x) => x.includes('story step')).length, 1);
});

test('only client namespaces are marked: server marks never leave this device', async (t) => {
  const r = await rig(t);
  for (const m of ['witness:x:y:z', 'paper:eleven-days', 'wilds:turned', 'donated:x@1', 'echo:nan', 'lit:a']) r.link.mark(m);
  assert.equal(r.link.outbox.length, 0);
  r.link.mark('found:old-route-marker');
  r.link.mark('defeated:stone-warden');
  assert.deepEqual(r.session.state.discoveries, ['old-route-marker']);
  assert.deepEqual(r.session.state.defeatedEnemies, ['stone-warden']);
});

// ---------------------------------------------------------------- the outbox

test('persist before send: the entry is in the store before its request leaves', async (t) => {
  const r = await rig(t);
  await online(r);
  let storedAtSend: OutboxRecord | null = null;
  r.server.beforeSend.push((c) => {
    if (c.path === '/api/story/mark') storedAtSend = [...r.store.records.values()][0] ?? null;
  });
  r.server.on('POST /api/story/mark', markOk(S({ version: 2, marks: ['seen:a'] }), 'seen:a'));
  r.link.mark('seen:a');
  await r.link.flush();
  assert.ok(storedAtSend);
  const entry = (storedAtSend as unknown as OutboxRecord).entries[0]!;
  assert.equal(entry.kind, 'mark');
  assert.equal(entry.sent, true, 'marked as possibly sent before it was');
  assert.equal(entry.contract, contract.number);
  assert.equal(JSON.parse(entry.body).op.lease, '', 'the stored bytes never hold a lease');
});

test('head of line: a transport failure holds everything behind it, and the replay sends the same key and bytes', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', 'network');
  r.link.mark('seen:a');
  r.link.mark('seen:b');
  await r.link.flush();
  assert.equal(r.server.sent('POST /api/story/mark').length, 1, 'the second waits for the head');
  assert.equal(r.link.status, 'offline');
  assert.deepEqual(r.session.state.flags, ['seen:a', 'seen:b'], 'still predicted');
  const first = r.server.sent('POST /api/story/mark')[0]!.body;

  r.server.on(
    'POST /api/story/mark',
    (c) => markOk(S({ version: 2, marks: [c.body.mark] }), c.body.mark),
    (c) => markOk(S({ version: 3, marks: ['seen:a', c.body.mark] }), c.body.mark),
  );
  r.server.on('POST /api/play', play(S(), 'L2'));
  await r.link.reconnect(false);
  await r.link.flush();
  const sent = r.server.sent('POST /api/story/mark').map((c) => c.body);
  assert.equal(sent.length, 3);
  assert.deepEqual({ ...sent[1], op: { ...sent[1].op, lease: '' } }, { ...first, op: { ...first.op, lease: '' } }, 'same key, payload and where');
  assert.equal(sent[1].op.lease, 'L2', 'only the lease is new');
  assert.equal(sent[2].mark, 'seen:b');
  assert.deepEqual(r.session.state.flags, ['seen:a', 'seen:b']);
});

test('ambiguous answers keep the head: 5xx, 429, not-implemented and unreadable bodies', async (t) => {
  for (const answer of [refuse('internal', undefined, 500), refuse('rate-limited', undefined, 429), refuse('not-implemented', S({ version: 1 })), { body: '<html>' } as Answer]) {
    const r = await rig(t);
    await online(r);
    r.server.on('POST /api/story/mark', answer);
    r.link.mark('seen:a');
    await r.link.flush();
    assert.equal(r.link.outbox.length, 1, JSON.stringify(answer));
    assert.deepEqual(r.session.state.flags, ['seen:a']);
    r.link.stop();
  }
});

test('a reload replays the outbox: the next page sends what the last one queued', async (t) => {
  const store = memoryOutboxStore();
  const first = await rig(t, { store });
  first.link.questStep('accept');
  first.link.mark('seen:a');
  await first.link.persist();
  first.link.stop();

  const record = await store.load('fixture-account', 'dev');
  assert.equal(record?.entries.length, 2);
  const next = await rig(t, { store, record });
  assert.equal(next.session.state.quest, 'accepted', 'predicted from the outbox at once');
  next.server.on('POST /api/quest/step', stepOk(S({ version: 2, quest: 'accepted' })));
  next.server.on('POST /api/story/mark', markOk(S({ version: 3, quest: 'accepted', marks: ['seen:a'] }), 'seen:a'));
  await online(next);
  await next.link.flush();
  assert.equal(next.server.sent('POST /api/quest/step')[0]!.body.op.key, record!.entries[0]!.key);
  assert.equal(next.link.outbox.length, 0);
});

test('entries older than six days, or from another contract, are dropped unsent with a notice', async (t) => {
  const clock = { now: 10 * OUTBOX_LIFETIME_MS };
  const record = emptyRecord('fixture-account', 'dev');
  const body = (mark: string) => JSON.stringify({ op: { lease: '', key: `k-${mark}` }, mark, where: { area: 'village', x: 1, y: 1 } });
  record.entries = [
    { id: 1, kind: 'mark', path: '/api/story/mark', key: 'k-old', body: body('seen:old'), contract: contract.number, createdAt: clock.now - OUTBOX_LIFETIME_MS - 1, sent: false, barrier: false, offline: true },
    { id: 2, kind: 'mark', path: '/api/story/mark', key: 'k-c', body: body('seen:contract'), contract: contract.number - 1, createdAt: clock.now, sent: false, barrier: false, offline: true },
    { id: 3, kind: 'mark', path: '/api/story/mark', key: 'k-new', body: body('seen:new'), contract: contract.number, createdAt: clock.now - 1000, sent: false, barrier: false, offline: true },
  ];
  record.nextId = 4;
  const store = memoryOutboxStore();
  seed(store, record);
  const r = await rig(t, { record, clock, store });
  r.server.on('POST /api/story/mark', (c) => markOk(S({ version: 2, marks: [c.body.mark] }), c.body.mark));
  await online(r);
  await r.link.flush();
  assert.deepEqual(r.server.sent('POST /api/story/mark').map((c) => c.body.mark), ['seen:new']);
  assert.ok(toasts(r).some((x) => x.includes('more than six days ago')));
  assert.deepEqual(r.session.state.flags, ['seen:new']);
});

test('a domain mutation carries op and where, and a lost answer is replayed before anything else', async (t) => {
  const r = await rig(t);
  await online(r);
  const craftAnswer = { body: { state: S({ version: 2 }), result: { recipeId: 'plank', output: { kind: 'material', id: 'timber', qty: 1 }, inventory: {} } } };
  r.server.on('POST /api/craft', 'network', craftAnswer);
  const lost = await r.link.mutate({ kind: 'craft', fields: { recipeId: 'plank', qty: 1 } });
  assert.deepEqual(lost, { ok: false, code: 'pending' });
  assert.ok(r.link.pendingOperation);
  const [body] = r.server.sent('POST /api/craft').map((c) => c.body);
  assert.deepEqual(body.where, { area: 'village', x: 400, y: 300 });
  assert.equal(body.recipeId, 'plank');
  assert.ok(!('baseRev' in body) && !('progress' in body));

  r.server.on('POST /api/play', play(S(), 'L2'));
  await r.link.reconnect(false);
  await r.link.flush();
  const replay = r.server.sent('POST /api/craft')[1]!.body;
  assert.equal(replay.op.key, body.op.key);
  assert.equal(r.link.pendingOperation, null);
  const resolved = r.events.filter(([e]) => e === EV.mutationResolved);
  assert.equal((resolved[0]?.[1] as { outcome: string }).outcome, 'landed');
});

test('things the server decides need a connection; never-sent ones go when it does', async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.link.mutate({ kind: 'craft', fields: { recipeId: 'plank', qty: 1 } }), { ok: false, code: 'offline' });
  assert.equal(await r.link.spend({ kind: 'rest' }), 'offline');
  assert.equal(r.link.outbox.length, 0);
  await online(r);
  r.server.on('POST /api/story/mark', 'network');
  r.link.mark('seen:a');
  const craft = r.link.mutate({ kind: 'craft', fields: { recipeId: 'plank', qty: 1 } });
  assert.deepEqual(await craft, { ok: false, code: 'offline' }, 'queued behind a head that lost its answer, never sent');
  assert.equal(r.server.sent('POST /api/craft').length, 0);
  assert.deepEqual(r.link.outbox.map((e) => e.kind), ['mark']);
});

const lookup = (operation: unknown, state = S({ version: 2 })): Answer => ({ body: { state, result: { operation } } });
const lookupPath = (route: string, key: string) => `GET /api/operations/result?route=${encodeURIComponent(route)}&key=${encodeURIComponent(key)}`;

test('idempotency-mismatch, a different payload committed: that action is not this one, its prediction goes, the queue goes on', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('idempotency-mismatch', S({ version: 2 })), markOk(S({ version: 3, marks: ['seen:b'] }), 'seen:b'));
  r.link.mark('seen:a');
  r.link.mark('seen:b');
  const key = r.link.outbox[0]!.key;
  r.server.on(lookupPath('/api/story/mark', key), lookup({ route: '/api/story/mark', key, payload: { mark: 'seen:other', where: { area: 'village', x: 400, y: 300 } }, payloadHash: 'h', version: 1, result: { mark: 'seen:other', added: true }, resultCase: 'mark', resultType: 'glimway.v1.MarkResult' }));
  await r.link.flush();
  assert.deepEqual(r.session.state.flags, ['seen:b'], 'the mismatched mark is not claimed');
  assert.equal(r.link.outbox.length, 0);
  assert.equal(r.link.paused, null);
  assert.equal(r.server.sent('POST /api/story/mark').length, 2);
});

test('idempotency-mismatch, the same payload after all: its stored result settles it as landed', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('idempotency-mismatch', S({ version: 2, marks: ['seen:a'] })));
  r.link.mark('seen:a');
  const key = r.link.outbox[0]!.key;
  r.server.on(lookupPath('/api/story/mark', key), lookup({ route: '/api/story/mark', key, payload: { mark: 'seen:a', where: { area: 'village', x: 400, y: 300 } }, payloadHash: 'h', version: 2, result: { mark: 'seen:a', added: true }, resultCase: 'mark', resultType: 'glimway.v1.MarkResult' }, S({ version: 2, marks: ['seen:a'] })));
  await r.link.flush();
  assert.equal(r.link.outbox.length, 0);
  assert.deepEqual(r.session.state.flags, ['seen:a']);
  assert.equal(toasts(r).length, 0);
});

test('idempotency-mismatch with no row to read (past retention): the head and its prediction stay and the queue pauses', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('idempotency-mismatch', S({ version: 2 })));
  r.link.mark('seen:a');
  r.link.mark('seen:b');
  r.server.on(lookupPath('/api/story/mark', r.link.outbox[0]!.key), lookup(null));
  await r.link.flush();
  assert.deepEqual(r.link.outbox.map((e) => JSON.parse(e.body).mark), ['seen:a', 'seen:b'], 'nothing is declared resolved');
  assert.deepEqual(r.session.state.flags, ['seen:a', 'seen:b']);
  assert.equal(r.link.paused, 'mismatch');
  assert.equal(r.server.sent('POST /api/story/mark').length, 1, 'nothing behind it is sent');
});

test('idempotency-mismatch whose lookup fails: still uncertain, kept, retried later (not paused)', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('idempotency-mismatch', S({ version: 2 })));
  r.link.mark('seen:a');
  r.server.on(lookupPath('/api/story/mark', r.link.outbox[0]!.key), 'network');
  await r.link.flush();
  assert.equal(r.link.outbox.length, 1);
  assert.equal(r.link.paused, null);
  assert.equal(r.link.status, 'offline');
});

test('idempotency-mismatch on a domain action the caller awaits: a different action is reported as such, never landed', { timeout: 5000 }, async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/craft', refuse('idempotency-mismatch', S({ version: 2 })));
  r.server.beforeSend.push((c) => {
    if (c.path === '/api/craft') r.server.on(lookupPath('/api/craft', c.body.op.key), lookup({ route: '/api/craft', key: c.body.op.key, payload: { recipeId: 'chair', qty: 1, where: { area: 'village', x: 400, y: 300 } }, payloadHash: 'h', version: 1, result: {}, resultCase: 'result', resultType: '' }));
  });
  const res = await r.link.mutate({ kind: 'craft', fields: { recipeId: 'plank', qty: 1 } });
  assert.deepEqual(res, { ok: false, code: 'idempotency-mismatch' });
  assert.equal(r.link.busy, false, 'play never freezes on it');
  assert.equal(r.events.filter(([e]) => e === EV.mutationResolved).length, 0);
  assert.equal(r.link.outbox.length, 0);
});

test('a request the server cannot decode pauses the outbox instead of retrying forever', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('invalid-json', undefined, 400));
  r.link.mark('seen:a');
  await r.link.flush();
  await r.link.flush();
  assert.equal(r.server.sent('POST /api/story/mark').length, 1);
  assert.equal(r.link.paused, 'client-bug');
  assert.equal(r.link.outbox.length, 1, 'kept on this device');
});

test('reload-needed stops sending and keeps the outbox', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('reload-needed'));
  r.link.mark('seen:a');
  await r.link.flush();
  assert.equal(r.link.paused, 'reload');
  assert.equal(r.link.outbox.length, 1);
  const payload = r.events.filter(([e]) => e === EV.link).at(-1)?.[1] as { paused: string };
  assert.equal(payload.paused, 'reload');
});

// ---------------------------------------------------------------- lease and ownership

test('lease loss keeps the outbox and never takes over on its own', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('superseded'));
  r.link.mark('seen:a');
  await r.link.flush();
  assert.equal(r.link.status, 'superseded');
  assert.equal(r.link.outbox.length, 1);
  assert.deepEqual(r.session.state.flags, ['seen:a']);
  assert.equal(r.server.sent('POST /api/play').length, 1, 'no silent take-over');
  assert.deepEqual(await r.link.mutate({ kind: 'craft', fields: {} }), { ok: false, code: 'superseded' });

  r.server.on('POST /api/play', play(S(), 'L9'));
  r.server.on('POST /api/story/mark', markOk(S({ version: 2, marks: ['seen:a'] }), 'seen:a'));
  await r.link.takeOver();
  await r.link.flush();
  const plays = r.server.sent('POST /api/play');
  assert.equal(plays.at(-1)!.body.takeOver, true);
  assert.equal(r.server.sent('POST /api/story/mark').at(-1)!.body.op.lease, 'L9');
  assert.equal(r.link.outbox.length, 0);
});

test('one sender per device: a second tab is passive until the player takes over, then the first stops', async (t) => {
  const locks = new FakeLocks();
  const store = memoryOutboxStore();
  const server = fakeServer();
  const a = await rig(t, { locks, store, server, clientId: 'tab-a' });
  await online(a);
  const b = await rig(t, { locks, store, server, clientId: 'tab-b' });
  await b.link.reconnect(false);
  assert.equal(b.link.status, 'superseded', 'the outbox lock is held by the other tab');
  a.link.mark('seen:a');
  await a.link.persist();
  server.on('POST /api/play', play(S(), 'L-b'));
  server.on('POST /api/story/mark', markOk(S({ version: 2, marks: ['seen:a'] }), 'seen:a'));
  // Tab A's queued mark is held while B takes over: B sends it, from the store.
  const release = server.hold('POST /api/story/mark');
  release();
  await b.link.takeOver();
  await b.link.flush();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(a.link.status, 'superseded', 'the stolen lock stops the first tab');
  assert.equal(b.link.status, 'online');
  assert.ok(server.sent('POST /api/story/mark').some((c) => c.body.op.lease === 'L-b'));
});

// ---------------------------------------------------------------- reports

test('reports carry place, vitals and summed casts; the clamped answer keeps what happened since', async (t) => {
  const r = await rig(t, { state: S({ hp: 40, mana: 20 }) });
  await online(r);
  r.session.state.hp = 30;
  r.session.state.mana = 8;
  r.link.noteCast();
  r.link.noteCast();
  // The server keeps less mana than reported (its regen bound), and the hero takes a hit while it answers.
  r.server.beforeSend.push((c) => {
    if (c.path === '/api/report') r.session.state.hp = 25;
  });
  r.server.on('POST /api/report', ackReport(() => S({ version: 2, hp: 30, mana: 5 })));
  r.link.reportSoon();
  await r.link.flush();
  const [rep] = r.server.sent('POST /api/report').map((c) => c.body);
  assert.deepEqual({ seq: rep.seq, casts: rep.casts, hp: rep.hp, mana: rep.mana, client: rep.client, generation: rep.generation, place: rep.place }, { seq: 1, casts: 2, hp: 30, mana: 8, client: 'rc', generation: 'gen-1', place: { area: 'village', x: 400, y: 300 } });
  assert.equal(r.session.state.hp, 25, 'the hit after capture stays');
  assert.equal(r.session.state.mana, 5, 'the clamp is adopted');
});

test('page hide sends the report with keepalive, out of turn', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/report', ackReport(() => S({ version: 2, hp: 33 })));
  r.session.state.hp = 33;
  await r.link.persist({ leaving: true });
  await new Promise((res) => setTimeout(res, 0));
  const [rep] = r.server.sent('POST /api/report');
  assert.equal(rep!.keepalive, true);
  assert.equal(rep!.body.hp, 33);
});

test('a reload resumes the report sequence and never heals the hero', async (t) => {
  const store = memoryOutboxStore();
  const first = await rig(t, { store });
  await online(first);
  first.server.on('POST /api/report', ackReport(() => S({ version: 2, hp: 30 })));
  first.session.state.hp = 30;
  first.link.reportSoon();
  await first.link.flush();
  first.session.state.hp = 12; // hurt again, the tab closes before the next report
  await first.link.persist();
  first.link.stop();

  const record = await store.load('fixture-account', 'dev');
  const next = await rig(t, { store, record, state: S({ version: 2, hp: 30, reportSeq: 1 }) });
  assert.equal(next.session.state.hp, 12, 'the last page’s vitals, not the server’s');
  next.server.on('POST /api/play', play(S({ version: 2, hp: 30, reportSeq: 1, reportGeneration: 'gen-1' })));
  next.server.on('POST /api/report', ackReport(() => S({ version: 3, hp: 12 })));
  await next.link.reconnect(false);
  await next.link.flush();
  const reps = next.server.sent('POST /api/report').map((c) => c.body);
  assert.equal(reps[0].seq, 2, 'same tab, same generation: the sequence carries on');
  assert.equal(reps[0].hp, 12);
});

test('a rest flushes a report first and carries its acknowledgment as the barrier', async (t) => {
  const r = await rig(t, { state: S({ hp: 10 }) });
  await online(r, S({ hp: 10 }));
  r.session.state.hp = 6;
  r.server.on('POST /api/report', ackReport(() => S({ version: 2, hp: 6 })));
  r.server.on('POST /api/spend', env(S({ version: 3, hp: 50, vitalsSetVersion: 3 }), { spend: { outcome: '' } }));
  assert.equal(await r.link.spend({ kind: 'rest' }), null);
  const order = r.server.calls.map((c) => c.path).filter((p) => p !== '/api/play');
  assert.deepEqual(order, ['/api/report', '/api/spend']);
  const spend = r.server.sent('POST /api/spend')[0]!.body;
  assert.deepEqual(spend.op.report, { client: 'rc', generation: 'gen-1', seq: 1 });
  assert.equal(spend.kind, 'rest');
  assert.equal(r.session.state.hp, 50, 'a server vitals write starts the overlay over');
});

test('a fall is predicted at once, queues offline, and the next report waits for its answer', async (t) => {
  const r = await rig(t, { state: S({ hp: 40, mana: 20 }) });
  r.session.state.area = 'woodland';
  r.session.state.hp = 0;
  const point = await r.link.fall();
  assert.deepEqual(point, { hp: 13, mana: 10 }, 'min(baseline, ceil(max × 0.25 / 0.5))');
  assert.equal(r.session.state.area, 'village');
  assert.equal(r.session.state.hp, 13);
  r.session.state.hp = 9; // hurt again after waking, still offline
  await r.link.persist();

  r.server.on('POST /api/fall', env(S({ version: 3, hp: 13, mana: 10, vitalsSetVersion: 3 }), { fall: { vitals: S({ hp: 13, mana: 10, vitalsSetVersion: 3 }).vitals, place: S().place, lantern: 'none', reason: 'not-wilds', lanternId: '', epoch: '' } }));
  r.server.on('POST /api/report', ackReport(() => S({ version: 4, hp: 9, mana: 10, vitalsSetVersion: 3 })));
  await online(r, S({ hp: 40 }));
  await r.link.flush();
  const order = r.server.calls.map((c) => c.path).filter((p) => p !== '/api/play');
  assert.deepEqual(order, ['/api/fall', '/api/report']);
  assert.deepEqual(r.server.sent('POST /api/fall')[0]!.body.where, { area: 'woodland', x: 400, y: 300 }, 'where the hero fell');
  const rep = r.server.sent('POST /api/report')[0]!.body;
  assert.equal(rep.basis, 3, 'reported against the fall');
  assert.equal(r.session.state.hp, 9, 'the hurt after waking is kept');
  // The answer is announced (the Wilds store rereads its region when a lantern was placed).
  assert.deepEqual(r.events.filter(([e]) => e === EV.fallSettled).map(([, p]) => p), [{ lantern: 'none' }]);
});

// ---------------------------------------------------------------- logout and storage

test('logout: keep the unsent work for the next sign-in, or drop it', async (t) => {
  const store = memoryOutboxStore();
  const r = await rig(t, { store });
  r.link.mark('seen:a');
  await r.link.flush();
  assert.equal(r.link.dirty, true);
  await r.link.keepForNextSignIn();
  const kept = await store.load('fixture-account', 'dev');
  assert.equal(kept?.loggedOut, true);
  assert.equal(kept?.entries.length, 1);
  assert.equal(await store.latest('dev'), null, 'not offered for offline play meanwhile');
  await r.link.dropUnsent();
  assert.equal(await store.load('fixture-account', 'dev'), null);
  assert.deepEqual(r.session.state.flags, []);
});

test('without durable storage, offline play is off: "Needs a connection"', async (t) => {
  const store = memoryOutboxStore({ durable: false });
  const r = await rig(t, { store });
  r.link.mark('seen:a');
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(r.link.outbox.length, 0);
  assert.deepEqual(r.session.state.flags, []);
  assert.ok(toasts(r).some((x) => x.includes('Needs a connection')));
  await online(r);
  r.server.on('POST /api/story/mark', markOk(S({ version: 2, marks: ['seen:b'] }), 'seen:b'));
  r.link.mark('seen:b');
  await r.link.flush();
  assert.deepEqual(r.session.state.flags, ['seen:b'], 'online it still works, from memory');
});

test('idempotency reconciliation of a stored refusal settles as refused and rolls back prediction', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('idempotency-mismatch', S({ version: 2 })));
  r.link.mark('seen:a');
  const key = r.link.outbox[0]!.key;
  r.server.on(lookupPath('/api/story/mark', key), lookup({ route: '/api/story/mark', key, payload: { mark: 'seen:a', where: { area: 'village', x: 400, y: 300 } }, version: 1, refused: 'unknown-mark', result: null, resultCase: 'result' }, S({ version: 2 })));
  await r.link.flush();
  assert.equal(r.link.outbox.length, 0);
  assert.deepEqual(r.session.state.flags, []);
  assert.equal(r.link.paused, null);
  assert.equal(toasts(r).length, 1);
});

test('a first profile sync reports the welcome even when no XP is credited', async (t) => {
  const r = await rig(t);
  await online(r, S({ balance: 0 }));
  r.server.on('POST /api/report', ackReport(() => S({ balance: 0 })));
  // The server pays the welcome beside the XP credit: `credit` stays 0.
  r.server.on('POST /api/profile', env(S({ version: 2, balance: 3, marks: ['embers:welcome'] }), { profile: { status: 'unchanged', credit: 0, pending: 0, vitalsCredit: { hp: 0, mana: 0 } } }));
  const raw = FIXTURES_BY_KEY.lowLevel.user;
  const first = await r.link.profile(raw);
  assert.ok(first.ok);
  assert.deepEqual([first.welcome, first.gained], [3, 0]);
  assert.equal(r.session.state.embers, 3);
  r.server.on('POST /api/profile', env(S({ version: 3, balance: 3, marks: ['embers:welcome'] }), { profile: { status: 'unchanged', credit: 0, pending: 0, vitalsCredit: { hp: 0, mana: 0 } } }));
  const again = await r.link.profile(raw);
  assert.ok(again.ok);
  assert.equal(again.welcome, 0, 'paid once');
});

test('a settle before a reload reports where the hero is now, after a report already on its way', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/report', ackReport(() => S({ version: 2 })));
  // A report with the old spot is on its way when the hero moves and the reload settles.
  r.session.state.position = { x: 420, y: 300 };
  const release = r.server.hold('POST /api/report');
  r.link.reportSoon();
  const first = r.link.flush();
  await tick();
  r.session.state.position = { x: 440, y: 300 };
  const settled = r.link.settle();
  release();
  await first;
  assert.equal(await settled, 'saved');
  const places = r.server.sent('POST /api/report').map((c) => c.body.place);
  assert.deepEqual(places.at(-1), { area: 'village', x: 440, y: 300 }, 'the spot the reload leaves from');
});

test('after a keyed operation moves the place watermark, reports name it so their place applies', async (t) => {
  const r = await rig(t);
  await online(r);
  // The mark's `where` is the place watermark now (version 2); no vitals were written.
  const marked = S({ version: 2, marks: ['seen:a'] });
  marked.place.placeSetVersion = 2;
  r.server.on('POST /api/story/mark', markOk(marked, 'seen:a'));
  r.link.mark('seen:a');
  await r.link.flush();
  r.session.state.position = { x: 440, y: 300 };
  r.server.on('POST /api/report', ackReport(() => S({ version: 3 })));
  r.link.reportSoon();
  await r.link.flush();
  const rep = r.server.sent('POST /api/report').at(-1)!.body;
  assert.equal(rep.basis, 2, 'at or past the place watermark');
  assert.deepEqual(rep.place, { area: 'village', x: 440, y: 300 });
});

test('back online after someone played elsewhere, with work unsent here: the welcome-back notice, once', async (t) => {
  const r = await rig(t);
  r.link.mark('seen:a'); // queued while offline
  r.server.on('POST /api/story/mark', markOk(S({ version: 6, marks: ['seen:a'] }), 'seen:a'));
  r.server.on('POST /api/play', play(S({ version: 5 })));
  await r.link.takeOver();
  await r.link.flush();
  assert.equal(r.events.filter(([e]) => e === EV.linkNotice).length, 1);

  const quiet = await rig(t);
  await online(quiet, S({ version: 5 }));
  assert.equal(quiet.events.filter(([e]) => e === EV.linkNotice).length, 0, 'nothing unsent: nothing to say');

  // A gap with no take-over is this device's own report landing unanswered.
  const own = await rig(t);
  own.link.mark('seen:a');
  own.server.on('POST /api/story/mark', markOk(S({ version: 6, marks: ['seen:a'] }), 'seen:a'));
  await online(own, S({ version: 5 }));
  await own.link.flush();
  assert.equal(own.events.filter(([e]) => e === EV.linkNotice).length, 0, 'not played elsewhere');
});

test('asking again for an order whose answer was lost settles that order: resolved, never a second one', async (t) => {
  const r = await rig(t);
  await online(r);
  const craftAnswer = { body: { state: S({ version: 2 }), result: { recipeId: 'plank', output: { kind: 'material', id: 'timber', qty: 1 }, inventory: {} } } };
  const trouble = { status: 503, body: { error: { code: 'unavailable' } } };
  r.server.on('POST /api/craft', trouble, craftAnswer, { body: { state: S({ version: 3 }), result: { recipeId: 'nail', output: { kind: 'material', id: 'timber', qty: 1 }, inventory: {} } } });
  assert.deepEqual(await r.link.mutate({ kind: 'craft', fields: { recipeId: 'plank', qty: 1 } }), { ok: false, code: 'pending' });
  r.server.on('GET /api/state', { body: { state: S(), leaseActive: true } });
  await new Promise((done) => setTimeout(done, 20)); // the player asks again a moment later
  // The same order again: the held one is replayed with its key and lands; nothing new is sent.
  assert.deepEqual(await r.link.mutate({ kind: 'craft', fields: { recipeId: 'plank', qty: 1 } }), { ok: false, code: 'resolved' });
  const keys = r.server.sent('POST /api/craft').map((c) => c.body.op.key);
  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0]);
  // A different order goes as its own.
  const other = await r.link.mutate({ kind: 'craft', fields: { recipeId: 'nail', qty: 1 } });
  assert.ok(other.ok);
  assert.equal(r.server.sent('POST /api/craft').length, 3);
});
