import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Link } from '../src/game/link.ts';
import { Session } from '../src/game/session.ts';
import { bus, EV, type RelocatePayload } from '../src/game/events.ts';
import { memoryOutboxStore } from '../src/lib/api/outbox.ts';
import { ackReport, env, fakeServer, markOk, play, player, S, tick, wire, type Call } from './helpers/link-rig.ts';

// The session saves through window timers; hold them so nothing writes.
(globalThis as unknown as { window: unknown }).window = { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {} };

/**
 * A place the world chose (a ways-home arrival, a settled reach) moves the
 * session as its answer settles, before any report samples the place (A2b,
 * Sol's cross-review of A2). Adopting the answer makes its place watermark
 * the reports' basis; a report frozen before the hero followed carried that
 * basis with the departure point, the server took it, and a reload started
 * back where the hero left. A real Session, as in tests/travel-hold.test.ts.
 */

const HOME = { area: 'outdoors', x: 1000, y: 1000 };

/** A state at `version` whose place the world set at that version. */
function placed(version: number, at: { area: string; x: number; y: number }): Record<string, any> {
  const s = S({ version, area: at.area, x: at.x, y: at.y });
  s.place.placeSetVersion = version;
  return s;
}

/** Link and real Session, online, with the hero walked to (100, 100). */
async function connected(t: TestContext) {
  const server = fakeServer();
  const store = memoryOutboxStore();
  const link = new Link({ api: server.api, clientId: 'tab', accountId: 'fixture-account', device: 'dev', name: 'Hero', state: player(S()), status: 'offline', emit: (() => {}) as never, store, locks: null, channel: null, now: () => 1_000_000 });
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
  server.on('POST /api/play', play(S()));
  await link.reconnect(false);
  assert.equal(link.status, 'online');
  session.state.position = { x: 100, y: 100 };
  return { server, store, link, session, moves };
}

const reports = (server: ReturnType<typeof fakeServer>) => server.sent('POST /api/report').map((c) => c.body as { basis: number; place: { area: string; x: number; y: number } });

test('a report deadline while a ways-home answer settles never pairs the new basis with the departure point', async (t) => {
  const { server, store, link, session, moves } = await connected(t);
  // The answer is deferred; a deadline fires while it is in flight, and
  // another while its settlement is being stored.
  const release = server.hold('POST /api/ways-home');
  let settling = false;
  server.on('POST /api/ways-home', () => {
    settling = true;
    return env(placed(2, HOME), { waysHome: { action: 'turncap', binding: null, ...HOME } });
  });
  store.fail = (op) => {
    if (op === 'save' && settling) {
      settling = false;
      link.reportDeadline();
    }
    return false;
  };
  const travel = link.waysHome({ action: 'turncap', lamp: '' });
  await new Promise((r) => setTimeout(r, 0));
  link.reportDeadline();
  release();
  const r = await travel;
  assert.equal(r.ok, true);
  await link.flush();

  assert.deepEqual([session.state.area, session.state.position], ['outdoors', { x: 1000, y: 1000 }]);
  assert.deepEqual(moves, [{ area: 'outdoors', x: 1000, y: 1000 }], 'the scene is told once');
  const sent = reports(server);
  assert.ok(sent.length > 0, 'the deadline reported');
  for (const rep of sent) {
    if (rep.basis >= 2) assert.deepEqual(rep.place, HOME, `a report on the new basis names the destination (${JSON.stringify(rep)})`);
  }
  assert.deepEqual(link.reports.next.place, HOME);
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
  server.on('POST /api/story/mark', markOk(placed(2, { area: 'outdoors', x: 700, y: 700 }), 'seen:old-oak'));
  link.mark('seen:old-oak');
  await tick();
  await link.flush();
  assert.deepEqual(session.state.position, { x: 700, y: 700 });
  // A report's answer: accepted, then moved again (a turning shrank the reach).
  server.on('POST /api/report', (c: Call) => ackReport(() => placed(4, { area: 'outdoors', x: 500, y: 520 }))(c));
  session.state.position = { x: 720, y: 700 };
  link.reportDeadline();
  await link.flush();
  assert.deepEqual(session.state.position, { x: 500, y: 520 });
  assert.deepEqual(moves, [{ area: 'outdoors', x: 700, y: 700 }, { area: 'outdoors', x: 500, y: 520 }]);
  assert.deepEqual([link.reports.next.basis, link.reports.next.place], [4, { area: 'outdoors', x: 500, y: 520 }]);
});
