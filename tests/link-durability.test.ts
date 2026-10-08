import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRecord, idbOutboxStore, memoryOutboxStore } from '../src/lib/api/outbox.ts';
import { TxIDB } from './helpers/fake-idb-tx.ts';
import { env, FakeLocks, fakeServer, markOk, online, play, refuse, rig, S, seed, stepOk, tick, toasts } from './helpers/link-rig.ts';

/**
 * Review round 1, findings 1, 2, 9 and 10: who may write the outbox, when a
 * write counts, and what happens when one doesn't land.
 */

const marks = (record: { entries: { body: string }[] } | null | undefined) => (record?.entries ?? []).map((e) => JSON.parse(e.body).mark ?? JSON.parse(e.body).to);

// ---------------------------------------------------------------- 1. ownership

test('two offline tabs on one device: the second is passive and never writes the owner’s record', async (t) => {
  const locks = new FakeLocks();
  const store = memoryOutboxStore();
  const a = await rig(t, { locks, store, clientId: 'tab-a' });
  const b = await rig(t, { locks, store, clientId: 'tab-b' });
  assert.equal(a.link.owner, true);
  assert.equal(b.link.owner, false);
  assert.equal(b.link.status, 'superseded');
  a.link.mark('seen:a');
  b.link.mark('seen:b');
  await tick();
  assert.deepEqual(marks(await store.load('fixture-account', 'dev')), ['seen:a']);
  assert.deepEqual(b.session.state.flags, [], 'nothing predicted that can’t be kept');
  await b.link.keepForNextSignIn();
  assert.equal(b.link.keptForNextSignIn, false, 'a passive logout leaves the record alone');
  assert.deepEqual(await b.link.dropUnsent(), { kept: 1 });
  assert.deepEqual(marks(await store.load('fixture-account', 'dev')), ['seen:a']);
});

test('without Web Locks the newest tab owns the record; the older one is fenced on its next write and its work is not lost', async (t) => {
  const store = memoryOutboxStore();
  const a = await rig(t, { locks: null, store, clientId: 'tab-a' });
  a.link.mark('seen:a');
  await tick();
  const b = await rig(t, { locks: null, store, clientId: 'tab-b' });
  assert.deepEqual(b.session.state.flags, ['seen:a'], 'the newer tab took the record as stored');
  b.link.mark('seen:b');
  await tick();
  a.link.mark('seen:c');
  await tick();
  assert.equal(a.link.status, 'superseded');
  const stored = await store.load('fixture-account', 'dev');
  assert.deepEqual(marks(stored), ['seen:a', 'seen:b']);
  assert.deepEqual(stored!.entries.map((e) => e.id), [1, 2], 'no colliding ids');
  assert.deepEqual(a.session.state.flags, ['seen:a'], 'the fenced write is taken back');
});

test('a slow lock: nothing is allocated before the record is claimed, so ids never collide with a previous page’s', async (t) => {
  const store = memoryOutboxStore();
  const old = emptyRecord('fixture-account', 'dev');
  old.entries = [{ id: 6, kind: 'mark', path: '/api/story/mark', key: 'k6', body: JSON.stringify({ op: { lease: '', key: 'k6' }, mark: 'seen:old', where: { area: 'village', x: 1, y: 1 } }), contract: 4, createdAt: Date.now(), sent: false, barrier: false, offline: true }];
  old.nextId = 7;
  seed(store, old);
  let grant!: () => void;
  const slow = { request: (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) => new Promise((resolve) => (grant = () => void cb({}).then(resolve))) };
  const r = rig(t, { store, locks: slow, record: emptyRecord('fixture-account', 'dev') });
  await tick();
  grant();
  const rr = await r;
  rr.link.mark('seen:new');
  await tick();
  assert.deepEqual((await store.load('fixture-account', 'dev'))!.entries.map((e) => e.id), [6, 7]);
});

