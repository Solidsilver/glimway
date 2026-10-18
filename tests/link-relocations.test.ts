import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Link } from '../src/game/link.ts';
import { Session } from '../src/game/session.ts';
import { bus, EV, type RelocatePayload } from '../src/game/events.ts';
import { memoryOutboxStore, type OutboxRecord } from '../src/lib/api/outbox.ts';
import { WAYS_HOME_LINES } from '../src/lib/ways-home.ts';
import { ackReport, env, fakeServer, markOk, play, player, refuse, S, tick, wire, type Answer, type Call } from './helpers/link-rig.ts';

// The session saves through window timers; hold them so nothing writes.
(globalThis as unknown as { window: unknown }).window = { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {} };

/**
 * A place the world chose itself (a way home's landing, a reach settled
 * around the hero) is a move the server names (`Place.movedVersion`), and
 * the hero follows it as the state carrying it is adopted: an answer, a
 * report's answer or a read alike (A2b, Sol's cross-reviews). Adopting a
 * state makes its place watermark the reports' basis; a report frozen before
 * the hero followed carried that basis with the departure point, the server
 * took it, and a reload started back where the hero left. A place the client
 * sent itself is never a move, whatever the world echoes. A real Session, as
 * in tests/travel-hold.test.ts.
 */

const HOME = { area: 'outdoors', x: 1000, y: 1000 };
type At = { area: string; x: number; y: number };

/** A state at `version` whose place was written at that version (`moved`: by the world's own choice). */
function placed(version: number, at: At, opts: { moved?: boolean } = {}): Record<string, any> {
  const s = S({ version, area: at.area, x: at.x, y: at.y });
  s.place.placeSetVersion = version;
  if (opts.moved) s.place.movedVersion = version;
  return s;
}

/** The world's way home landing at `at` (version 2), answered to a turncap. */
const landed = (at: At = HOME) => env(placed(2, at, { moved: true }), { waysHome: { action: 'turncap', binding: null, ...at } });

/** Link and real Session, online; a fresh page's hero has walked to (100, 100). */
async function connected(t: TestContext, opts: { store?: ReturnType<typeof memoryOutboxStore>; record?: OutboxRecord | null; state?: Record<string, any>; play?: Record<string, any>; answers?: (server: ReturnType<typeof fakeServer>) => void } = {}) {
  const server = fakeServer();
  const store = opts.store ?? memoryOutboxStore();
  const events: Array<[string, unknown]> = [];
  const link = new Link({ api: server.api, clientId: 'tab', accountId: 'fixture-account', device: 'dev', name: 'Hero', state: player(opts.state ?? S()), record: opts.record, status: 'offline', emit: ((e: string, p: unknown) => events.push([e, p])) as never, store, locks: null, channel: null, now: () => 1_000_000 });
  const session = new Session(link.initialState());
  server.on('POST /api/report', (c: Call) => {
    const kept = wire(link.server);
    kept.version += 1;
    return ackReport(() => kept)(c);
  });
  link.attach(session);
  const moves: RelocatePayload[] = [];
  const onMove = (p: RelocatePayload) => moves.push(p);
  bus.on(EV.relocate, onMove);
  t.after(() => {
    bus.off(EV.relocate, onMove);
    link.stop();
  });
  await link.ready();
  opts.answers?.(server);
  server.on('POST /api/play', play(opts.play ?? S()));
  await link.reconnect(false);
  assert.equal(link.status, 'online');
  if (!opts.record) session.state.position = { x: 100, y: 100 };
  const toasts = () => events.filter(([e]) => e === EV.toast).map(([, p]) => (p as { text: string }).text);
  return { server, store, link, session, moves, toasts };
}

const reports = (server: ReturnType<typeof fakeServer>) => server.sent('POST /api/report').map((c) => c.body as { basis: number; place: At });

/** Every report on basis `basis` or later names `at`, and one went. */
function reportsAt(server: ReturnType<typeof fakeServer>, basis: number, at: At): void {
  const sent = reports(server).filter((r) => r.basis >= basis);
  assert.ok(sent.length > 0, `a report on basis ${basis} went`);
  for (const rep of sent) assert.deepEqual(rep.place, at, `a report on basis ${rep.basis} names ${JSON.stringify(at)}`);
}

const late = WAYS_HOME_LINES.late(WAYS_HOME_LINES.arrived.turncap);

test('a report deadline while a ways-home answer settles never pairs the new basis with the departure point', async (t) => {
  const { server, store, link, session, moves, toasts } = await connected(t);
  // The answer is deferred; a deadline fires while it is in flight, and
  // another while its settlement is being stored.
  const release = server.hold('POST /api/ways-home');
  let settling = false;
  server.on('POST /api/ways-home', () => {
    settling = true;
    return landed() as Exclude<Answer, 'network'>;
  });
  store.fail = (op) => {
    if (op === 'save' && settling) {
      settling = false;
      link.reportDeadline();
    }
    return false;
  };
  const travel = link.waysHome({ action: 'turncap', lamp: '' });
  await tick();
  link.reportDeadline();
  release();
  assert.equal((await travel).ok, true);
  await link.flush();

  assert.deepEqual([session.state.area, session.state.position], ['outdoors', { x: 1000, y: 1000 }]);
  assert.deepEqual(moves, [HOME], 'the scene is told once');
  reportsAt(server, 2, HOME);
  assert.deepEqual(link.reports.next.place, HOME);
  assert.deepEqual(toasts(), [], 'the waiting caller says it, not a toast');
});

