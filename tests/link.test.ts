import test from 'node:test';
import assert from 'node:assert/strict';
import { Link, type LinkSession } from '../src/game/link.ts';
import { EV } from '../src/game/event-names.ts';
import { createApiClient } from '../src/lib/api/client.ts';
import { docKey } from '../src/lib/api/progress.ts';
import type { ConnectedCache, LinkStore, OrphanCopy } from '../src/lib/api/cache.ts';
import { createNewGame, type GameState } from '../src/lib/state.ts';
import type { HabiticaProfile, VitalsSource } from '../src/lib/habitica/types.ts';

/**
 * The connected link against a scripted server: each test answers the calls
 * it expects and checks what the link sent and did.
 */

const base = (over: Partial<GameState> = {}): GameState => ({ ...createNewGame(), maxHp: 50, hp: 40, maxMana: 36, mana: 30, ...over });

function snap(state: GameState, rev: number, extra: Record<string, unknown> = {}) {
  return {
    state,
    rev,
    vitalsSource: 'imported',
    habiticaId: 'hero',
    habiticaPartyId: null,
    worldId: 'w',
    saveOrigin: 'fresh',
    pending: 0,
    verifiedXp: 0,
    flagged: false,
    ...extra,
  };
}

type Call = { method: string; path: string; body: any };
type Answer = { status?: number; body: unknown } | 'network';