test('an old writer finishing after a take-over is fenced: it cannot overwrite the new owner', async (t) => {
  const idb = new TxIDB();
  const store = idbOutboxStore(idb.factory);
  const locks = new FakeLocks();
  const a = await rig(t, { store: store as never, locks, clientId: 'tab-a' });
  a.link.mark('seen:a');
  await new Promise((r) => setTimeout(r, 20));
  idb.holding = true;
  a.link.mark('seen:late'); // its write waits to commit
  await new Promise((r) => setTimeout(r, 5));
  const server = fakeServer();
  server.on('POST /api/play', play(S(), 'L-b'));
  const b = await rig(t, { store: store as never, locks, server, clientId: 'tab-b' });
  const taking = b.link.takeOver();
  idb.release();
  await taking;
  await new Promise((r) => setTimeout(r, 20));
  a.link.mark('seen:after');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.link.status, 'superseded');
  const stored = await store.load('fixture-account', 'dev');
  assert.ok(!marks(stored).includes('seen:after'), 'the stale owner never lands a write');
  assert.ok(marks(stored).includes('seen:a'));
});

// ---------------------------------------------------------------- 2. commits

test('IndexedDB: a transaction aborted after its request succeeded is a failed write, not a saved one', async () => {
  const idb = new TxIDB();
  const store = idbOutboxStore(idb.factory);
  const claimed = (await store.claim('a', 'dev'))!;
  idb.abortNext = 1;
  assert.equal(await store.save({ ...claimed, name: 'lost' }), 'failed');
  assert.equal(store.durable, true, 'IndexedDB is there; that write just didn’t commit');
  assert.equal((await store.load('a', 'dev'))!.name, '');
  assert.equal(await store.save({ ...claimed, name: 'kept' }), 'saved');
  assert.equal((await store.load('a', 'dev'))!.name, 'kept');
  assert.equal(await store.save({ ...claimed, fence: claimed.fence - 1 }), 'fenced');
});

test('no request leaves before its entry has committed', async (t) => {
  const idb = new TxIDB();
  const store = idbOutboxStore(idb.factory);
  const r = await rig(t, { store: store as never });
  await online(r);
  r.server.on('POST /api/story/mark', markOk(S({ version: 2, marks: ['seen:a'] }), 'seen:a'));
  idb.holding = true;
  r.link.mark('seen:a');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.server.sent('POST /api/story/mark').length, 0, 'held: not stored yet, not sent');
  idb.release();
  await new Promise((res) => setTimeout(res, 20));
  await r.link.flush();
  assert.equal(r.server.sent('POST /api/story/mark').length, 1);
});

test('aborted settlement writes are not taken for durable: the link isn’t settled until a write lands', async (t) => {
  const idb = new TxIDB();
  const store = idbOutboxStore(idb.factory);
  const r = await rig(t, { store: store as never });
  await online(r);
  r.server.on('POST /api/story/mark', (c) => {
    idb.abortNext = 1_000; // every write from here on aborts after its requests succeed
    return markOk(S({ version: 2, marks: ['seen:a'] }), c.body.mark);
  });
  r.link.mark('seen:a');
  await r.link.flush();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.link.outbox.length, 0);
  assert.equal(r.link.settled, false, 'the record still holds it');
  idb.abortNext = 0;
  assert.equal(marks(await store.load('fixture-account', 'dev')).length, 1);
  assert.ok(toasts(r).some((x) => x.includes('isn’t saving')));
  await new Promise((res) => setTimeout(res, 2100)); // the retry
  assert.equal(marks(await store.load('fixture-account', 'dev')).length, 0);
  assert.equal(r.link.settled, true);
});

// ---------------------------------------------------------------- 9. falls that can't be kept

test('an offline fall without a durable outbox neither heals nor moves the hero', async (t) => {
  const r = await rig(t, { store: memoryOutboxStore({ durable: false }) });
  r.session.state.area = 'woodland';
  r.session.state.hp = 0;
  assert.equal(await r.link.fall(), null);
  assert.equal(r.session.state.hp, 0);
  assert.equal(r.session.state.area, 'woodland');
  assert.equal(r.link.reports.next.boundary, null);
  assert.equal(r.link.outbox.length, 0);
});

