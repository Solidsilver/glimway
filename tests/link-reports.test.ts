import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryOutboxStore } from '../src/lib/api/outbox.ts';
import { ackReport, env, online, play, rig, S, tick, wire, type Call, type Rig } from './helpers/link-rig.ts';

/**
 * Review round 1, findings 3, 4, 12 and 13: a fall's causal boundary across
 * reloads, barriers that cover the screen's state, periodic reports, and
 * area reports on arrival.
 */

/** The fall's answer: recovery 13/10 at vitals version `vsv`. */
const fallAnswer = (vsv: number, version = vsv) => env(S({ version, hp: 13, mana: 10, vitalsSetVersion: vsv }), { fall: { vitals: S({ hp: 13, mana: 10, vitalsSetVersion: vsv }).vitals, place: S().place, lantern: 'none', reason: 'not-wilds', lanternId: '', epoch: '' } });
const reports = (r: Rig) => r.server.sent('POST /api/report').map((c) => c.body);
/** A server that keeps whatever a report says (at version +1). */
const keeper = (r: Rig) => (c: Call) => {
  const kept = wire(r.link.server);
  kept.version += 1;
  kept.vitals.hp = Math.min(c.body.hp, kept.vitals.maxHp);
  kept.vitals.mana = Math.min(c.body.mana, kept.vitals.maxMana);
  return ackReport(() => kept)(c);
};

// ---------------------------------------------------------------- 3. falls across reloads

test('an uncommitted offline fall survives a reload: the recovery and what happened after it are kept', async (t) => {
  const store = memoryOutboxStore();
  const first = await rig(t, { store, state: S({ hp: 40 }) });
  first.session.state.area = 'woodland';
  first.session.state.hp = 0;
  await first.link.fall();
  first.session.state.hp = 9; // hurt again after waking
  await first.link.persist();
  first.link.stop();

  const record = await store.load('fixture-account', 'dev');
  const next = await rig(t, { store, record, state: S({ hp: 40 }) });
  assert.deepEqual([next.session.state.area, next.session.state.hp], ['village', 9], 'no reload heals or moves the hero');
  next.server.on('POST /api/fall', fallAnswer(3));
  next.server.on('POST /api/report', keeper(next));
  await online(next, S({ hp: 40 }));
  await next.link.flush();
  assert.equal(next.session.state.hp, 9, 'the answer keeps the hurt after the predicted recovery');
  assert.equal(next.link.reports.next.boundary, null);
  const rep = reports(next)[0]!;
  assert.deepEqual([rep.basis, rep.hp], [3, 9]);
});

test('a committed fall whose answer was lost: after a reload the replay releases the boundary and keeps the hurt', async (t) => {
  const store = memoryOutboxStore();
  const first = await rig(t, { store, state: S({ hp: 40 }) });
  await online(first, S({ hp: 40 }));
  first.server.on('POST /api/fall', 'network');
  first.session.state.hp = 0;
  await first.link.fall();
  await first.link.flush();
  first.session.state.hp = 9;
  await first.link.persist();
  first.link.stop();

  // The world already holds the fall: the login says so.
  const record = await store.load('fixture-account', 'dev');
  const next = await rig(t, { store, record, state: S({ version: 3, hp: 13, mana: 10, vitalsSetVersion: 3 }) });
  assert.equal(next.session.state.hp, 9);
  next.server.on('POST /api/play', play(S({ version: 3, hp: 13, mana: 10, vitalsSetVersion: 3 })));
  next.server.on('POST /api/fall', fallAnswer(3));
  next.server.on('POST /api/report', keeper(next));
  await next.link.reconnect(false);
  await next.link.flush();
  assert.equal(next.link.outbox.length, 0);
  assert.equal(next.link.reports.next.boundary, null, 'reports are no longer blocked');
  assert.equal(next.session.state.hp, 9);
  assert.deepEqual([reports(next)[0]!.basis, reports(next)[0]!.hp], [3, 9]);
});

// ---------------------------------------------------------------- 4. barriers

test('a rest while a report is still unanswered: that report goes, then one with the screen’s state now, then the rest', async (t) => {
  const r = await rig(t, { state: S({ hp: 20 }) });
  await online(r, S({ hp: 20 }));
  // The first answer is for some other report: this one stays captured, unanswered.
  r.server.on('POST /api/report', (c) => ackReport(() => S({ hp: 20 }))({ ...c, body: { ...c.body, seq: 99 } }), keeper(r));
  r.session.state.hp = 10;
  r.link.reportSoon();
  await r.link.flush();
  assert.equal(r.link.reports.captured?.hp, 10);
  r.session.state.hp = 6;
  r.link.noteCast();
  r.server.on('POST /api/spend', env(S({ version: 9, hp: 50, vitalsSetVersion: 9 }), { spend: { outcome: '' } }));
  assert.equal(await r.link.spend({ kind: 'rest' }), null);
  const sent = reports(r).slice(1);
  assert.deepEqual(sent.map((b) => [b.seq, b.hp, b.casts]), [[1, 10, 0], [2, 6, 1]], 'the cast is reported, not lost to the rest');
  assert.deepEqual(r.server.sent('POST /api/spend')[0]!.body.op.report, { client: 'rc', generation: 'gen-1', seq: 2 });
});

