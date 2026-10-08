import test from 'node:test';
import assert from 'node:assert/strict';
import { Link, type LinkSession } from '../src/game/link.ts';
import { EV } from '../src/game/event-names.ts';
import { createApiClient } from '../src/lib/api/client.ts';
import { idbLinkStore, loadCache, normalizeCache } from '../src/lib/api/cache.ts';
import { installFakeIndexedDB, resetFakeIndexedDB } from './helpers/fake-indexeddb.ts';
import { createNewGame, type GameState } from '../src/lib/state.ts';
import type { HabiticaProfile, VitalsSource } from '../src/lib/habitica/types.ts';

/**
 * Lost mutation answers, end to end through the production cache (phase 5
 * review, findings 1 and 2): the exact request survives a reload, unreadable
 * answers count as unknown, and only an authoritative answer settles it.
 */

installFakeIndexedDB();

const base = (over: Partial<GameState> = {}): GameState => ({ ...createNewGame(), maxHp: 50, hp: 40, maxMana: 36, mana: 30, ...over });
const snap = (state: GameState, rev: number, extra: Record<string, unknown> = {}) => ({
  state, version: rev, vitalsSource: 'imported', accountId: 'hero', habiticaPartyId: null, worldId: 'w', saveOrigin: 'fresh', pending: 0, verifiedXp: 0, flagged: false, ...extra,
});
const home = (items: unknown[] = []) => ({ id: 'h1', gate: 0, worldId: 'w', tier: 0, members: [{ id: 'hero', displayName: 'Tansy' }], member: true, desolate: false, vacantSince: null, landSeed: 7, cleared: [], postsBought: 0, nextPost: {}, indoor: null, items });
const bought = (rev: number) => ({ body: { ...snap(base({ embers: 8 }), rev), result: { home: home([{ id: 's1', itemDef: 'wooden-stool', scene: null, x: null, y: null, rotation: null }]), materials: {}, itemId: 's1' } } });

type Answer = { status?: number; body?: unknown; raw?: string } | 'network';
function server() {
  const calls: { method: string; path: string; body: any }[] = [];
  const answers = new Map<string, Answer[]>();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, path: url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const list = answers.get(`${method} ${url}`) ?? [];
    const a = list.length > 1 ? list.shift()! : list[0];
    if (!a) throw new Error(`unexpected ${method} ${url}`);
    if (a === 'network') throw new TypeError('Failed to fetch');
    return new Response(a.raw ?? JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    api: createApiClient({ fetchImpl }),
    calls,
    on: (key: string, ...a: Answer[]) => answers.set(key, a),
    sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
  };
}

class Session implements LinkSession {
  vitalsSource: VitalsSource = 'imported';
  importedProfile: HabiticaProfile | null = null;
  remoteBusy = false;
  state: GameState;
  constructor(state: GameState) {
    this.state = state;
  }
  applyServer(next: GameState): void {
    this.state = next;
  }
}

const live: Link[] = [];
test.afterEach(() => {
  for (const l of live.splice(0)) l.stop();
  resetFakeIndexedDB();
});

function link(s: ReturnType<typeof server>, init: Partial<ConstructorParameters<typeof Link>[0]> = {}) {
  const events: { event: string; payload: any }[] = [];
  const l = new Link({ api: s.api, clientId: 'tab-a', accountId: 'hero', name: 'Tansy', rev: 5, lease: 'L1', status: 'online', emit: (event, payload) => events.push({ event, payload }), store: idbLinkStore, ...init });
  live.push(l);
  l.attach(new Session(base({ embers: 10 })));
  return { l, events };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a lost purchase survives a reload through the real cache, and the next page replays it exactly', async () => {
  const s = server();
  s.on('POST /api/homestead/buy', 'network');
  const { l } = link(s);
  assert.deepEqual(await l.homeAction({ op: 'buy', itemDef: 'wooden-stool' }), { ok: false, code: 'pending' });
  await settle();
  const lost = s.sent('POST /api/homestead/buy')[0].body;
  const cached = await loadCache('hero');
  assert.ok(cached?.unresolved, 'the cache keeps the unresolved request');
  assert.equal(cached!.unresolved!.body.key, lost.key);
  l.stop();

  // A new page: a fresh Link from the cached record (even when the server's snapshot wins).
  const s2 = server();
  s2.on('POST /api/play', { body: { ...snap(base({ embers: 8 }), 6), lease: 'L2' } });
  s2.on('POST /api/homestead/buy', bought(6));
  const { l: l2, events } = link(s2, { status: 'offline', lease: null, unresolved: cached!.unresolved as never });
  await l2.reconnect(false);
  const replay = s2.sent('POST /api/homestead/buy')[0].body;
  assert.equal(replay.key, lost.key);
  assert.equal(replay.baseRev, lost.baseRev);
  assert.deepEqual(replay.progress, lost.progress);
  assert.equal(replay.lease, 'L2');
  assert.equal(l2.pendingOperation, null);
  assert.equal(events.find((e) => e.event === EV.mutationResolved)?.payload.outcome, 'landed');
});

