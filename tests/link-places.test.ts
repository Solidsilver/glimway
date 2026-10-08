import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryOutboxStore } from '../src/lib/api/outbox.ts';
import { noteServerClock } from '../src/lib/server-time.ts';
import { env, online, refuse, rig, S, type Call } from './helpers/link-rig.ts';

/**
 * Places the world doesn't take (indoors review, blocking 1): a room or
 * cottage the server refuses or ignores puts the hero back where the server
 * says, and a reload starts there; and a queued quest step's gate time is
 * stamped from the server's clock.
 */

const ROOM = { area: 'in:village:bakery', position: { x: 104, y: 136 } };

/** The hero walks into a room (the scene moved the live place). */
function walkIn(r: Awaited<ReturnType<typeof rig>>): void {
  r.session.state.area = ROOM.area;
  r.session.state.position = { ...ROOM.position };
}

test('a report whose place the world refuses: the hero goes where the world says, and the next report names it', async (t) => {
  const r = await rig(t);
  await online(r);
  walkIn(r);
  r.server.on('POST /api/report', refuse('invalid-position', S({ version: 2 })));
  r.link.reportSoon();
  await r.link.flush();
  assert.equal(r.session.state.area, 'village', 'back outside');
  assert.deepEqual(r.session.state.position, { x: 400, y: 300 });
  assert.equal(r.link.status, 'online', 'a refused place is not server trouble');
  // The refused report is gone; the next one names the world's place.
  r.server.on('POST /api/report', (c: Call) => env(S({ version: 3 }), { report: { seq: c.body.seq, accepted: true, staleBasis: false, casts: 0, client: c.body.client, generation: c.body.generation, basis: c.body.basis, placeIgnored: false } }));
  r.link.reportSoon();
  await r.link.flush();
  const sent = r.server.sent('POST /api/report').map((c) => c.body.place.area);
  assert.deepEqual(sent, ['in:village:bakery', 'village']);
});

test('a reload after a refused place starts where the world says, not in the room', async (t) => {
  const store = memoryOutboxStore();
  const first = await rig(t, { store });
  await online(first);
  walkIn(first);
  first.server.on('POST /api/report', refuse('invalid-position', S({ version: 2 })));
  first.link.reportSoon();
  await first.link.flush();
  await first.link.persist();
  first.link.stop();

  const record = await store.load('fixture-account', 'dev');
  const next = await rig(t, { store, record, state: S({ version: 2 }) });
  assert.equal(next.session.state.area, 'village');
  assert.deepEqual(next.session.state.position, { x: 400, y: 300 });
});

test('a reload that replays a room report the world then refuses ends outside too', async (t) => {
  const store = memoryOutboxStore();
  const first = await rig(t, { store });
  await online(first);
  walkIn(first);
  // The tab closes with the room's report on its way (no answer reached it).
  first.server.on('POST /api/report', 'network');
  first.link.reportSoon();
  await first.link.flush();
  await first.link.persist();
  first.link.stop();

  const record = await store.load('fixture-account', 'dev');
  const next = await rig(t, { store, record, state: S({ version: 1 }) });
  assert.equal(next.session.state.area, ROOM.area, 'the last page’s place, until the world answers');
  next.server.on('POST /api/play', () => ({ body: { state: S({ version: 1 }), lease: 'L1', reportGeneration: 'gen-1', reportClient: 'rc' } }));
  next.server.on('POST /api/report', refuse('invalid-position', S({ version: 2 })));
  await next.link.reconnect(false);
  await next.link.flush();
  assert.ok(next.server.sent('POST /api/report').some((c) => c.body.place.area === ROOM.area), 'the room report was replayed');
  assert.equal(next.session.state.area, 'village');
});

test('an accepted report whose place the world ignored: still standing there, the hero goes where the world holds them', async (t) => {
  const r = await rig(t);
  await online(r);
  walkIn(r);
  const ignored = (c: Call) => env(S({ version: 2 }), { report: { seq: c.body.seq, accepted: true, staleBasis: false, casts: 0, client: c.body.client, generation: c.body.generation, basis: c.body.basis, placeIgnored: true } });
  r.server.on('POST /api/report', ignored);
  r.link.reportSoon();
  await r.link.flush();
  assert.equal(r.session.state.area, 'village');

  // Moved on since the report was captured: the next report says so, nobody is pulled back.
  walkIn(r);
  r.server.beforeSend.push((c) => {
    if (c.path === '/api/report') r.session.state.area = 'woodland';
  });
  r.server.on('POST /api/report', ignored);
  r.link.reportSoon();
  await r.link.flush();
  assert.equal(r.session.state.area, 'woodland');
});

test('a quest step queued offline is stamped with the server’s clock, not the device’s', async (t) => {
  // The server is two hours ahead of this device.
  const ahead = Date.now() / 1000 + 7200;
  noteServerClock({ get: (name: string) => (name === 'x-glimway-now' ? String(ahead) : null) });
  const r = await rig(t);
  // Offline: it queues (the caller hears it as taken) and is predicted at once.
  assert.equal(await r.link.questStep('signpost', 'meet-orrin'), null);
  assert.equal(r.link.outbox.length, 1);
  const at = r.session.state.questGateAt?.signpost;
  assert.ok(at !== undefined && Math.abs(at - ahead) < 5, `the gate time is the server's (${at} vs ${ahead})`);
});

test('an ignored place in the same area is a stale sample: nobody is pulled back across the square', async (t) => {
  const r = await rig(t);
  await online(r);
  r.session.state.position = { x: 520, y: 260 };
  r.server.on('POST /api/report', (c: Call) => env(S({ version: 2 }), { report: { seq: c.body.seq, accepted: true, staleBasis: false, casts: 0, client: c.body.client, generation: c.body.generation, basis: c.body.basis, placeIgnored: true } }));
  r.link.reportSoon();
  await r.link.flush();
  assert.equal(r.session.state.area, 'village');
  assert.deepEqual(r.session.state.position, { x: 520, y: 260 }, 'where the hero walked to');
});
