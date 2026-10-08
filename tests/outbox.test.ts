import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { emptyRecord, expired, holdLock, idbOutboxStore, normalizeRecord, OUTBOX_LIFETIME_MS, type LockLike, type OutboxEntry } from '../src/lib/api/outbox.ts';
import { adoptable, areaOfPlace, fallRecovery, gameStateOf, isClientMark, placeArea, predict, predictedView, whereOf } from '../src/lib/api/predict.ts';
import { PlayerStateSchema } from '../src/lib/gen/glimway/v1/state_pb.js';
import { parseSnapshot } from '../src/lib/api/parse.ts';
import { createNewGame } from '../src/lib/state.ts';
import { installFakeIndexedDB, resetFakeIndexedDB } from './helpers/fake-indexeddb.ts';

/** The outbox's storage and the predictor's rules (design server-first 2.4). */

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { name: string; case: string; json: JsonValue }[];
const BASE = fixtures.find((f) => f.name === 'glimway.v1.PlayerState' && f.case === 'valid')!.json as Record<string, any>;
const state = (edit: (s: Record<string, any>) => void = () => undefined) => {
  const s = structuredClone(BASE);
  edit(s);
  return fromJson(PlayerStateSchema, s as JsonValue);
};

const entry = (id: number, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id,
  kind: 'mark',
  path: '/api/story/mark',
  key: `k${id}`,
  body: JSON.stringify({ op: { lease: '', key: `k${id}` }, mark: `seen:${id}`, where: { area: 'village', x: 1, y: 1 } }),
  contract: 3,
  createdAt: 1000,
  sent: false,
  barrier: false,
  offline: true,
  ...over,
});

// ---------------------------------------------------------------- the record

test('records are validated: bad entries drop one by one, order and the id allocator hold', () => {
  const r = normalizeRecord({
    ...emptyRecord('acct', 'dev'),
    nextId: 2,
    entries: [entry(5), { ...entry(3), kind: 'progress' }, { ...entry(4), body: '{not json' }, { ...entry(2), path: 'https://elsewhere/api' }, entry(1), 'junk'],
    lease: '',
    reports: { client: 'c', generation: 'g', seq: 2, next: { place: { area: 'village', x: 1, y: 2 }, hp: 5, mana: -3, casts: 2.7, basis: 4, boundary: null, changed: true }, captured: null },
  })!;
  assert.deepEqual(r.entries.map((e) => e.id), [1, 5]);
  assert.equal(r.nextId, 6, 'never reuses an id still in the outbox');
  assert.equal(r.lease, null);
  assert.deepEqual(r.reports?.next, { place: { area: 'village', x: 1, y: 2 }, hp: 5, mana: 0, casts: 2, basis: 4, boundary: null, changed: true });
  assert.equal(normalizeRecord({ account: '', device: 'dev' }), null);
  assert.equal(normalizeRecord('nope'), null);
});

test('expiry: six days, or another contract', () => {
  const now = 10 * OUTBOX_LIFETIME_MS;
  const old = entry(1, { createdAt: now - OUTBOX_LIFETIME_MS - 1 });
  const edge = entry(2, { createdAt: now - OUTBOX_LIFETIME_MS });
  const other = entry(3, { createdAt: now, contract: 2 });
  assert.deepEqual(expired([old, edge, other], now, 3), [old, other]);
});

test('IndexedDB: one record per (account, device); offline start skips records kept after a logout', async () => {
  installFakeIndexedDB();
  resetFakeIndexedDB();
  const store = idbOutboxStore();
  const server = { version: 1 } as JsonValue;
  assert.equal(await store.save({ ...emptyRecord('a', 'dev'), server, entries: [entry(1)], nextId: 2 }), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await store.save({ ...emptyRecord('b', 'dev'), server }), true);
  assert.equal(await store.save({ ...emptyRecord('a', 'other-device'), server }), true);
  assert.deepEqual((await store.load('a', 'dev'))?.entries.map((e) => e.key), ['k1']);
  assert.equal((await store.load('a', 'other-device'))?.entries.length, 0, 'another device’s outbox is its own');
  assert.equal((await store.latest('dev'))?.account, 'b');
  await store.save({ ...(await store.load('b', 'dev'))!, loggedOut: true });
  assert.equal((await store.latest('dev'))?.account, 'a');
  await store.clear('a', 'dev');
  assert.equal(await store.load('a', 'dev'), null);
  assert.ok(await store.load('b', 'dev'), 'clearing one account leaves the other alone');
  assert.equal(store.durable, true);
});

// ---------------------------------------------------------------- the lock

test('the outbox lock: only if free, unless the player takes over; without Web Locks every tab holds it', async () => {
  const waiting = new Map<string, (e: Error) => void>();
  const locks: LockLike = {
    request(name, options, callback) {
      if (waiting.has(name) && !options.steal) return Promise.resolve(callback(null));
      waiting.get(name)?.(new Error('AbortError'));
      return new Promise((resolve, reject) => {
        waiting.set(name, reject);
        void Promise.resolve(callback({})).then(resolve);
      });
    },
  };
  const first = await holdLock(locks, 'glimway-outbox:a:dev');
  assert.ok(first);
  if (!first) return;
  assert.equal(await holdLock(locks, 'glimway-outbox:a:dev'), null);
  let lost = false;
  void first.lost.then(() => (lost = true));
  const second = await holdLock(locks, 'glimway-outbox:a:dev', true);
  assert.ok(second);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lost, true, 'the first holder hears it was taken');
  assert.ok(await holdLock(null, 'x'));
});

// ---------------------------------------------------------------- prediction

