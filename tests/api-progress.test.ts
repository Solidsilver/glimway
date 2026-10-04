import test from 'node:test';
import assert from 'node:assert/strict';
import {
  embersGained,
  failureAction,
  hasProgress,
  isServerFlag,
  mergeServerState,
  reconnectNotice,
  reconnectPlan,
  toProgress,
} from '../src/lib/api/progress.ts';
import { normalizeCache } from '../src/lib/api/cache.ts';
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
    habiticaId: 'h',
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
  assert.equal(normalizeCache({ habiticaId: 'h', clientId: 'c', rev: -1, state: base() }), null);
  assert.equal(normalizeCache({ habiticaId: 'h', clientId: 'c', rev: 1, state: { version: 2 } }), null);
  assert.equal(normalizeCache(null), null);
});
