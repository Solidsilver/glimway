import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { create, toBinary, toJson, type JsonValue } from '@bufbuild/protobuf';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import { FakeOperations } from '../src/lib/api/operations.ts';
import { WildsChunkSchema, WildsRegionResultSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { TERRAIN } from '../src/lib/tile.ts';
import { DECOR_ART } from '../src/game/wilds/decor.ts';
import { toWorldData } from '../src/game/wilds/terrain.ts';
import { cachedTerrain, forgetChunks, loadChunk, loadRegionChunks, pruneChunks } from '../src/game/wilds/chunks.ts';
import { applyClaim, refreshWilds, resetWilds, setActiveWildsRegion, wildsEpoch, wildsView } from '../src/game/wilds/store.ts';
import { claimEntity, settleEcho } from '../src/game/wilds/remote.ts';
import { hasAreaKind } from '../src/game/worlds.ts';
import type { Session } from '../src/game/session.ts';
import { fixtureBytes, fixtureChunk, fixtureTerrain } from './wilds-fixture.ts';

const envelopes = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { name: string; case: string; json: JsonValue }[];
const validState = envelopes.find((f) => f.name === 'glimway.v1.PlayerState' && f.case === 'valid')!.json;

test('a served chunk unpacks into grids, decor, exits, sites and bodies', () => {
  const m = fixtureChunk('inner-1');
  const t = fixtureTerrain('inner-1');
  assert.equal(t.epochId, 'fixture-inner');
  assert.equal(t.ground.length, 24);
  assert.equal(t.decor.length, m.decor!.kind.length);
  assert.ok(t.decor.length > 300, 'the woods are dense');
  // Every ground id is a known terrain; water is never walkable.
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      assert.ok(Object.values(TERRAIN).includes(t.ground[y]![x] as never));
      if (t.ground[y]![x] === TERRAIN.water_a) assert.equal(t.solid[y]![x], true);
    }
  }
  // Blocking decor stands on solid tiles; overhang only on blocking pieces.
  for (const d of t.decor) {
    if (DECOR_ART[d.kind].blocking) assert.equal(t.solid[d.ty]![d.tx], true, `${d.kind} at ${d.tx},${d.ty}`);
    if (d.overhang) assert.ok(DECOR_ART[d.kind].blocking);
  }
  // The Tangle's entry chunk: the way home to the Commons, the spawn just inside it.
  const home = t.exits.find((e) => e.to === 'commons')!;
  assert.deepEqual([home.dir, home.tx, home.ty], ['south', 1, 23]);
  assert.deepEqual(t.spawn, { tx: 2, ty: 22 });
  for (const e of t.exits) if (e.to !== 'commons') assert.match(e.to, /^chunk:inner-1:[0-2]:[0-2]$/);
  for (const e of t.entities) assert.equal(t.solid[e.ty]![e.tx], false);
  const outer = fixtureTerrain('outer-1');
  assert.equal(outer.look, 'outer');
  assert.ok(outer.mark, 'the outer look carries its Mark');
  assert.ok(outer.exits.some((e) => e.to === 'chunk:inner-1:1:0'), 'the way back over the crossing');
  assert.ok(outer.sites.some((s) => s.kind === 'given'));
});

test('a chunk draws as WorldData: scenery for every piece, sites, exits as served', () => {
  const t = fixtureTerrain('inner-1');
  const w = toWorldData(t, 'chunk:inner-1:1:1');
  assert.equal(w.scenery!.length, t.decor.length);
  assert.deepEqual(w.exits.map((e) => e.to), t.exits.map((e) => e.to));
  assert.equal(w.groundStyle, 'tangle');
  assert.deepEqual(w.spawn, t.spawn);
});

test('decoding refuses a tampered chunk', () => {
  const m = fixtureChunk('inner-1');
  m.decor!.tx.pop();
  assert.throws(() => decodeChunk(toBinary(WildsChunkSchema, m)));
  const bad = fixtureChunk('inner-1');
  bad.ground[0] = 0xff;
  assert.throws(() => decodeChunk(toBinary(WildsChunkSchema, bad)));
});

test('the chunk cache fetches each chunk once and forgets old epochs', async () => {
  forgetChunks();
  let calls = 0;
  const api = { chunk: async () => (calls++, fixtureChunk('inner-1')) };
  const [a, b] = await Promise.all([loadChunk(api, 'fixture-inner', 1, 1), loadChunk(api, 'fixture-inner', 1, 1)]);
  assert.equal(calls, 1, 'one fetch for two callers');
  assert.equal(a, b);
  assert.equal(cachedTerrain('fixture-inner', 1, 1), a);
  await loadChunk(api, 'fixture-inner', 1, 1);
  assert.equal(calls, 1, 'served from memory');
  await pruneChunks(['another-epoch']);
  assert.equal(cachedTerrain('fixture-inner', 1, 1), null, 'an epoch no longer current is forgotten');
  // A chunk that isn't the one asked for never lands in the cache.
  await assert.rejects(loadChunk({ chunk: async () => { throw new Error('identity'); } }, 'other', 0, 0));
  assert.equal(cachedTerrain('other', 0, 0), null);
});

/** A connected session as far as the Wilds store and operations read it. */
function fakeSession(ops: FakeOperations): Session {
  const link = { api: { operations: ops.api }, lease: 'lease-1', status: 'online', busy: false, accountId: 'me' };
  return { link, state: { area: 'wilds', position: { x: 424, y: 744 }, flags: [] } } as unknown as Session;
}

