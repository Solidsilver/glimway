import test from 'node:test';
import assert from 'node:assert/strict';
import {
  docKey,
  embersGained,
  isTrouble,
  retryDelay,
  spendLanded,
  uploadLanded,
  failureAction,
  hasProgress,
  isServerFlag,
  mergeServerState,
  reconnectNotice,
  reconnectPlan,
  toProgress,
} from '../src/lib/api/progress.ts';
import {
  clearCache,
  deleteOrphan,
  loadCache,
  loadLatestCache,
  loadOrphans,
  normalizeCache,
  saveCache,
  saveOrphan,
  type ConnectedCache,
} from '../src/lib/api/cache.ts';
import { installFakeIndexedDB, resetFakeIndexedDB } from './helpers/fake-indexeddb.ts';
import { createNewGame, type GameState } from '../src/lib/state.ts';

const base = (over: Partial<GameState> = {}): GameState => ({ ...createNewGame(), maxHp: 50, hp: 40, maxMana: 36, mana: 30, ...over });

test('toProgress: only client-writable fields, no economy flags or purchased items', () => {
  const s = base({
    flags: ['met-pip', 'lit:road-1', 'opened:ashwatch-chest', 'embers:welcome'],
    inventory: ['field-journal', 'ember-charm', 'warden-seal'],
    embers: 9,
    xpEmbers: 4,
    emberXp: 300,
    position: { x: 10.6, y: 20.2 },
  });
  const p = toProgress(s);
  assert.deepEqual(p.flags, ['met-pip']);
  assert.deepEqual(p.inventory, ['field-journal', 'warden-seal']);
  assert.deepEqual(p.position, { x: 11, y: 20 });
  for (const k of ['embers', 'xpEmbers', 'emberXp', 'maxHp', 'maxMana']) assert.equal(k in p, false, k);
  assert.equal(isServerFlag('lit:road-2'), true);
  assert.equal(isServerFlag('pip-nudge'), false);
});

test('merge: server-owned fields always come from the server', () => {
  const local = base({ embers: 99, xpEmbers: 50, flags: ['lit:road-3'], inventory: ['field-journal', 'ember-charm'] });
  const server = base({ embers: 4, xpEmbers: 1, flags: ['embers:welcome'], inventory: ['field-journal'], emberXp: 70 });
  for (const mode of ['keep-local', 'server'] as const) {
    const m = mergeServerState(local, server, mode);
    assert.equal(m.embers, 4);
    assert.equal(m.xpEmbers, 1);
    assert.equal(m.emberXp, 70);
    assert.deepEqual(m.flags, ['embers:welcome']);
    assert.deepEqual(m.inventory, ['field-journal']);
  }
});

test('merge: a current upload keeps local vitals, area and position (clamped to new maxima)', () => {
  const local = base({ hp: 48, mana: 12, area: 'woodland', position: { x: 5, y: 6 } });
  const server = base({ hp: 30, maxHp: 45, mana: 20, area: 'village' });
  const m = mergeServerState(local, server, 'keep-local');
  assert.equal(m.hp, 45);
  assert.equal(m.mana, 12);
  assert.equal(m.area, 'woodland');
  assert.deepEqual(m.position, { x: 5, y: 6 });
});

test('merge: a stale upload, sync or spend takes the server vitals, area and position', () => {
  const local = base({ hp: 2, mana: 1, area: 'ruin', position: { x: 5, y: 6 } });
  const server = base({ hp: 50, mana: 36, area: 'village', position: { x: 400, y: 300 } });
  const m = mergeServerState(local, server, 'server');
  assert.equal(m.hp, 50);
  assert.equal(m.area, 'village');
  assert.deepEqual(m.position, { x: 400, y: 300 });
});

test('merge: story never goes backwards in either mode', () => {
  const local = base({ quest: 'clue-found', discoveries: ['a', 'b'], defeatedEnemies: ['w1'], flags: ['story-x'], playSeconds: 900, inventory: ['field-journal', 'lantern-route-rubbing'] });
  const server = base({ quest: 'accepted', discoveries: ['c', 'a'], defeatedEnemies: [], flags: ['embers:welcome'], playSeconds: 120 });
  for (const mode of ['keep-local', 'server'] as const) {
    const m = mergeServerState(local, server, mode);
    assert.equal(m.quest, 'clue-found');
    assert.deepEqual(m.discoveries, ['c', 'a', 'b']);
    assert.deepEqual(m.defeatedEnemies, ['w1']);
    assert.deepEqual(m.flags, ['embers:welcome', 'story-x']);
    assert.equal(m.playSeconds, 900);
    assert.ok(m.inventory.includes('lantern-route-rubbing'));
  }
  // …and a server that is further along wins the stage.
  assert.equal(mergeServerState(base({ quest: 'new' }), base({ quest: 'complete' }), 'keep-local').quest, 'complete');
});