test('a stale-basis acknowledgment is no barrier: a fresh report on the server’s basis goes first', async (t) => {
  const r = await rig(t, { state: S({ hp: 20 }) });
  await online(r, S({ hp: 20 }));
  r.session.state.hp = 12;
  let first = true;
  r.server.on('POST /api/report', (c) => {
    if (first) {
      first = false;
      // A refill landed meanwhile: the world's vitals moved on, and this report's basis is old.
      return ackReport(() => S({ version: 4, hp: 30, vitalsSetVersion: 4 }), { accepted: false, staleBasis: true })(c);
    }
    return keeper(r)(c);
  });
  r.server.on('POST /api/spend', env(S({ version: 9, hp: 50, vitalsSetVersion: 9 }), { spend: { outcome: '' } }));
  assert.equal(await r.link.spend({ kind: 'rest' }), null);
  const sent = reports(r);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.basis, 4);
  assert.equal(r.server.sent('POST /api/spend')[0]!.body.op.report.seq, 2);
});

test('a consumable carries a barrier too', async (t) => {
  const r = await rig(t, { state: S({ hp: 20 }) });
  await online(r, S({ hp: 20 }));
  r.session.state.hp = 7;
  r.server.on('POST /api/report', keeper(r));
  r.server.on('POST /api/items/use', { body: { state: S({ version: 9, hp: 27, vitalsSetVersion: 9 }), result: { items: { stacks: [], instances: [], pockets: [], offhand: null }, used: 'herb-broth' } } });
  await r.link.mutate({ kind: 'items', op: 'use', fields: { itemDef: 'herb-broth' } });
  assert.deepEqual(r.server.calls.map((c) => c.path).filter((p) => p !== '/api/play'), ['/api/report', '/api/items/use']);
  assert.equal(r.server.sent('POST /api/items/use')[0]!.body.op.report.seq, 1);
  assert.equal(reports(r)[0]!.hp, 7);
});

test('a profile sync carries a barrier', async (t) => {
  const r = await rig(t, { state: S({ hp: 20 }) });
  await online(r, S({ hp: 20 }));
  r.session.state.hp = 5;
  r.server.on('POST /api/report', keeper(r));
  r.server.on('POST /api/profile', env(S({ version: 9 }), { profile: { status: 'unchanged', credit: 0, pending: 0, vitalsCredit: { hp: 0, mana: 0 } } }));
  const res = await r.link.profile({ _id: 'fixture-hero', stats: { hp: 20, mp: 10, lvl: 1, exp: 0, class: 'warrior', str: 0, int: 0, con: 0, per: 0, buffs: { str: 0, int: 0, con: 0, per: 0 }, maxHealth: 50, maxMP: 30 }, profile: { name: 'Hero' }, flags: { classSelected: true } });
  assert.equal(res.ok, true);
  assert.deepEqual(r.server.sent('POST /api/profile')[0]!.body.report, { client: 'rc', generation: 'gen-1', seq: 1 });
  assert.equal(reports(r)[0]!.hp, 5);
});

// ---------------------------------------------------------------- 12. periodic reports

test('the ten-second deadline reports even an idle hero at full vitals, every time', async (t) => {
  const r = await rig(t, { state: S({ hp: 50, mana: 30 }) });
  await online(r, S({ hp: 50, mana: 30 }));
  r.server.on('POST /api/report', keeper(r));
  for (let i = 0; i < 3; i++) {
    r.link.reportDeadline();
    await r.link.flush();
  }
  assert.equal(reports(r).length, 3);
  assert.deepEqual(reports(r).map((b) => b.seq), [1, 2, 3]);
  r.link.reportSoon();
  await r.link.flush();
  assert.equal(reports(r).length, 3, 'only the deadline forces one; nothing new, nothing sent otherwise');
});

// ---------------------------------------------------------------- 13. area and region reports

test('arriving in another Wilds region reports it, both ways; a chunk step within a region does not', async (t) => {
  const r = await rig(t, { state: S({ area: 'wilds:inner-1', x: 100, y: 100 }) });
  await online(r, S({ area: 'wilds:inner-1', x: 100, y: 100 }));
  r.server.on('POST /api/report', keeper(r));
  const settle = async () => {
    for (let i = 0; i < 5; i++) await tick();
  };
  r.link.arrived();
  await settle();
  r.session.state.wildsRegion = 'outer-1';
  r.session.state.position = { x: 500, y: 600 };
  r.link.arrived();
  await settle();
  r.session.state.position = { x: 520, y: 640 };
  r.link.arrived();
  await settle();
  delete r.session.state.wildsRegion;
  r.session.state.position = { x: 30, y: 40 };
  r.link.arrived();
  await settle();
  assert.deepEqual(reports(r).map((b) => b.place.area), ['wilds:inner-1', 'wilds:outer-1', 'wilds:inner-1']);
  assert.deepEqual(reports(r)[1]!.place, { area: 'wilds:outer-1', x: 500, y: 600 });
});

test('a fall names where the hero stands when it falls', async (t) => {
  const r = await rig(t);
  r.session.state.area = 'woodland';
  r.session.state.position = { x: 812, y: 333 };
  r.session.state.hp = 0;
  await r.link.fall();
  assert.deepEqual(JSON.parse(r.link.outbox[0]!.body).where, { area: 'woodland', x: 812, y: 333 });
  void tick;
});