test('a fall whose write fails is taken back whole; a chain keeps only what was stored', async (t) => {
  const store = memoryOutboxStore();
  const r = await rig(t, { store });
  r.session.state.area = 'woodland';
  r.session.state.hp = 0;
  store.fail = (op, rec) => op === 'save' && !!rec?.entries.some((e) => e.kind === 'fall');
  assert.equal(await r.link.fall(), null);
  assert.deepEqual([r.session.state.area, r.session.state.hp, r.link.reports.next.boundary], ['woodland', 0, null]);
  store.fail = (op, rec) => op === 'save' && (rec?.entries.length ?? 0) > 1;
  r.link.questStep('accept');
  await tick();
  r.link.questStep('find-clue');
  await tick();
  assert.equal(r.session.state.quest, 'accepted', 'the second step wasn’t stored, so it isn’t shown');
  assert.deepEqual(r.link.outbox.map((e) => JSON.parse(e.body).to), ['accepted']);
});

// ---------------------------------------------------------------- 10. failed writes

test('a failed sent-mark write: nothing is sent, the head stays, and it goes once the write lands', async (t) => {
  const store = memoryOutboxStore();
  const r = await rig(t, { store });
  await online(r);
  store.fail = (op, rec) => op === 'save' && !!rec?.entries[0]?.sent;
  r.link.mark('seen:a');
  await tick();
  r.server.on('POST /api/story/mark', markOk(S({ version: 2, marks: ['seen:a'] }), 'seen:a'));
  await r.link.flush();
  assert.equal(r.server.sent('POST /api/story/mark').length, 0);
  assert.equal(r.link.outbox[0]?.sent, false);
  store.fail = null;
  await new Promise((res) => setTimeout(res, 2100));
  await r.link.flush();
  assert.equal(r.server.sent('POST /api/story/mark').length, 1);
});

test('a failed refusal-removal write is retried; the next page never replays the refused entry', async (t) => {
  const store = memoryOutboxStore();
  const r = await rig(t, { store });
  await online(r);
  r.server.on('POST /api/quest/step', refuse('not-next-step', S({ version: 2 })));
  store.fail = (op, rec) => op === 'save' && (rec?.entries.length ?? 1) === 0;
  r.link.questStep('accept');
  await r.link.flush();
  assert.equal(r.link.outbox.length, 0);
  assert.equal((await store.load('fixture-account', 'dev'))!.entries.length, 1, 'not durable yet');
  assert.equal(r.link.settled, false);
  store.fail = null;
  await new Promise((res) => setTimeout(res, 2100));
  assert.equal((await store.load('fixture-account', 'dev'))!.entries.length, 0);
});

test('a failed logout mark is reported, not assumed', async (t) => {
  const store = memoryOutboxStore();
  const r = await rig(t, { store });
  r.link.mark('seen:a');
  await tick();
  store.fail = (op) => op === 'save';
  await r.link.keepForNextSignIn();
  assert.equal(r.link.keptForNextSignIn, false);
  store.fail = null;
  await r.link.keepForNextSignIn();
  assert.equal(r.link.keptForNextSignIn, true);
  assert.equal((await store.load('fixture-account', 'dev'))!.loggedOut, true);
});

test('recovery: work from an earlier page that needed a connection and was never sent goes; sent work replays only after a state read', async (t) => {
  const store = memoryOutboxStore();
  const record = emptyRecord('fixture-account', 'dev');
  const craft = (id: number, sent: boolean) => ({ id, kind: 'mutation' as const, path: '/api/craft', key: `k${id}`, body: JSON.stringify({ recipeId: 'plank', qty: 1, op: { lease: '', key: `k${id}` }, where: { area: 'village', x: 1, y: 1 } }), contract: 4, createdAt: Date.now(), sent, barrier: false, offline: false });
  record.entries = [craft(1, true), craft(2, false)];
  record.nextId = 3;
  seed(store, record);
  const r = await rig(t, { store, record });
  assert.deepEqual(r.link.outbox.map((e) => e.id), [1]);
  r.server.on('POST /api/craft', { body: { state: S({ version: 2 }), result: { recipeId: 'plank', output: { kind: 'material', id: 'timber', qty: 1 }, inventory: {} } } });
  await online(r);
  await r.link.flush();
  const order = r.server.calls.map((c) => c.path).filter((p) => p !== '/api/report');
  assert.deepEqual(order, ['/api/play', '/api/craft'], 'the play answer is the read before the replay');
  assert.equal(r.server.sent('POST /api/craft')[0]!.body.op.key, 'k1');
  void env;
  void stepOk;
});
