import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EV } from '../src/game/event-names.ts';
import { env, online, refuse, rig, S, tick, toasts } from './helpers/link-rig.ts';

/** Companions and the stable on the link (crafts.md 6.2): prediction, offline queueing, answers. */

const fixtures = new Map(
  (JSON.parse(readFileSync(new URL('../content/vectors/crafts-fixtures.json', import.meta.url), 'utf8')) as { messages: { name: string; json: any }[] }).messages.map((m) => [m.name, m.json]),
);
const withCompanions = (version: number, c: Record<string, unknown>) => ({ ...S({ version }), companions: { followPet: '', yardPets: [], mountOut: '', mountHome: '', ...c } });

test('a companions choice shows at once, queues offline, and goes when the world is back', async (t) => {
  const r = await rig(t);
  r.link.companionsChoice('Fox-Golden', ['Cat-Siamese']);
  assert.equal(r.link.companions.followPet, 'Fox-Golden', 'predicted before any answer');
  assert.deepEqual(r.link.companions.yardPets, ['Cat-Siamese']);
  assert.ok(r.events.some(([e]) => e === EV.companions), 'the game hears of it');
  assert.equal(r.link.outbox.length, 1, 'kept offline');
  const answered = withCompanions(2, { followPet: 'Fox-Golden', yardPets: ['Cat-Siamese'] });
  r.server.on('POST /api/companions', env(answered, { companions: { companions: answered.companions } }));
  await online(r);
  await r.link.flush();
  const [sent] = r.server.sent('POST /api/companions');
  assert.equal(sent.body.followPet, 'Fox-Golden');
  assert.deepEqual(sent.body.yardPets, ['Cat-Siamese']);
  assert.equal(r.link.outbox.length, 0);
  assert.equal(r.link.companions.followPet, 'Fox-Golden', 'the answer keeps it');
});

test('a refused companions choice rolls back and says so', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/companions', refuse('companion-not-owned', S({ version: 2 })));
  r.link.companionsChoice('Dragon-Red', []);
  assert.equal(r.link.companions.followPet, 'Dragon-Red');
  await r.link.flush();
  assert.equal(r.link.companions.followPet, '', 'back to Habitica’s current pet');
  assert.ok(toasts(r).some((x) => x.includes('companions')));
});

test('saddle up: the mount shows as out until the answer; a refusal takes it back', async (t) => {
  const r = await rig(t);
  await online(r);
  const release = r.server.hold('POST /api/stable/out');
  r.server.on('POST /api/stable/out', refuse('too-far-away', S({ version: 2 })));
  const done = r.link.mountOut('home:12', 1, 'Wolf-Shade');
  await tick();
  assert.equal(r.link.companions.mountOut, 'Wolf-Shade');
  assert.equal(r.link.companions.mountHome, 'home:12');
  release();
  const res = await done;
  assert.deepEqual(res, { ok: false, code: 'too-far-away' });
  assert.equal(r.link.companions.mountOut, '');
  const [sent] = r.server.sent('POST /api/stable/out');
  assert.equal(sent.body.homeId, 'home:12');
  assert.equal(sent.body.stall, 1);
  assert.ok(sent.body.where);
});

test('saddle up answered: the state carries the mount that is out', async (t) => {
  const r = await rig(t);
  await online(r);
  const answered = withCompanions(2, { mountOut: 'Wolf-Shade', mountHome: 'home:12' });
  r.server.on('POST /api/stable/out', env(answered, { mountOut: { companions: answered.companions } }));
  assert.deepEqual(await r.link.mountOut('home:12', 1, 'Wolf-Shade'), { ok: true });
  assert.equal(r.link.companions.mountOut, 'Wolf-Shade');
});

test('saddle up answered: the mount never reads as back in its stall on the way', async (t) => {
  const r = await rig(t);
  await online(r);
  // What the game reads each time it hears the companions changed.
  const seen: string[] = [];
  const push = r.events.push.bind(r.events);
  r.events.push = (...items) => {
    for (const [e] of items) if (e === EV.companions) seen.push(r.link.companions.mountOut);
    return push(...items);
  };
  const answered = withCompanions(2, { mountOut: 'Wolf-Shade', mountHome: 'home:12' });
  r.server.on('POST /api/stable/out', env(answered, { mountOut: { companions: answered.companions } }));
  assert.deepEqual(await r.link.mountOut('home:12', 1, 'Wolf-Shade'), { ok: true });
  assert.ok(seen.length > 0, 'the game heard it come out');
  assert.deepEqual(seen.filter((m) => m !== 'Wolf-Shade'), [], 'never back in its stall in between');
  assert.equal(r.link.companions.mountOut, 'Wolf-Shade');
});

test('saddle up holds the world from the press, not from the send (an M right after E waits for the answer)', async (t) => {
  const r = await rig(t);
  await online(r);
  const release = r.server.hold('POST /api/stable/out');
  const answered = withCompanions(2, { mountOut: 'Wolf-Shade', mountHome: 'home:12' });
  r.server.on('POST /api/stable/out', env(answered, { mountOut: { companions: answered.companions } }));
  const done = r.link.mountOut('home:12', 1, 'Wolf-Shade');
  // Before the outbox write lands: already busy, so the world isn't live.
  assert.equal(r.session.remoteBusy, true);
  assert.deepEqual(await r.link.stableExtend('home:12'), { ok: false, code: 'busy' }, 'a second connected operation waits its turn');
  release();
  assert.deepEqual(await done, { ok: true });
  assert.equal(r.session.remoteBusy, false);
  assert.equal(r.link.companions.mountOut, 'Wolf-Shade');
});

test('Go home queues offline and clears the mount at once', async (t) => {
  const r = await rig(t, { state: withCompanions(1, { mountOut: 'Wolf-Shade', mountHome: 'home:12' }) });
  assert.equal(r.link.companions.mountOut, 'Wolf-Shade');
  r.link.mountHome();
  assert.equal(r.link.companions.mountOut, '');
  assert.equal(r.link.outbox.length, 1);
});

test('a stall answer is the homestead, projected for the game; a stall needs a connection', async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.link.stall('home:12', 2, 'Wolf-Shade'), { ok: false, code: 'offline' });
  await online(r);
  r.server.on('POST /api/stable/stall', env(S({ version: 2 }), { stall: { home: fixtures.get('home-view') } }));
  const res = await r.link.stall('home:12', 2, 'Wolf-Shade');
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.result?.stalls[0].mount, 'Wolf-Shade');
  const [sent] = r.server.sent('POST /api/stable/stall');
  assert.deepEqual([sent.body.homeId, sent.body.stall, sent.body.mount], ['home:12', 2, 'Wolf-Shade']);
});

test('a stall built: the homestead and the materials come back', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/stable/extend', env(S({ version: 2 }), { stableExtend: { home: fixtures.get('home-view'), materials: { timber: 3 } } }));
  const res = await r.link.stableExtend('home:12');
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(res.result.materials, { timber: 3 });
  assert.equal(res.result.home?.items.find((i) => i.itemDef === 'stable')?.stalls, 2);
});