test('reconnect: equal revisions upload current; a moved-on server gets a stale upload with the original baseRev', () => {
  assert.deepEqual(reconnectPlan(7, 7), { mode: 'current', baseRev: 7 });
  assert.deepEqual(reconnectPlan(7, 9), { mode: 'stale', baseRev: 7 });
  // A server behind the copy (restored backup): merge story only.
  assert.deepEqual(reconnectPlan(9, 4), { mode: 'stale', baseRev: 0 });
  assert.deepEqual(reconnectPlan(3, 0), { mode: 'current', baseRev: 0 });
});

test('reconnect: the notice shows only when offline progress met newer server progress', () => {
  assert.equal(reconnectNotice({ mode: 'stale' }, true), true);
  assert.equal(reconnectNotice({ mode: 'stale' }, false), false);
  assert.equal(reconnectNotice({ mode: 'current' }, true), false);
});

test('failures: what each code means for connected play', () => {
  assert.equal(failureAction('network'), 'offline');
  assert.equal(failureAction('unavailable'), 'offline');
  assert.equal(failureAction('internal'), 'offline');
  assert.equal(failureAction('superseded'), 'superseded');
  assert.equal(failureAction('playing-elsewhere'), 'elsewhere');
  assert.equal(failureAction('stale-revision'), 'reload');
  assert.equal(failureAction('unauthorized'), 'signed-out');
  assert.equal(failureAction('short'), 'refused');
  assert.equal(failureAction('invalid-progress'), 'refused');
});

test('helpers: ember gains and "worth bringing" saves', () => {
  assert.equal(embersGained(base({ embers: 3 }), base({ embers: 5 })), 2);
  assert.equal(embersGained(base({ embers: 5 }), base({ embers: 3 })), 0);
  assert.equal(hasProgress(createNewGame()), false);
  assert.equal(hasProgress(base({ quest: 'accepted' })), true);
  assert.equal(hasProgress(base({ embers: 2 })), true);
});

test('cache: records are validated; anything unreadable counts as no cache, and no foreign fields survive', () => {
  const ok = normalizeCache({
    accountId: 'h',
    name: 'Tansy',
    state: base(),
    vitalsSource: 'imported',
    rev: 4,
    lease: 'L',
    clientId: 'c',
    dirty: true,
    offline: true,
    token: 'secret',
    recovery: { state: base({ quest: 'accepted' }), savedAt: 5 },
  });
  assert.ok(ok);
  if (!ok) return;
  assert.equal(ok.rev, 4);
  assert.equal(ok.recovery?.state.quest, 'accepted');
  assert.equal('token' in ok, false);
  assert.equal(normalizeCache({ accountId: 'h', clientId: 'c', rev: -1, state: base() }), null);
  assert.equal(normalizeCache({ accountId: 'h', clientId: 'c', rev: 1, state: { version: 2 } }), null);
  assert.equal(normalizeCache(null), null);
});

test('docKey: play time alone is not a change worth uploading', () => {
  assert.equal(docKey(base({ playSeconds: 10 })), docKey(base({ playSeconds: 500 })));
  assert.notEqual(docKey(base({ hp: 10 })), docKey(base({ hp: 11 })));
});

test('uploadLanded: one rev past the sent upload, holding exactly that document', () => {
  const sentState = base({ hp: 22, quest: 'accepted' });
  const sent = { rev: 4, key: docKey(sentState) };
  // The server merged it (server-owned fields differ, play time moved on).
  const server = base({ hp: 22, quest: 'accepted', embers: 5, flags: ['embers:welcome'], playSeconds: 99 });
  assert.equal(uploadLanded(sent, 5, server), true);
  assert.equal(uploadLanded(sent, 6, server), false, 'something else wrote too');
  assert.equal(uploadLanded(sent, 5, base({ hp: 30, quest: 'accepted' })), false, 'another device wrote instead');
  assert.equal(uploadLanded(undefined, 5, server), false);
});

test('retryDelay: steady for no network, backing off for server trouble', () => {
  assert.equal(retryDelay(1, false), 8000);
  assert.equal(retryDelay(9, false), 8000);
  assert.deepEqual([1, 2, 3, 4].map((n) => retryDelay(n, true)), [8000, 16000, 32000, 64000]);
  assert.equal(retryDelay(40, true), 300_000);
  assert.equal(isTrouble('internal'), true);
  assert.equal(isTrouble('network'), false);
});

