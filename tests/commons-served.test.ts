import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { decodeChunk, fixedEpoch } from '../src/lib/api/chunks.ts';
import { WorldChunkSchema, type WorldChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { PLACES } from '../src/lib/places.ts';
import { TERRAIN } from '../src/lib/tile.ts';
import { COMMONS_EPOCH, COMMONS_FROM_VILLAGE, COMMONS_FROM_WILDS, commonsServed, forgetCommons, prepareCommons, servedCommons } from '../src/game/commons-served.ts';
import { chunkCacheKey, forgetChunks, loadFixedChunk } from '../src/game/wilds/chunks.ts';
import { buildArea } from '../src/game/worlds.ts';
import { EV, bus } from '../src/game/events.ts';
import { buildCommons, commonsForeground } from '../scripts/lib/commons-builder.ts';
import { commonsFixtureBytes, commonsFixtureChunks, servedCommonsFixture } from './commons-fixture.ts';

/** A list as a sorted multiset, for lists whose order the chunks don't keep. */
const bag = (xs: readonly unknown[] | undefined) => (xs ?? []).map((x) => JSON.stringify(x)).sort();

// Lane S2's acceptance (location-seam.md 6): the Commons the server serves,
// assembled by the adapter, is the old builder's Commons at the frozen
// capacity: the same grids, objects, exits and spawn. The one deliberate
// edit: the arch row is closed at world x = 4 (layout 25,0; section 2), so
// the arch's exit is the three tiles over the Tangle's gate.
for (const bloom of [false, true]) {
  test(`the served Commons is the old builder's at eight gates (${bloom ? 'the Bloom wick' : 'any other wick'})`, () => {
    const want = buildCommons(8, bloom);
    const got = servedCommonsFixture({ festival: null, wick: bloom ? 'Bloom' : 'Quiet' });
    assert.deepEqual([got.areaId, got.width, got.height, got.widthPx, got.heightPx], [want.areaId, want.width, want.height, want.widthPx, want.heightPx]);
    assert.deepEqual(got.ground, want.ground);
    assert.equal(want.solid[0]![25], false);
    assert.equal(got.solid[0]![25], true, 'the arch row is closed at world x 4');
    const solid = got.solid.map((row) => [...row]);
    solid[0]![25] = false;
    assert.deepEqual(solid, want.solid);
    for (const k of ['trees', 'bushes', 'rocks', 'props', 'scenery', 'gathering', 'npcs'] as const) assert.deepEqual(bag(got[k]), bag(want[k]), k);
    const arch = want.exits.find((e) => e.to === 'wilds')!;
    assert.equal(arch.tw, 4);
    assert.deepEqual(bag(got.exits), bag(want.exits.map((e) => (e === arch ? { ...e, tw: 3 } : e))), 'exits');
    assert.deepEqual(bag(got.foreground), bag(commonsForeground(want)), 'foreground');
    assert.deepEqual(got.gates, want.gates);
    assert.deepEqual({ ...got.features, lamps: bag(got.features.lamps) }, { ...want.features, lamps: bag(want.features.lamps) });
    assert.deepEqual([got.spawn, got.board], [want.spawn, want.board]);
    for (const k of ['enemies', 'discoverySpots', 'glimSpots'] as const) assert.deepEqual(got[k], want[k], k);
    for (const k of ['well', 'mural', 'shrine', 'villageLantern'] as const) assert.equal(got[k], want[k], k);
    assert.equal(got.served, true);
  });
}

test('the Carting Day is not the Bloom: festival-tagged spots follow the day', () => {
  const quiet = servedCommonsFixture({ festival: 'Carting Day', wick: 'Cart' });
  const bloom = servedCommonsFixture({ festival: null, wick: 'Bloom' });
  assert.equal(quiet.gathering!.length, 0);
  assert.ok(bloom.gathering!.length > 0 && bloom.gathering!.every((g) => g.target === 'bloom-patch'));
});

test('the arrivals are the Commons anchors', () => {
  const f = PLACES.fixed.find((f) => f.id === 'commons')!;
  const tile = (id: string) => { const a = f.anchors.find((a) => a.id === id)!; return { tx: a.tx, ty: a.ty }; };
  assert.deepEqual(COMMONS_FROM_VILLAGE, tile('west-path'));
  assert.deepEqual(COMMONS_FROM_WILDS, tile('arch'));
});

test('fixed chunks validate as the server’s do; a fixed chunk of an unknown layout or revision is refused', () => {
  const chunks = commonsFixtureChunks();
  assert.equal(chunks.length, 6);
  for (const c of chunks) assert.equal(c.epochId, 'fixed:commons@1');
  const edits: Record<string, (c: WorldChunk) => void> = {
    'unknown layout': (c) => { c.epochId = 'fixed:village@1'; },
    'another revision': (c) => { c.epochId = 'fixed:commons@2'; c.layoutRevision = 2; },
    'outside the place': (c) => { c.cx = 2; },
    'generator version': (c) => { c.generatorVersion = 3; },
    'generated land': (c) => { c.land = 'woods'; },
    'unknown terrain': (c) => { c.palette[0] = 'lava'; },
    'object kind': (c) => { c.objects[0]!.kind = 'dragon'; },
    'object tile': (c) => { c.objects[0]!.tx = 24; },
    'object id twice': (c) => { c.objects[1]!.id = c.objects[0]!.id; }
  };
  for (const [name, edit] of Object.entries(edits)) {
    const c = clone(WorldChunkSchema, chunks[0]!);
    edit(c);
    assert.throws(() => decodeChunk(toBytes(c)), Error, name);
  }
  // A generated chunk never takes a fixed pseudo-epoch or carries objects.
  const g = fromBinary(WorldChunkSchema, new Uint8Array(readFileSync(new URL('./fixtures/wilds-tangle.bin', import.meta.url))));
  assert.doesNotThrow(() => decodeChunk(toBytes(g)));
  for (const edit of [(c: WorldChunk) => { c.epochId = 'fixed:commons@1'; }, (c: WorldChunk) => { c.objects = [clone(WorldChunkSchema, chunks[0]!).objects[0]!]; }]) {
    const c = clone(WorldChunkSchema, g);
    edit(c);
    assert.throws(() => decodeChunk(toBytes(c)));
  }
});

function toBytes(c: WorldChunk): Uint8Array {
  return toBinary(WorldChunkSchema, c);
}

test('every curated terrain a palette may name is a client terrain', () => {
  // content/layouts.go CuratedTerrains is TERRAIN's keys, in order.
  const go = readFileSync(new URL('../content/layouts.go', import.meta.url), 'utf8');
  const list = /var CuratedTerrains = \[\]string\{([^}]*)\}/.exec(go)![1]!.match(/"[a-z_]+"/g)!.map((s) => s.slice(1, -1));
  assert.deepEqual(list, Object.keys(TERRAIN));
});

