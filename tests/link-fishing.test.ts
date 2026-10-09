/**
 * Fishing through the link (docs/design/crafts.md 5.4, lane G): the three
 * keyed operations go through the outbox like the Wilds ones — online only,
 * with the lease, a key and where — and the waters read is a plain read.
 * Answers are lane A's fixtures (content/vectors/crafts-fixtures.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from '../content/vectors/crafts-fixtures.json' with { type: 'json' };
import { env, online, refuse, rig, S } from './helpers/link-rig.ts';

const fx = (name: string) => structuredClone(fixtures.messages.find((m) => m.name === name)!.json) as Record<string, any>;

/** A state with the fixture's open cast on it (PlayerState.fishing). */
function withCast(version: number): Record<string, any> {
  const s = S({ version });
  s.fishing = fx('fishing-state');
  return s;
}

test('fishing: cast, settle and cancel are keyed and online only; their answers’ state is adopted', async (t) => {
  const r = await rig(t);
  // No connection, no line: the pond is shared.
  assert.deepEqual(await r.link.fishCast({ water: 'water:village:mill-pond', bank: 'north', rod: 'inst-rod' }), { ok: false, code: 'offline' });
  await online(r);

  r.server.on('POST /api/fishing/cast', env(withCast(2), { fishCast: fx('fish-cast-result') }));
  const cast = await r.link.fishCast({ water: 'water:village:mill-pond', bank: 'north', rod: 'inst-rod', where: { area: 'village', x: 584, y: 296 } });
  assert.ok(cast.ok);
  if (!cast.ok) return;
  assert.equal(cast.result.cast!.id, 'cast:1');
  assert.equal(cast.result.cast!.readyAt, 1791400010.25);
  assert.equal(cast.result.band, 'healthy');
  const sent = r.server.sent('POST /api/fishing/cast')[0]!.body;
  assert.equal(sent.op.lease, 'L1');
  assert.ok(sent.op.key.length > 0);
  assert.deepEqual(sent.where, { area: 'village', x: 584, y: 296 });
  assert.deepEqual([sent.water, sent.bank, sent.rod], ['water:village:mill-pond', 'north', 'inst-rod']);
  assert.equal(r.link.server.fishing?.cast?.id, 'cast:1', 'the open cast is the world’s now (a reload puts the float back)');

  r.server.on('POST /api/fishing/settle', env(S({ version: 3 }), { fishSettle: fx('fish-settle-result') }));
  const kept = await r.link.fishSettle({ cast: 'cast:1', keep: true });
  assert.ok(kept.ok);
  if (!kept.ok) return;
  assert.deepEqual([kept.result.kept, kept.result.item, kept.result.wear?.usesLeft, kept.result.band], [true, 'mill-roach', 29, 'low']);
  const settle = r.server.sent('POST /api/fishing/settle')[0]!.body;
  assert.deepEqual([settle.cast, settle.keep], ['cast:1', true]);
  assert.equal(r.link.server.fishing, undefined, 'no line out after the settle');

  r.server.on('POST /api/fishing/cancel', env(S({ version: 4 }), { fishCancel: fx('fish-cancel-result') }));
  const pulled = await r.link.fishCancel('cast:1');
  assert.ok(pulled.ok);
  if (pulled.ok) assert.equal(pulled.result.band, 'low');
  const cancel = r.server.sent('POST /api/fishing/cancel')[0]!.body;
  assert.equal(cancel.cast, 'cast:1');
  assert.equal(cancel.where, undefined, 'pulling in needs no place');
  // Three operations, three keys.
  const keys = ['cast', 'settle', 'cancel'].map((p) => r.server.sent(`POST /api/fishing/${p}`)[0]!.body.op.key);
  assert.equal(new Set(keys).size, 3);
});

test('fishing: a refusal comes back as its code, and nothing is predicted into the world', async (t) => {
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/fishing/cast', refuse('water-still', S({ version: 2 })));
  assert.deepEqual(await r.link.fishCast({ water: 'water:village:mill-pond', bank: 'race', rod: 'inst-rod' }), { ok: false, code: 'water-still' });
  r.server.on('POST /api/fishing/cast', refuse('cast-too-soon', S({ version: 2 })));
  assert.deepEqual(await r.link.fishCast({ water: 'water:village:mill-pond', bank: 'race', rod: 'inst-rod' }), { ok: false, code: 'cast-too-soon' });
  r.server.on('POST /api/fishing/settle', refuse('not-yet', S({ version: 2 })));
  assert.deepEqual(await r.link.fishSettle({ cast: 'cast:1', keep: true }), { ok: false, code: 'not-yet' });
  assert.equal(r.link.server.fishing, undefined);
});

test('fishing: the waters read answers each water’s band', async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.link.readWaters('village'), { ok: false, code: 'offline' });
  await online(r);
  r.server.on('GET /api/fishing/waters?area=village', { body: fx('fishing-waters') });
  const read = await r.link.readWaters('village');
  assert.ok(read.ok);
  if (read.ok) assert.deepEqual(read.value.map((w) => [w.id, w.band]), [['water:village:mill-pond', 'healthy']]);
});