test('the game state is the server state: marks are the single source of discoveries and defeats', () => {
  const s = gameStateOf(
    state((j) => {
      j.story.marks = ['seen:gate', 'found:old-route-marker', 'defeated:stone-warden', 'paper:eleven-days'];
      j.story.quests = { 'lantern-road': 'clue-found' };
      j.place = { area: 'wilds:outer-1', x: 10, y: 20, placeSetVersion: 0 };
      j.embers = { balance: 9, xpEarned: 4, pending: 0, xpMark: 300, verifiedXp: 0 };
    }),
  );
  assert.deepEqual(s.flags, ['seen:gate', 'paper:eleven-days']);
  assert.deepEqual(s.discoveries, ['old-route-marker']);
  assert.deepEqual(s.defeatedEnemies, ['stone-warden']);
  assert.equal(s.quest, 'clue-found');
  assert.equal(s.area, 'wilds');
  assert.equal(s.wildsRegion, 'outer-1');
  assert.deepEqual([s.embers, s.xpEmbers, s.emberXp], [9, 4, 300]);
});

test('a Wilds place loads: wilds:<region> becomes the Wilds area plus its region marker', () => {
  const at = (area: string) => gameStateOf(state((j) => (j.place = { area, x: 424, y: 744, placeSetVersion: 0 })));
  const inner = at('wilds:inner-1');
  assert.deepEqual([inner.area, inner.wildsRegion, inner.position], ['wilds', undefined, { x: 424, y: 744 }]);
  const outer = at('wilds:outer-1');
  assert.deepEqual([outer.area, outer.wildsRegion], ['wilds', 'outer-1']);
  // Through the response parser too (a reload's state read).
  const snap = parseSnapshot({ state: { ...structuredClone(BASE), place: { area: 'wilds:outer-1', x: 424, y: 744, placeSetVersion: 0 } } });
  assert.deepEqual([snap.state.area, snap.state.wildsRegion], ['wilds', 'outer-1']);
  // A place this build can't draw never fails the load.
  const lost = at('somewhere-new');
  assert.deepEqual([lost.area, lost.position], ['village', { x: 400, y: 300 }]);
});

test('places: Wilds regions in where.area, curated areas as they are', () => {
  assert.deepEqual(areaOfPlace('wilds:inner-1'), { area: 'wilds' });
  assert.deepEqual(areaOfPlace('home:12'), { area: 'home:12' });
  assert.equal(placeArea({ area: 'wilds' }), 'wilds:inner-1');
  assert.equal(placeArea({ area: 'wilds', wildsRegion: 'outer-1' }), 'wilds:outer-1');
  assert.deepEqual(whereOf({ area: 'commons', position: { x: 10.6, y: 3.2 } }), { area: 'commons', x: 11, y: 3 });
});

test('adoption by version: equal or higher only', () => {
  const v = (n: number) => state((j) => (j.version = n));
  assert.equal(adoptable(null, v(1)), true);
  assert.equal(adoptable(v(4), v(3)), false);
  assert.equal(adoptable(v(4), v(4)), true);
  assert.equal(adoptable(v(4), v(5)), true);
});

test('client marks only: rewards never read a client namespace', () => {
  for (const m of ['seen:x', 'met:mara', 'heard:pip:a', 'guide:x', 'nudge:pip-gate', 'unmoored:felt', 'found:x', 'defeated:x', 'home:met-silas', 'home:arrived']) assert.ok(isClientMark(m), m);
  for (const m of ['paper:x', 'echo:nan', 'wilds:turned', 'witness:a:b:c', 'donated:x@1', 'lit:a', 'opened:b', 'embers:welcome', 'warden-sliver:found', 'returned:x', 'seen:', 'home:other']) assert.ok(!isClientMark(m), m);
});

test('predictions: quest steps from the shared table, marks and papers added once, a step that does not fit changes nothing', () => {
  const s = gameStateOf(state());
  const ctx = { profile: null };
  const clue = predict(predict(s, { kind: 'quest-step', quest: 'lantern-road', to: 'accepted' }, ctx), { kind: 'quest-step', quest: 'lantern-road', to: 'clue-found' }, ctx);
  assert.equal(clue.quest, 'clue-found');
  assert.ok(clue.inventory.includes('lantern-route-rubbing'));
  assert.equal(predict(s, { kind: 'quest-step', quest: 'lantern-road', to: 'complete' }, ctx), s, 'not the next step: the answer decides');
  const marked = predict(predict(s, { kind: 'mark', mark: 'seen:a' }, ctx), { kind: 'mark', mark: 'seen:a' }, ctx);
  assert.deepEqual(marked.flags, ['seen:a']);
  assert.deepEqual(predict(s, { kind: 'take-paper', paper: 'eleven-days' }, ctx).flags, ['paper:eleven-days']);
  const view = predictedView(state(), [{ kind: 'mark', mark: 'found:x' }, { kind: 'none' }], ctx);
  assert.deepEqual(view.discoveries, ['x']);
});

test('fall recovery: a quarter of max HP and half of max mana, rounded up, never above the baseline; a 0-HP baseline stays 0', () => {
  const g = { ...createNewGame(), maxHp: 50, maxMana: 30 };
  assert.deepEqual(fallRecovery(g, { hp: 40, mp: 30 } as never), { hp: 13, mana: 15 });
  assert.deepEqual(fallRecovery(g, { hp: 5, mp: 2 } as never), { hp: 5, mana: 2 });
  assert.deepEqual(fallRecovery(g, { hp: 0, mp: 0 } as never), { hp: 0, mana: 0 });
  const fallen = predict({ ...g, area: 'ruin', hp: 0 }, { kind: 'fall' }, { profile: null });
  assert.equal(fallen.area, 'village');
  assert.equal(fallen.hp, 13);
});