test('the client keeps fixed chunks under their revision: a new revision is a new key', async () => {
  forgetChunks();
  assert.equal(COMMONS_EPOCH, fixedEpoch('commons', 1));
  assert.notEqual(chunkCacheKey(fixedEpoch('commons', 1), 0, 1), chunkCacheKey(fixedEpoch('commons', 2), 0, 1));
  assert.match(chunkCacheKey(COMMONS_EPOCH, 0, 1), /:fixed:commons@1:0:1$/);
  const calls: string[] = [];
  const api = {
    async chunk(epoch: string, layer: number, cx: number, cy: number) {
      calls.push(`${epoch}/${layer}/${cx}/${cy}`);
      return decodeChunk(commonsFixtureBytes(cx, cy));
    }
  };
  const a = await loadFixedChunk(api, COMMONS_EPOCH, 0, 1);
  const b = await loadFixedChunk(api, COMMONS_EPOCH, 0, 1);
  assert.equal(a, b);
  assert.deepEqual(calls, ['fixed:commons@1/0/0/1']);
  forgetChunks();
});

test('the Commons area is meadow until its chunks come, then the served map (and the scene hears it)', async () => {
  forgetChunks();
  forgetCommons();
  const before = buildArea('commons') as ReturnType<typeof servedCommons>;
  assert.equal(before.served, false);
  assert.equal(commonsServed(), false);
  let heard = 0;
  const on = (p: { reason: string }) => { if (p.reason === 'commons') heard++; };
  bus.on(EV.homeChanged, on);
  const fetched: string[] = [];
  const session = { link: { api: { operations: { async chunk(epoch: string, _layer: number, cx: number, cy: number) { fetched.push(`${cx},${cy}`); assert.equal(epoch, COMMONS_EPOCH); return decodeChunk(commonsFixtureBytes(cx, cy)); } } } } } as never;
  try {
    await prepareCommons(session);
    assert.equal(commonsServed(), true);
    assert.equal(heard, 1);
    assert.deepEqual(fetched.sort(), ['-1,1', '-1,2', '0,1', '0,2', '1,1', '1,2']);
    const after = buildArea('commons') as ReturnType<typeof servedCommons>;
    assert.equal(after.served, true);
    assert.equal(after.gates.length, 8);
    // Without a server there is nothing to fetch.
    forgetCommons();
    assert.equal(prepareCommons({ link: null }), null);
  } finally {
    bus.off(EV.homeChanged, on);
    forgetCommons();
    forgetChunks();
  }
});