test('the cache rejects a malformed unresolved record and keeps a valid one', () => {
  const rec = { accountId: 'hero', clientId: 'c', rev: 1, state: base(), unresolved: { op: { kind: 'craft', fields: { recipeId: 'craft-wooden-peg', qty: 1 } }, body: { key: 'k', baseRev: 1, recipeId: 'craft-wooden-peg', qty: 1 }, at: 5 } };
  assert.deepEqual(normalizeCache(rec)?.unresolved, rec.unresolved);
  assert.equal(normalizeCache({ ...rec, unresolved: { op: { kind: 'rob-a-bank' }, body: { key: 'k', baseRev: 1 }, at: 1 } })?.unresolved, undefined);
  assert.equal(normalizeCache({ ...rec, unresolved: { op: { kind: 'craft', fields: {} }, body: { baseRev: 1 }, at: 1 } })?.unresolved, undefined);
});

test('a 200 with an unreadable body is replayed at once: the same request hands back its answer', async () => {
  const s = server();
  s.on('POST /api/homestead/buy', { raw: '{"state":' }, bought(6));
  const { l } = link(s);
  const r = await l.homeAction({ op: 'buy', itemDef: 'wooden-stool' });
  assert.equal(r.ok, true, 'the purchase completes without a second one');
  const sent = s.sent('POST /api/homestead/buy');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.key, sent[0].body.key);
  assert.equal(sent[1].body.baseRev, sent[0].body.baseRev);
  assert.equal(l.pendingOperation, null);
  assert.equal(l.status, 'online', 'an unreadable answer is not an outage');
});

test('still unreadable on the immediate replay: pending; asking again resolves it instead of buying twice', async () => {
  const s = server();
  s.on('POST /api/homestead/buy', { raw: '{"state":' }, { raw: 'oops' }, bought(6));
  const { l } = link(s);
  assert.deepEqual(await l.homeAction({ op: 'buy', itemDef: 'wooden-stool' }), { ok: false, code: 'pending' });
  assert.ok(l.pendingOperation);
  assert.deepEqual(await l.homeAction({ op: 'buy', itemDef: 'wooden-stool' }), { ok: false, code: 'resolved' });
  const sent = s.sent('POST /api/homestead/buy');
  assert.equal(sent.length, 3);
  assert.ok(sent.every((c) => c.body.key === sent[0].body.key), 'one key throughout');
});

test('a proxy failure (no Glimway answer) is unknown too', async () => {
  const s = server();
  s.on('POST /api/craft', { status: 502, raw: '<html>bad gateway</html>' });
  const { l } = link(s);
  const r = await l.mutate({ kind: 'craft', fields: { recipeId: 'craft-wooden-peg', qty: 1 } });
  assert.deepEqual(r, { ok: false, code: 'pending' });
  assert.equal(l.pendingOperation?.op.kind, 'craft');
});

test('a takeover during replay says nothing about the purchase: it stays pending', async () => {
  const s = server();
  s.on('POST /api/homestead/buy', 'network', { status: 409, body: { error: { code: 'superseded' } } });
  const { l, events } = link(s);
  await l.homeAction({ op: 'buy', itemDef: 'wooden-stool' });
  (l as unknown as { status: string }).status = 'online';
  assert.equal(await l.resolveUnresolved(), 'unknown');
  assert.ok(l.pendingOperation, 'kept: superseded is checked before the idempotency cache');
  assert.equal(events.filter((e) => e.event === EV.mutationResolved).length, 0);
});

test('an authoritative refusal from the gameplay step settles it as never committed', async () => {
  const s = server();
  s.on('POST /api/homestead/buy', 'network', { status: 409, body: { error: { code: 'insufficient-embers' } } });
  const { l, events } = link(s);
  await l.homeAction({ op: 'buy', itemDef: 'wooden-stool' });
  (l as unknown as { status: string }).status = 'online';
  assert.equal(await l.resolveUnresolved(), 'refused');
  assert.equal(l.pendingOperation, null);
  assert.equal(events.find((e) => e.event === EV.mutationResolved)?.payload.outcome, 'refused');
});
