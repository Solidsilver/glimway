import test from 'node:test';
import assert from 'node:assert/strict';
import { Link } from '../src/game/link.ts';
import { Session } from '../src/game/session.ts';
import { bus, EV } from '../src/game/events.ts';
import { grantPaper } from '../src/game/papers.ts';
import { curatedToRestore, pickupChanges, wardenToRestore } from '../src/game/rollback.ts';
import { memoryOutboxStore } from '../src/lib/api/outbox.ts';
import { fakeServer, markOk, online, play, player, refuse, rig, S, tick } from './helpers/link-rig.ts';

/**
 * Review round 1, findings 11, 14 and 15: the scene follows a refused
 * prediction back, site papers need the world, and a find is announced once.
 */

// ---------------------------------------------------------------- 11. scene rollback

test('pickups: a refused take lies there again; one taken elsewhere goes', () => {
  assert.deepEqual(pickupChanges(['a', 'b'], ['a', 'c']), { add: ['c'], remove: ['b'] });
  assert.deepEqual(pickupChanges([], []), { add: [], remove: [] });
});

test('curated enemies: a refused defeat brings its enemy back; fights in progress and Wilds camps are left alone', () => {
  const spots = [
    { id: 'beetle-1', type: 'beetle' },
    { id: 'beetle-2', type: 'beetle' },
    { id: 'stone-warden', type: 'guardian' },
    { id: 'wilds:camp:1', type: 'beetle' },
  ];
  assert.deepEqual(curatedToRestore(spots, ['beetle-2'], new Set()).map((s) => s.id), ['beetle-1'], 'not defeated, not standing: back');
  assert.deepEqual(curatedToRestore(spots, [], new Set(['beetle-1', 'beetle-2'])), [], 'standing ones are untouched');
});

test('the warden stands again when its settling step was refused, and only then', () => {
  assert.equal(wardenToRestore('clue-found', 'settled', false), true);
  assert.equal(wardenToRestore('clue-found', null, false), true, 'nothing on its post either');
  assert.equal(wardenToRestore('clue-found', null, true), false, 'already fighting');
  assert.equal(wardenToRestore('guardian-defeated', 'settled', false), false);
  assert.equal(wardenToRestore('accepted', 'dormant', false), false);
  assert.equal(wardenToRestore('clue-found', 'settled', false, true), false, 'marked defeated: the step is on its way');
});

test('the view a refused defeat leaves behind names the enemy as undefeated again', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/story/mark', refuse('unknown-mark', S({ version: 2 })));
  r.link.mark('defeated:beetle-1');
  assert.deepEqual(r.session.state.defeatedEnemies, ['beetle-1']);
  await r.link.flush();
  assert.deepEqual(r.session.state.defeatedEnemies, []);
  assert.deepEqual(curatedToRestore([{ id: 'beetle-1', type: 'beetle' }], r.session.state.defeatedEnemies, new Set()).map((s) => s.id), ['beetle-1']);
});

// ---------------------------------------------------------------- 14. site papers

test('a site paper needs the world: offline it is neither queued nor shown', async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.link.takePaper('a-salting-drift-table', { epoch: 'e1', site: 'reeds-1' }), { ok: false, code: 'offline' });
  assert.equal(r.link.outbox.length, 0);
  assert.deepEqual(r.session.state.flags, []);
});

test('a placed paper queues offline and shows at once', async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.link.takePaper('will-of-elias-fenn'), { ok: true });
  assert.deepEqual(r.session.state.flags, ['paper:will-of-elias-fenn']);
  assert.equal(r.link.outbox.length, 1);
});

test('a site paper online waits for the world’s answer and says whether it was given', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/papers/take', refuse('paper-not-due', S({ version: 2 })));
  assert.deepEqual(await r.link.takePaper('a-salting-drift-table', { epoch: 'e1', site: 'reeds-1' }), { ok: false, code: 'paper-not-due' });
  assert.deepEqual(r.session.state.flags, []);
});

// ---------------------------------------------------------------- 15. one announcement per find

async function realSession(t: { after: (fn: () => void) => void }) {
  const server = fakeServer();
  const link = new Link({ api: server.api, clientId: 'tab', accountId: 'fixture-account', device: 'dev', name: 'Hero', state: player(S()), status: 'offline', emit: (e, ...a) => bus.emit(e, ...(a as [never])), store: memoryOutboxStore(), locks: null, channel: null })
  const session = new Session(link.initialState(), {}, link);
  t.after(() => link.stop());
  await link.ready();
  const found: string[] = [];
  const toasts: string[] = [];
  const onFound = (p: { id: string }) => found.push(p.id);
  const onToast = (p: { text: string }) => toasts.push(p.text);
  bus.on(EV.paperFound, onFound);
  bus.on(EV.toast, onToast);
  t.after(() => {
    bus.off(EV.paperFound, onFound);
    bus.off(EV.toast, onToast);
  });
  return { server, link, session, found, toasts };
}

test('a picked-up paper is announced once (one find event, one toast)', async (t) => {
  const s = await realSession(t);
  assert.equal(grantPaper(s.session, 'will-of-elias-fenn'), true);
  await tick();
  assert.deepEqual(s.found, ['will-of-elias-fenn']);
  assert.equal(s.toasts.filter((x) => x.length > 0).length, 1);
});

test('a paper only the server granted is announced once, when its mark arrives', async (t) => {
  const s = await realSession(t);
  s.server.on('POST /api/play', play(S()));
  await s.link.reconnect(false);
  s.server.on('GET /api/state', { body: { state: S({ version: 2, marks: ['paper:will-of-elias-fenn'] }), leaseActive: true } });
  await s.link.beat(true);
  await s.link.beat(true);
  assert.deepEqual(s.found, ['will-of-elias-fenn']);
  void markOk;
});
