import test from 'node:test';
import assert from 'node:assert/strict';
import { EV } from '../src/game/event-names.ts';
import { env, online, refuse, rig, S, toasts } from './helpers/link-rig.ts';

/** The wardrobe on the link (purse-and-wardrobe.md 4.4, 6.2): the choice predicted and queued offline, the read, Check for new gear. */

const withWardrobe = (version: number, chosen: Record<string, string>) => ({ ...S({ version }), wardrobe: { chosen } });

test('a wardrobe choice shows at once, queues offline, and goes when the world is back', async (t) => {
  const r = await rig(t);
  r.link.wardrobeChoice({ head: 'head_armoire_admiralsBicorne', shield: 'none' });
  assert.deepEqual(r.link.wardrobe, { head: 'head_armoire_admiralsBicorne', shield: 'none' }, 'predicted before any answer');
  assert.ok(r.events.some(([e]) => e === EV.wardrobe), 'the game hears of it (the hero is redrawn)');
  assert.equal(r.link.outbox.length, 1, 'kept offline');
  const answered = withWardrobe(2, { head: 'head_armoire_admiralsBicorne', shield: 'none' });
  r.server.on('POST /api/wardrobe', env(answered, { wardrobe: { wardrobe: answered.wardrobe } }));
  await online(r);
  await r.link.flush();
  const [sent] = r.server.sent('POST /api/wardrobe');
  assert.deepEqual(sent.body.chosen, { head: 'head_armoire_admiralsBicorne', shield: 'none' });
  assert.ok(sent.body.op?.key, 'keyed');
  assert.equal(r.link.outbox.length, 0);
  assert.deepEqual(r.link.wardrobe, { head: 'head_armoire_admiralsBicorne', shield: 'none' }, 'the answer keeps it');
});

test('the latest of two unanswered choices wins; Wear Habitica\'s look is the empty choice', async (t) => {
  const r = await rig(t, { state: withWardrobe(1, { head: 'head_warrior_1' }) });
  assert.deepEqual(r.link.wardrobe, { head: 'head_warrior_1' });
  r.link.wardrobeChoice({ armor: 'armor_warrior_1' });
  r.link.wardrobeChoice({});
  assert.deepEqual(r.link.wardrobe, {});
  assert.equal(r.link.outbox.length, 2);
});

test('a refused wardrobe choice rolls back and says so', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/wardrobe', refuse('gear-not-owned', S({ version: 2 })));
  r.link.wardrobeChoice({ head: 'head_special_0' });
  assert.deepEqual(r.link.wardrobe, { head: 'head_special_0' });
  await r.link.flush();
  assert.deepEqual(r.link.wardrobe, {}, 'back to Habitica\'s look');
  assert.ok(toasts(r).some((x) => x.includes('wardrobe')));
});

test('the picker\'s read: owned keys and when they were checked; a read needs a connection', async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.link.readWardrobe(), { ok: false, code: 'offline' });
  await online(r);
  r.server.on('GET /api/wardrobe', { body: { state: S(), result: { owned: ['head_warrior_1'], wardrobe: { chosen: {} }, checkedAt: 1700000000 } } });
  assert.deepEqual(await r.link.readWardrobe(), { ok: true, value: { owned: ['head_warrior_1'], checkedAt: 1700000000 } });
  r.server.on('GET /api/wardrobe', { body: { state: S(), result: { owned: [], wardrobe: { chosen: {} }, checkedAt: null } } });
  assert.deepEqual(await r.link.readWardrobe(), { ok: true, value: { owned: [], checkedAt: null } }, 'before the first check');
  // One read shape (the domain reads' { state, result }): a bare read, or one
  // under an Envelope's oneof, is refused rather than read as empty.
  r.server.on('GET /api/wardrobe', { body: { owned: [], wardrobe: { chosen: {} }, checkedAt: null } });
  assert.deepEqual(await r.link.readWardrobe(), { ok: false, code: 'bad-response' }, 'a bare read');
  r.server.on('GET /api/wardrobe', { body: { state: S(), wardrobeRead: { owned: [], wardrobe: { chosen: {} }, checkedAt: null } } });
  assert.deepEqual(await r.link.readWardrobe(), { ok: false, code: 'bad-response' }, 'an envelope case');
});

test('Check for new gear carries the token in that one request, unkeyed, and never keeps it', async (t) => {
  const r = await rig(t);
  const TOKEN = 'tok-0123456789-never-kept';
  assert.deepEqual(await r.link.checkGear(TOKEN), { ok: false, code: 'offline' }, 'needs a connection: nothing queued');
  assert.equal(r.link.outbox.length, 0);
  await online(r);
  r.server.on('POST /api/wardrobe/check', env(S({ version: 2 }), { wardrobeCheck: { owned: ['head_warrior_1', 'armor_warrior_1'], checkedAt: 1700000100, newPieces: 2 } }));
  const res = await r.link.checkGear(TOKEN);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.value.newPieces, 2);
  assert.deepEqual(res.value.owned, ['head_warrior_1', 'armor_warrior_1']);
  const [sent] = r.server.sent('POST /api/wardrobe/check');
  assert.equal(sent.body.token, TOKEN);
  assert.equal(sent.body.lease, 'L1');
  assert.equal(sent.body.op, undefined, 'no operation header: not keyed');
  assert.equal(r.link.outbox.length, 0, 'never in the outbox');
  await r.link.flush();
  assert.ok(!deep([...r.store.records.values()]).includes(TOKEN), 'not in the stored outbox record');
  assert.ok(!deep(r.events).includes(TOKEN), 'not in any bus payload');
  assert.ok(!deep(r.link).includes(TOKEN), 'not kept anywhere on the link, however deep');
  assert.ok(!deep(r.session).includes(TOKEN), 'not kept on the session');
  assert.ok(deep({ a: [{ b: new Map([['c', TOKEN]]) }] }).includes(TOKEN), 'the sweep itself sees nested values');
});

/** Every value reachable from `root`, as one string: nested objects, Maps, Sets, cycles and bigints included. */
function deep(root: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(root, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return undefined;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return undefined;
      seen.add(v);
      if (v instanceof Map) return [...v.entries()];
      if (v instanceof Set) return [...v.values()];
    }
    return v;
  });
}

test('a refused check says why and changes nothing', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/wardrobe/check', refuse('habitica-auth', undefined, 401));
  assert.deepEqual(await r.link.checkGear('bad'), { ok: false, code: 'habitica-auth' });
  r.server.on('POST /api/wardrobe/check', refuse('needs-habitica'));
  assert.deepEqual(await r.link.checkGear('t'), { ok: false, code: 'needs-habitica' });
});
