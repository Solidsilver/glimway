import test from 'node:test';
import assert from 'node:assert/strict';
import { Link } from '../src/game/link.ts';
import { EV } from '../src/game/event-names.ts';
import { emptyRecord, memoryOutboxStore, type LockLike, type OutboxRecord } from '../src/lib/api/outbox.ts';
import { CONTRACT_NUMBER } from '../src/lib/contract.ts';
import { FakeLocks, FakeSession, fakeServer, markOk, play, player, S, seed, tick } from './helpers/link-rig.ts';

/**
 * The loading screen's Retry and Back to the title end the attempt's
 * session and start a fresh one in the same page (src/ui/account-flow.svelte.ts
 * retry). The two links share the page's client id and the device's outbox:
 * the new one waits for the old one to let the outbox lock go instead of
 * calling itself superseded by its own page, and work an earlier page left
 * is sent once, by the new link alone, even when the old link's /play
 * answer lands after the Retry.
 */

function makeLink(server: ReturnType<typeof fakeServer>, store: ReturnType<typeof memoryOutboxStore>, locks: LockLike | null, record: OutboxRecord | null, events: Array<[string, unknown]>) {
  const link = new Link({
    api: server.api,
    clientId: 'tab',
    accountId: 'fixture-account',
    device: 'dev',
    name: 'Hero',
    state: player(S()),
    record,
    status: 'offline',
    emit: ((e: string, p: unknown) => events.push([e, p])) as never,
    store,
    locks,
    channel: null,
    now: () => 1_000_000,
  });
  link.attach(new FakeSession(link.initialState()));
  return link;
}

/** An earlier page's story mark that may have been sent: it replays after the play read. */
function earlierWork(): OutboxRecord {
  const record = emptyRecord('fixture-account', 'dev');
  record.entries = [{ id: 1, kind: 'mark', path: '/api/story/mark', key: 'k1', body: JSON.stringify({ op: { lease: '', key: 'k1' }, mark: 'seen:old', where: { area: 'village', x: 1, y: 1 } }), contract: CONTRACT_NUMBER, createdAt: Date.now(), sent: true, barrier: false, offline: false }];
  record.nextId = 2;
  return record;
}

test('Retry mid-/play: the new link waits for the old one’s lock, plays, and replays the earlier page’s work exactly once', { timeout: 5000 }, async (t) => {
  const server = fakeServer();
  const store = memoryOutboxStore();
  const locks = new FakeLocks();
  const record = earlierWork();
  seed(store, record);
  server.on('POST /api/play', play(S()));
  server.on('POST /api/story/mark', markOk(S({ version: 2, marks: ['seen:old'] }), 'seen:old'));
  server.on('POST /api/report', { body: {} });
  const events: Array<[string, unknown]> = [];

  // The first attempt: its /play hangs (a waking radio).
  const first = makeLink(server, store, locks, structuredClone(record), events);
  t.after(() => first.stop());
  assert.equal(await first.ready(), true);
  const releasePlay = server.hold('POST /api/play');
  const firstPlay = first.reconnect(false);
  await tick();
  assert.equal(server.sent('POST /api/play').length, 1);

  // Retry: the attempt's session ends (Session.destroy → link.close), a fresh one starts at once.
  const closed = first.close();
  const second = makeLink(server, store, locks, structuredClone(record), events);
  t.after(() => second.stop());
  assert.equal(await second.ready(), true, 'the new link owns the outbox once the old one let go, not superseded by its own page');
  await closed;
  // The new attempt's /play queues behind the old one on the page's one API
  // client; the old answer lands after the Retry, on a stopped link.
  const secondPlay = second.reconnect(false);
  await tick();
  releasePlay();
  await firstPlay;
  await secondPlay;
  assert.equal(second.status, 'online');
  await second.flush();
  await tick();

  const marks = server.sent('POST /api/story/mark');
  assert.equal(marks.length, 1, 'the earlier page’s work went once');
  assert.equal(marks[0]!.body.op.key, 'k1');
  const plays = server.sent('POST /api/play');
  assert.equal(plays.length, 2);
  assert.ok(plays.every((c) => c.body.clientId === 'tab' && !c.body.takeOver), 'both plays are this page’s own client, never a take-over');
  assert.equal(events.some(([e, p]) => e === EV.link && (p as { status?: string }).status === 'superseded'), false, 'no one was superseded');
  assert.equal(second.outbox.length, 0);
});

test('a link stopped while it claims the outbox lets the lock go (a Retry can always own it)', { timeout: 5000 }, async (t) => {
  const store = memoryOutboxStore();
  const locks = new FakeLocks();
  const server = fakeServer();
  // The store's claim is slow: close lands in the middle of it.
  let releaseClaim!: () => void;
  const gate = new Promise<void>((r) => (releaseClaim = r));
  const claim = store.claim.bind(store);
  store.claim = async (...args: Parameters<typeof claim>) => {
    await gate;
    return claim(...args);
  };
  const events: Array<[string, unknown]> = [];
  const first = makeLink(server, store, locks, null, events);
  t.after(() => first.stop());
  await tick();
  const closed = first.close();
  releaseClaim();
  await closed;
  const second = makeLink(server, store, locks, null, events);
  t.after(() => second.stop());
  assert.equal(await second.ready(), true);
});

/**
 * Web Locks as a browser lets one go: the lock is free only a moment after
 * its holder released it (the request settles on a later task).
 */
class SlowReleaseLocks implements LockLike {
  private held = new Set<string>();
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown> {
    if (this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    return Promise.resolve(callback({ name })).then(
      (v) =>
        new Promise((r) =>
          setTimeout(() => {
            this.held.delete(name);
            r(v);
          }, 20)
        )
    );
  }
}

test("without Web Locks, a closing link still closes and the next one owns the outbox", { timeout: 5000 }, async (t) => {
  const store = memoryOutboxStore();
  const server = fakeServer();
  const events: Array<[string, unknown]> = [];
  const first = makeLink(server, store, null, null, events);
  t.after(() => first.stop());
  assert.equal(await first.ready(), true);
  const closed = first.close();
  const second = makeLink(server, store, null, null, events);
  t.after(() => second.stop());
  assert.equal(await second.ready(), true);
  await closed;
});

test("stopped mid-claim, a link’s close waits until its lock is really free: the replacement, built at once, owns it", { timeout: 5000 }, async (t) => {
  const store = memoryOutboxStore();
  const locks = new SlowReleaseLocks();
  const server = fakeServer();
  let releaseClaim!: () => void;
  const gate = new Promise<void>((r) => (releaseClaim = r));
  const claim = store.claim.bind(store);
  let first = true;
  store.claim = async (...args: Parameters<typeof claim>) => {
    if (first) {
      first = false;
      await gate;
    }
    return claim(...args);
  };
  const events: Array<[string, unknown]> = [];
  const a = makeLink(server, store, locks, null, events);
  t.after(() => a.stop());
  await tick();
  // Retry: the old link closes while its claim is under way, and the new one is built straight away.
  const closed = a.close();
  const b = makeLink(server, store, locks, null, events);
  t.after(() => b.stop());
  releaseClaim();
  assert.equal(await b.ready(), true, "the replacement waited for the lock, not superseded by its own page");
  await closed;
  assert.equal(events.some(([e, p]) => e === EV.link && (p as { status?: string }).status === "superseded"), false);
});