/** Scripted server: `on(method path)` answers in order; everything is recorded. */
function fakeServer() {
  const calls: Call[] = [];
  const answers = new Map<string, Array<Answer | ((c: Call) => Answer)>>();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const call = { method, path: url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const list = answers.get(`${method} ${url}`) ?? [];
    const next = list.length > 1 ? list.shift()! : list[0];
    if (!next) throw new Error(`unexpected ${method} ${url}`);
    const a = typeof next === 'function' ? next(call) : next;
    if (a === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    api: createApiClient({ fetchImpl }),
    calls,
    on(key: string, ...a: Array<Answer | ((c: Call) => Answer)>) {
      answers.set(key, a);
    },
    sent(key: string) {
      const [method, path] = key.split(' ');
      return calls.filter((c) => c.method === method && c.path === path);
    },
  };
}

class FakeSession implements LinkSession {
  state: GameState;
  vitalsSource: VitalsSource = 'imported';
  importedProfile: HabiticaProfile | null = null;
  remoteBusy = false;
  relocated = 0;
  constructor(state: GameState) {
    this.state = state;
  }
  applyServer(next: GameState, prov: { vitalsSource: VitalsSource; importedProfile: HabiticaProfile | null }, relocate: boolean): void {
    this.state = next;
    this.vitalsSource = prov.vitalsSource;
    if (relocate) this.relocated += 1;
  }
}

function memoryStore() {
  const saved: ConnectedCache[] = [];
  const orphans = new Map<string, OrphanCopy>();
  const store: LinkStore & { saved: ConnectedCache[]; orphans: Map<string, OrphanCopy>; hang: boolean } = {
    saved,
    orphans,
    hang: false,
    save: async (r) => {
      if (store.hang) return new Promise<boolean>(() => {});
      saved.push(structuredClone(r));
      return true;
    },
    saveOrphan: async (o) => (orphans.set(o.clientId, structuredClone(o)), true),
    loadOrphans: async (id) => [...orphans.values()].filter((o) => o.habiticaId === id),
    deleteOrphan: async (_id, clientId) => orphans.delete(clientId),
  };
  return store;
}

/** Every link a test makes is stopped afterwards, even when an assertion fails. */
const live: Link[] = [];
test.afterEach(() => {
  for (const l of live.splice(0)) l.stop();
});

function makeLink(server: ReturnType<typeof fakeServer>, opts: { state?: GameState; rev?: number; status?: 'online' | 'offline'; dirty?: boolean; offlineProgress?: boolean; sent?: { rev: number; key: string }; clientId?: string; store?: ReturnType<typeof memoryStore> } = {}) {
  const events: Array<{ event: string; payload: any }> = [];
  const store = opts.store ?? memoryStore();
  const link = new Link({
    api: server.api,
    clientId: opts.clientId ?? 'tab-a',
    habiticaId: 'hero',
    name: 'Tansy',
    rev: opts.rev ?? 5,
    lease: 'L1',
    status: opts.status ?? 'online',
    dirty: opts.dirty,
    offlineProgress: opts.offlineProgress,
    sent: opts.sent,
    emit: (event, payload) => events.push({ event, payload }),
    store,
  });
  live.push(link);
  const session = new FakeSession(opts.state ?? base());
  link.attach(session);
  const toasts = () => events.filter((e) => e.event === EV.toast).map((e) => e.payload.text as string);
  return { link, session, events, store, toasts };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test('heartbeat on our own lease keeps local vitals and uploads them as current (finding 4)', async () => {
  const server = fakeServer();
  const { link, session } = makeLink(server, { rev: 5, state: base({ hp: 40 }) });
  session.state = base({ hp: 30, position: { x: 120, y: 80 } }); // damage + movement not uploaded yet
  // A login elsewhere settled credit: rev moved, nobody played.
  server.on('GET /api/state', { body: snap(base({ hp: 40, embers: 4 }), 6) });
  server.on('POST /api/play', { body: { ...snap(base({ hp: 40, embers: 4 }), 6), lease: 'L1' } });
  server.on('PUT /api/progress', (c) => ({ body: { ...snap({ ...base(), ...c.body.doc, maxHp: 50, maxMana: 36, embers: 4 }, 7), status: 'current' } }));
  await link.beat(true);
  await server.api.queue.idle();
  assert.equal(session.state.hp, 30, 'recent damage kept');
  assert.equal(session.state.embers, 4, 'server-owned balance adopted');
  const up = server.sent('PUT /api/progress');
  assert.equal(up.length, 1);
  assert.equal(up[0].body.baseRev, 6, 'a current write at the new rev');
  assert.equal(up[0].body.doc.hp, 30);
  assert.equal(link.rev, 7);
  link.stop();
});

test('heartbeat that gets the lease back after it lapsed takes the server state', async () => {
  const server = fakeServer();
  const { link, session } = makeLink(server, { rev: 5 });
  server.on('GET /api/state', { body: snap(base({ hp: 12 }), 9) });
  server.on('POST /api/play', { body: { ...snap(base({ hp: 12 }), 9), lease: 'L2' } });
  await link.beat(true);
  assert.equal(session.state.hp, 12);
  assert.equal(link.lease, 'L2');
  assert.equal(link.dirty, false);
  link.stop();
});

test('heartbeat that meets another live tab marks this one superseded and orphans its story (findings 3, 4)', async () => {
  const server = fakeServer();
  const store = memoryStore();
  const { link, session } = makeLink(server, { rev: 5, store });
  session.state = base({ quest: 'accepted', discoveries: ['old-well'] });
  server.on('GET /api/state', { body: snap(base(), 6) });
  server.on('POST /api/play', { status: 409, body: { error: { code: 'playing-elsewhere' } } });
  await link.beat(true);
  await settle();
  assert.equal(link.status, 'superseded');
  const orphan = store.orphans.get('tab-a');
  assert.ok(orphan, 'unsent story went to the orphan slot');
  if (!orphan) return;
  assert.equal(orphan.state.quest, 'accepted');
  assert.equal(orphan.rev, 5);
  // …and it no longer writes the account record.
  const before = store.saved.length;
  await link.persist();
  assert.equal(store.saved.length, before);
  link.stop();
});

test('the next lease holder merges orphans as stale writes and drops them (finding 3)', async () => {
  const server = fakeServer();
  const store = memoryStore();
  store.orphans.set('tab-old', { habiticaId: 'hero', clientId: 'tab-old', state: base({ quest: 'clue-found', hp: 3 }), rev: 4, savedAt: 0 });
  const { link, session } = makeLink(server, { status: 'offline', rev: 8, store, clientId: 'tab-new', state: base({ hp: 44 }) });
  server.on('POST /api/play', { body: { ...snap(base({ hp: 44 }), 8), lease: 'L9' } });
  server.on('PUT /api/progress', (c) => ({
    body: { ...snap(base({ hp: 44, quest: c.body.doc.quest }), 9), status: 'stale' },
  }));
  await link.reconnect(false);
  const up = server.sent('PUT /api/progress');
  assert.equal(up.length, 1);
  assert.equal(up[0].body.baseRev, 4, 'its own (older) base: a stale write');
  assert.equal(up[0].body.doc.quest, 'clue-found');
  assert.equal(session.state.quest, 'clue-found', 'story merged');
  assert.equal(session.state.hp, 44, 'vitals stay');
  assert.equal(store.orphans.size, 0);
  link.stop();
});

test('a reload whose last upload landed is not "you played somewhere else" (finding 5)', async () => {
  const server = fakeServer();
  const local = base({ hp: 25, position: { x: 50, y: 60 } });
  const { link, session, events } = makeLink(server, {
    status: 'offline',
    rev: 3,
    dirty: true,
    offlineProgress: false,
    sent: { rev: 3, key: docKey(local) },
    state: local,
  });
  server.on('POST /api/play', { body: { ...snap({ ...local, embers: 2 }, 4), lease: 'L1' } });
  await link.reconnect(false);
  await server.api.queue.idle();
  assert.equal(link.status, 'online');
  assert.equal(link.rev, 4);
  assert.equal(server.sent('PUT /api/progress').length, 0, 'nothing to resend');
  assert.equal(events.filter((e) => e.event === EV.linkNotice).length, 0);
  assert.equal(session.state.hp, 25);
  link.stop();
});

test('unsent changes that were not made offline merge without the notice (finding 5)', async () => {
  const server = fakeServer();
  const { link, events } = makeLink(server, { status: 'offline', rev: 3, dirty: true, offlineProgress: false, state: base({ hp: 25 }) });
  server.on('POST /api/play', { body: { ...snap(base({ hp: 40 }), 6), lease: 'L1' } });
  server.on('PUT /api/progress', { body: { ...snap(base({ hp: 40 }), 7), status: 'stale' } });
  await link.reconnect(false);
  assert.equal(server.sent('PUT /api/progress')[0].body.baseRev, 3);
  assert.equal(events.filter((e) => e.event === EV.linkNotice).length, 0);
  link.stop();
});

test('offline progress meeting newer progress shows the notice and keeps a recovery copy', async () => {
  const server = fakeServer();
  const { link, events } = makeLink(server, { status: 'offline', rev: 3, dirty: true, offlineProgress: true, state: base({ hp: 25, quest: 'accepted' }) });
  server.on('POST /api/play', { body: { ...snap(base({ hp: 40 }), 6), lease: 'L1' } });
  server.on('PUT /api/progress', { body: { ...snap(base({ hp: 40, quest: 'accepted' }), 7), status: 'stale' } });
  await link.reconnect(false);
  assert.equal(events.filter((e) => e.event === EV.linkNotice).length, 1);
  assert.equal(link.recovery?.state.quest, 'accepted');
  link.stop();
});

test('server trouble is not "offline": it says so and backs off (finding 7)', async () => {
  const server = fakeServer();
  const { link, session, events } = makeLink(server);
  session.state = base({ hp: 20 });
  server.on('PUT /api/progress', { status: 500, body: { error: { code: 'internal' } } });
  await link.persist();
  await server.api.queue.idle();
  await settle();
  assert.equal(link.status, 'offline');
  assert.equal(link.trouble, true);
  const last = events.filter((e) => e.event === EV.link).at(-1)!.payload;
  assert.equal(last.trouble, true);
  // A network loss reads as plain offline.
  const server2 = fakeServer();
  const second = makeLink(server2);
  second.session.state = base({ hp: 21 });
  server2.on('PUT /api/progress', 'network');
  await second.link.persist();
  await server2.api.queue.idle();
  await settle();
  assert.equal(second.link.status, 'offline');
  assert.equal(second.link.trouble, false);
  link.stop();
  second.link.stop();
});

test('a refused upload stays unsent (and cached as dirty) without resending in a loop (finding 1)', async () => {
  const server = fakeServer();
  const { link, session, store, toasts } = makeLink(server);
  session.state = base({ quest: 'accepted' });
  server.on('PUT /api/progress', { status: 400, body: { error: { code: 'invalid-progress' } } });
  await link.persist();
  await server.api.queue.idle();
  await settle();
  assert.equal(link.dirty, true);
  assert.equal(store.saved.at(-1)?.dirty, true);
  assert.ok(toasts().some((t) => t.includes('didn’t accept')));
  await link.persist();
  await server.api.queue.idle();
  assert.equal(server.sent('PUT /api/progress').length, 1, 'the same refused document is not resent');
  link.stop();
});

test('page hide starts the upload before the cache write (finding 6)', async () => {
  const server = fakeServer();
  const { link, session, store } = makeLink(server);
  session.state = base({ hp: 18 });
  store.hang = true; // the page dies before IndexedDB answers
  server.on('PUT /api/progress', (c) => ({ body: { ...snap({ ...base(), ...c.body.doc, maxHp: 50, maxMana: 36 }, 6), status: 'current' } }));
  void link.persist({ urgent: true });
  await settle();
  const up = server.sent('PUT /api/progress');
  assert.equal(up.length, 1);
  assert.equal(up[0].body.doc.hp, 18);
  link.stop();
});

test('page hide with the queue busy still sends the upload, out of turn (finding 6)', async () => {
  const server = fakeServer();
  const { link, session } = makeLink(server);
  let release!: () => void;
  void server.api.run(() => new Promise<void>((r) => (release = r)));
  session.state = base({ hp: 17 });
  server.on('PUT /api/progress', (c) => ({ body: { ...snap({ ...base(), ...c.body.doc, maxHp: 50, maxMana: 36 }, 6), status: 'current' } }));
  void link.persist({ urgent: true });
  await settle();
  assert.equal(server.sent('PUT /api/progress').length, 1);
  release();
  link.stop();
});

test('no gift toast for embers that arrive with a stale merge (finding 8)', async () => {
  const server = fakeServer();
  const { link, session, toasts } = makeLink(server, { state: base({ embers: 0 }) });
  session.state = base({ embers: 0, quest: 'accepted' });
  server.on('PUT /api/progress', { body: { ...snap(base({ embers: 7, quest: 'accepted' }), 9), status: 'stale' } });
  await link.persist();
  await server.api.queue.idle();
  assert.equal(session.state.embers, 7);
  assert.deepEqual(toasts(), []);
  link.stop();
});

test('quest gifts from a current upload still get their toast', async () => {
  const server = fakeServer();
  const { link, session, toasts } = makeLink(server, { state: base({ embers: 0 }) });
  session.state = base({ embers: 0, quest: 'guardian-defeated' });
  server.on('PUT /api/progress', (c) => ({ body: { ...snap({ ...base(), ...c.body.doc, maxHp: 50, maxMana: 36, embers: 2 }, 6), status: 'current' } }));
  await link.persist();
  await server.api.queue.idle();
  assert.deepEqual(toasts(), ['+2 embers — a little warmth from the road.']);
  link.stop();
});

test('a spend whose answer was lost is confirmed after the reconnect (finding 8)', async () => {
  const server = fakeServer();
  const { link, session, toasts } = makeLink(server, { state: base({ embers: 6 }) });
  server.on('POST /api/spend', 'network');
  assert.equal(await link.spend({ kind: 'road-lantern', id: 'road-1' }), 'offline');
  assert.equal(link.status, 'offline');
  // It did commit: the lantern is lit and the embers are spent.
  server.on('POST /api/play', { body: { ...snap(base({ embers: 3, flags: ['lit:road-1'] }), 6), lease: 'L1' } });
  await link.reconnect(false);
  assert.ok(session.state.flags.includes('lit:road-1'));
  assert.ok(toasts().includes('Your road lantern was lit after all.'));
  link.stop();
});

test('a lost spend that never landed stays quiet', async () => {
  const server = fakeServer();
  const { link, toasts } = makeLink(server, { state: base({ embers: 6 }) });
  server.on('POST /api/spend', 'network');
  await link.spend({ kind: 'rest' });
  server.on('POST /api/play', { body: { ...snap(base({ embers: 6 }), 5), lease: 'L1' } });
  await link.reconnect(false);
  assert.deepEqual(toasts(), []);
  link.stop();
});

test('sync and spend send the local progress as it is (a 0 HP hero sends hp 0)', async () => {
  const server = fakeServer();
  const { link, session } = makeLink(server, { state: base({ hp: 0, embers: 4, xpEmbers: 4 }) });
  server.on('POST /api/sync', { body: { ...snap(base({ hp: 10 }), 6), status: 'synced', vitalsCredit: { hp: 10, mana: 0 } } });
  const res = await link.sync({ id: 'hero' } as HabiticaProfile);
  assert.equal(res.ok, true);
  assert.equal(server.sent('POST /api/sync')[0].body.progress.hp, 0);
  assert.equal(session.state.hp, 10, 'healing comes from the answer');
  link.stop();
});