test('spendLanded: outcomes for lanterns and the chest; for a rest, restored vitals and the balance', () => {
  const before = base({ embers: 6, flags: [] });
  assert.equal(spendLanded({ kind: 'road-lantern', id: 'road-1' }, before, base({ embers: 3, flags: ['lit:road-1'] })), true);
  assert.equal(spendLanded({ kind: 'road-lantern', id: 'road-1' }, before, base({ embers: 6, flags: ['lit:road-2'] })), false);
  assert.equal(spendLanded({ kind: 'chest' }, before, base({ embers: 1, flags: ['opened:ashwatch-chest'] })), true);
  const rested = { hp: 50, maxHp: 50, mana: 36, maxMana: 36 };
  assert.equal(spendLanded({ kind: 'rest' }, before, base({ embers: 4, ...rested })), true);
  assert.equal(spendLanded({ kind: 'rest' }, before, base({ embers: 6, ...rested })), false, 'nothing paid');
  // Re-review N3: another device spent embers, but this rest never landed.
  assert.equal(spendLanded({ kind: 'rest' }, before, base({ embers: 3, flags: ['lit:road-2'] })), false, 'vitals not restored');
  // Already full before: a full result proves nothing.
  assert.equal(spendLanded({ kind: 'rest' }, base({ embers: 6, ...rested }), base({ embers: 3, ...rested })), false);
  assert.equal(spendLanded({ kind: 'home-rest' }, before, base({ embers: 5, ...rested })), true);
});

const record = (id: string, over: Partial<ConnectedCache> = {}): ConnectedCache => ({
  accountId: id,
  name: id,
  state: base(),
  vitalsSource: 'imported',
  rev: 2,
  lease: 'L',
  clientId: 'c1',
  dirty: false,
  offline: false,
  offlineProgress: false,
  savedAt: 0,
  ...over,
});

test('cache: one record per account, so a second account never overwrites the first', async () => {
  installFakeIndexedDB();
  resetFakeIndexedDB();
  assert.equal(await saveCache(record('acct-1', { dirty: true, state: base({ quest: 'accepted' }) })), true);
  assert.equal(await saveCache(record('acct-2')), true);
  assert.equal((await loadCache('acct-1'))?.state.quest, 'accepted');
  assert.equal((await loadCache('acct-1'))?.dirty, true);
  assert.equal((await loadCache('acct-2'))?.accountId, 'acct-2');
  await clearCache('acct-2');
  assert.equal(await loadCache('acct-2'), null);
  assert.equal((await loadCache('acct-1'))?.dirty, true);
});

test('cache: offline start picks the latest account, skipping ones kept after a logout', async () => {
  installFakeIndexedDB();
  resetFakeIndexedDB();
  await saveCache(record('older'));
  await new Promise((r) => setTimeout(r, 5));
  await saveCache(record('newer', { loggedOut: true, dirty: true }));
  assert.equal((await loadLatestCache())?.accountId, 'older');
});

test('cache: orphan slots are per account and client, and can be dropped', async () => {
  installFakeIndexedDB();
  resetFakeIndexedDB();
  await saveOrphan({ accountId: 'a', clientId: 'tab-1', state: base({ quest: 'clue-found' }), rev: 3, savedAt: 0 });
  await saveOrphan({ accountId: 'a', clientId: 'tab-2', state: base(), rev: 3, savedAt: 0 });
  await saveOrphan({ accountId: 'b', clientId: 'tab-1', state: base(), rev: 1, savedAt: 0 });
  await saveCache(record('a'));
  const orphans = await loadOrphans('a');
  assert.deepEqual(orphans.map((o) => o.clientId).sort(), ['tab-1', 'tab-2']);
  assert.equal(orphans.find((o) => o.clientId === 'tab-1')?.state.quest, 'clue-found');
  await deleteOrphan('a', 'tab-1');
  assert.deepEqual((await loadOrphans('a')).map((o) => o.clientId), ['tab-2']);
  assert.equal((await loadOrphans('b')).length, 1);
});

test('cache: new flags round-trip (offline progress, sent upload, logged out)', () => {
  const r = normalizeCache({ ...record('x'), offlineProgress: true, sent: { rev: 3, key: 'k' }, loggedOut: true });
  assert.ok(r);
  if (!r) return;
  assert.equal(r.offlineProgress, true);
  assert.deepEqual(r.sent, { rev: 3, key: 'k' });
  assert.equal(r.loggedOut, true);
  assert.equal(normalizeCache({ ...record('x'), sent: { rev: 'x', key: 1 } })?.sent, undefined);
});