test('a region read loads its chunks and merges bodies with the server’s states', async () => {
  forgetChunks();
  resetWilds();
  const bytes = fixtureBytes('inner-1');
  const body = fixtureChunk('inner-1').entities[0]!;
  const region = create(WildsRegionResultSchema, {
    epoch: { id: 'fixture-inner', worldSeed: 'fixture', regionId: 'inner-1', generatorVersion: 2, season: '0', startsAt: 1 },
    entities: [{ id: body.id, cycle: 3, state: 'cleared', availableAt: 99, by: 'someone', epoch: 'fixture-inner' }],
    materials: { fiber: 4 },
    echoes: [{ site: 'echo:0', member: 'tam', settled: false }],
  });
  const ops = new FakeOperations();
  // As the server writes it (protojson, unpopulated fields included: unset wrappers are null).
  const json = toJson(WildsRegionResultSchema, region, { alwaysEmitImplicit: true }) as { epoch: Record<string, unknown>; entities: Record<string, unknown>[] };
  json.epoch.endsAt = null;
  for (const e of json.entities) e.at ??= null;
  ops.responses.set('/api/wilds/region/inner-1', [json as unknown as JsonValue]);
  // Only (1,1) is the fixture; the other eight answer with the same body under their coordinates.
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      const m = decodeChunk(bytes);
      m.cx = cx;
      m.cy = cy;
      ops.responses.set(`/api/wilds/chunk/fixture-inner/0/${cx}/${cy}`, [toBinary(WildsChunkSchema, m)]);
    }
  }
  setActiveWildsRegion('inner-1');
  assert.equal(await refreshWilds(fakeSession(ops)), true);
  assert.equal(wildsEpoch().id, 'fixture-inner');
  const view = wildsView()!;
  const merged = view.entities.find((e) => e.id === body.id)!;
  assert.deepEqual([merged.cycle, merged.state, merged.available_at, merged.by, merged.kind], [3, 'cleared', 99, 'someone', body.kind]);
  const fresh = view.entities.find((e) => e.id !== body.id)!;
  assert.deepEqual([fresh.cycle, fresh.state], [0, 'available'], 'no row: cycle 0, available');
  assert.equal(view.materials.fiber, 4);
  assert.deepEqual(view.echoes.get('echo:0'), { member: 'tam', settled: false });
  assert.ok(hasAreaKind('chunk:inner-1:2:2') && hasAreaKind('wilds'), 'every chunk area registered');
  assert.equal(ops.calls.filter((c) => c.path.startsWith('/api/wilds/chunk/')).length, 9);
  // A claim's answer moves the view.
  applyClaim({ $typeName: 'glimway.v1.WildsClaimResult', epoch: 'fixture-inner', entity: { $typeName: 'glimway.v1.WildsEntityState', id: fresh.id, cycle: 0, state: 'harvested', availableAt: 500, by: 'me', at: 1, epoch: 'fixture-inner' }, loot: undefined, materials: { fiber: 6 }, wardenSliverFound: false, stormDropFound: false, papers: [] });
  assert.equal(wildsView()!.entities.find((e) => e.id === fresh.id)!.state, 'harvested');
  assert.equal(wildsView()!.materials.fiber, 6);
});

test('Wilds operations send the lease, a key and where (the region and its pixels)', async () => {
  const ops = new FakeOperations();
  const envelope = (result: JsonValue) => ({ state: validState, ...(result as object) }) as JsonValue;
  ops.responses.set('/api/wilds/claim', [envelope({ wildsClaim: { epoch: 'e', entity: null, loot: null, materials: {}, wardenSliverFound: false, stormDropFound: false, papers: ['failed-grid-of-sector-4'] } })]);
  ops.responses.set('/api/wilds/echo', [new Error('refused')]);
  const session = fakeSession(ops);
  const claim = await claimEntity(session, { epoch: 'e', entityId: 'poi:1:1:0', cycle: 2, where: { region: 'outer-1', x: 100, y: 200 } });
  assert.ok(claim.ok);
  if (!claim.ok) return;
  assert.deepEqual(claim.result.papers, ['failed-grid-of-sector-4']);
  const sent = ops.calls[0]!.body as { op: { lease: string; key: string }; where: unknown; cycle: number; entityId: string };
  assert.equal(sent.op.lease, 'lease-1');
  assert.ok(sent.op.key.length > 0);
  assert.deepEqual(sent.where, { area: 'wilds:outer-1', x: 100, y: 200 });
  assert.equal(sent.cycle, 2);
  const settled = await settleEcho(session, { epoch: 'e', site: 'echo:0', member: 'tam', where: { region: 'outer-1', x: 1, y: 2 } });
  assert.equal(settled.ok, false);
  // No lease, no operation.
  const offline = await claimEntity({ ...session, link: { ...session.link!, lease: null } } as unknown as Session, { epoch: 'e', entityId: 'x', cycle: 0, where: { region: 'inner-1', x: 0, y: 0 } });
  assert.deepEqual(offline, { ok: false, code: 'offline' });
});

test('loadRegionChunks asks for the whole grid', async () => {
  forgetChunks();
  const asked: string[] = [];
  const api = {
    chunk: async (epoch: string, _layer: number, cx: number, cy: number) => {
      asked.push(`${cx},${cy}`);
      const m = fixtureChunk('outer-1');
      m.cx = cx;
      m.cy = cy;
      m.epochId = epoch;
      return decodeChunk(toBinary(WildsChunkSchema, m));
    },
  };
  const all = await loadRegionChunks(api, 'grid-epoch', { gridWidth: 3, gridHeight: 3 });
  assert.equal(all.length, 9);
  assert.deepEqual(asked.sort(), ['0,0', '0,1', '0,2', '1,0', '1,1', '1,2', '2,0', '2,1', '2,2']);
});