test('binding a pouch moves nobody: the answer names the place the request did', async (t) => {
  const { server, link, session, moves } = await connected(t);
  server.on('POST /api/ways-home', env(placed(2, { area: 'outdoors', x: 100, y: 100 }), { waysHome: { action: 'bind', binding: null, area: '', x: 0, y: 0 } }));
  const bind = link.waysHome({ action: 'bind', lamp: 'lamp-1' });
  // The hero walks on while the answer is out.
  session.state.position = { x: 140, y: 100 };
  assert.equal((await bind).ok, true);
  assert.deepEqual(session.state.position, { x: 140, y: 100 });
  assert.equal(moves.length, 0);
});

test('an operation answered at its own place leaves the hero where they walked since', async (t) => {
  const { server, link, session, moves } = await connected(t);
  server.on('POST /api/story/mark', markOk(placed(2, { area: 'outdoors', x: 100, y: 100 }), 'seen:old-oak'));
  link.mark('seen:old-oak');
  // The hero walks on while the mark is out.
  session.state.position = { x: 300, y: 300 };
  await tick();
  await link.flush();
  link.reportDeadline();
  await link.flush();
  assert.deepEqual(session.state.position, { x: 300, y: 300 });
  assert.equal(moves.length, 0);
  const last = reports(server).at(-1)!;
  assert.deepEqual([last.basis, last.place], [2, { area: 'outdoors', x: 300, y: 300 }]);
});

test('a reach the world settled around the hero: an operation’s answer and a report’s answer both move them', async (t) => {
  const { server, link, session, moves } = await connected(t);
  // An operation's answer: the world moved the place it named.
  server.on('POST /api/story/mark', markOk(placed(2, { area: 'outdoors', x: 700, y: 700 }, { moved: true }), 'seen:old-oak'));
  link.mark('seen:old-oak');
  await tick();
  await link.flush();
  assert.deepEqual(session.state.position, { x: 700, y: 700 });
  // A report's answer: accepted, then moved again (a turning shrank the reach).
  server.on('POST /api/report', (c: Call) => ackReport(() => placed(4, { area: 'outdoors', x: 500, y: 520 }, { moved: true }))(c));
  session.state.position = { x: 720, y: 700 };
  link.reportDeadline();
  await link.flush();
  assert.deepEqual(session.state.position, { x: 500, y: 520 });
  assert.deepEqual(moves, [{ area: 'outdoors', x: 700, y: 700 }, { area: 'outdoors', x: 500, y: 520 }]);
  assert.deepEqual([link.reports.next.basis, link.reports.next.place, link.reports.moved], [4, { area: 'outdoors', x: 500, y: 520 }, 4]);
});

test('a ways-home whose reply was lost: the reconnect’s read moves the hero, and the replay says it went through', async (t) => {
  const { server, link, session, moves, toasts } = await connected(t);
  server.on('POST /api/ways-home', 'network');
  const r = await link.waysHome({ action: 'turncap', lamp: '' });
  assert.deepEqual(r, { ok: false, code: 'pending' }, 'the caller hears it may still go through');
  // It committed. The hero walks on, then the connection is back: /play holds the landing.
  session.state.position = { x: 600, y: 600 };
  server.on('POST /api/ways-home', landed());
  server.on('GET /api/state', { body: { state: placed(2, HOME, { moved: true }), leaseActive: true } });
  server.on('POST /api/play', play(placed(2, HOME, { moved: true })));
  await link.reconnect(false);
  assert.deepEqual(session.state.position, { x: 1000, y: 1000 }, 'the read moved the hero before anything was reported');
  await link.flush();
  link.reportDeadline();
  await link.flush();
  assert.equal(link.outbox.length, 0);
  assert.deepEqual(session.state.position, { x: 1000, y: 1000 });
  assert.deepEqual(moves, [HOME]);
  reportsAt(server, 2, HOME);
  assert.deepEqual(toasts(), [late], 'the late landing is told once');
});

test('a ways-home whose reply was lost, across a reload: the page starts where the world landed the hero', async (t) => {
  const store = memoryOutboxStore();
  const first = await connected(t, { store });
  first.server.on('POST /api/ways-home', 'network');
  assert.deepEqual(await first.link.waysHome({ action: 'turncap', lamp: '' }), { ok: false, code: 'pending' });
  first.session.state.position = { x: 600, y: 600 };
  await first.link.persist();
  first.link.stop();

  // The sign-in read already holds the landing.
  const record = await store.load('fixture-account', 'dev');
  const next = await connected(t, {
    store, record, state: placed(2, HOME, { moved: true }), play: placed(2, HOME, { moved: true }),
    answers: (server) => {
      server.on('POST /api/ways-home', landed());
      server.on('GET /api/state', { body: { state: placed(2, HOME, { moved: true }), leaseActive: true } });
    },
  });
  assert.deepEqual(next.session.state.position, { x: 1000, y: 1000 }, 'the reload starts at the landing');
  await next.link.flush();
  next.link.reportDeadline();
  await next.link.flush();
  assert.equal(next.link.outbox.length, 0);
  reportsAt(next.server, 2, HOME);
  assert.deepEqual(next.toasts(), [late]);
});

test('a ways-home answered idempotency-mismatch whose lookup fails: the refusal’s state still moves the hero', async (t) => {
  const { server, link, session, moves } = await connected(t);
  server.on('POST /api/ways-home', refuse('idempotency-mismatch', placed(2, HOME, { moved: true })));
  server.beforeSend.push((c) => {
    if (c.path === '/api/ways-home') server.on(`GET /api/operations/result?route=${encodeURIComponent('/api/ways-home')}&key=${encodeURIComponent(c.body.op.key)}`, 'network');
  });
  const r = await link.waysHome({ action: 'turncap', lamp: '' });
  assert.equal(r.ok, false);
  assert.equal(link.outbox.length, 1, 'kept until a lookup says');
  assert.deepEqual(session.state.position, { x: 1000, y: 1000 });
  assert.deepEqual(moves, [HOME]);
  assert.deepEqual([link.reports.next.basis, link.reports.next.place], [2, HOME], 'the next report pairs the new basis with the landing');
});

test('an outdoor item action whose answer settled the reach moves the hero', async (t) => {
  const { server, link, session, moves } = await connected(t);
  const reach = { area: 'outdoors', x: 480, y: 500 };
  // Every ItemsResult field, as the wire spells them (tests/api-client.test.ts).
  const items = { stacks: [], instances: [], pockets: [], offHand: { open: false, class: null, itemDef: null, instance: null }, pickedUp: [], thanks: [], carried: [], plants: [] };
  const fields = { wear: null, used: 'herb-broth', pickup: '', given: null, mended: '', created: [], gathered: [], plant: null, land: null, returned: '', paper: null, heirloom: '', adaOilCount: 0, glimsGiven: 0, tapped: null, firstTap: false, refined: null, bought: null };
  server.on('POST /api/items/use', { body: { state: placed(9, reach, { moved: true }), result: { items, ...fields } } });
  const res = await link.mutate({ kind: 'items', op: 'use', fields: { itemDef: 'herb-broth' } });
  assert.equal(res.ok, true);
  assert.deepEqual(session.state.position, { x: 480, y: 500 });
  assert.deepEqual(moves, [reach]);
  link.reportDeadline();
  await link.flush();
  reportsAt(server, 9, reach);
});

test('a snapped echo of the operation’s own place is no move', async (t) => {
  const { server, link, session, moves } = await connected(t);
  // The mark names (100, 100); the world keeps it snapped to (104, 104).
  server.on('POST /api/story/mark', markOk(placed(2, { area: 'outdoors', x: 104, y: 104 }), 'seen:old-oak'));
  link.mark('seen:old-oak');
  session.state.position = { x: 600, y: 600 };
  await tick();
  await link.flush();
  assert.deepEqual(session.state.position, { x: 600, y: 600 });
  assert.equal(moves.length, 0);
  assert.deepEqual(reports(server).at(-1)!.place, { area: 'outdoors', x: 600, y: 600 });
});

test('a replay carrying a newer ordinary place write from the same lease is no move', async (t) => {
  const { server, link, session, moves } = await connected(t);
  // Answered at version 5: the place another of this lease's operations wrote, elsewhere.
  server.on('POST /api/story/mark', markOk(placed(5, { area: 'outdoors', x: 300, y: 300 }), 'seen:old-oak'));
  link.mark('seen:old-oak');
  session.state.position = { x: 600, y: 600 };
  await tick();
  await link.flush();
  assert.deepEqual(session.state.position, { x: 600, y: 600 });
  assert.equal(moves.length, 0);
  const last = reports(server).at(-1)!;
  assert.deepEqual([last.basis, last.place], [5, { area: 'outdoors', x: 600, y: 600 }]);
});

test('a ways-home the caller heard as pending lands on the retry: the hero moves and is told why', async (t) => {
  const { server, link, session, moves, toasts } = await connected(t);
  server.on('POST /api/ways-home', 'network', landed());
  server.on('GET /api/state', { body: { state: S(), leaseActive: true } });
  assert.deepEqual(await link.waysHome({ action: 'turncap', lamp: '' }), { ok: false, code: 'pending' });
  assert.deepEqual(session.state.position, { x: 100, y: 100 });
  // The retry: the world hadn't taken it yet, and takes it now.
  await link.reconnect(false);
  await link.flush();
  assert.equal(link.outbox.length, 0);
  assert.deepEqual(session.state.position, { x: 1000, y: 1000 });
  assert.deepEqual(moves, [HOME]);
  assert.deepEqual(toasts(), [late]);
  reportsAt(server, 2, HOME);
});
