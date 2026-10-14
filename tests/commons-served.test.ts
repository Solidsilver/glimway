import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { decodeChunk, fixedEpoch } from '../src/lib/api/chunks.ts';
import { WorldChunkSchema, type WorldChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { PLACES } from '../src/lib/places.ts';
import { TERRAIN } from '../src/lib/tile.ts';
import { COMMONS_EPOCH, COMMONS_FROM_VILLAGE, COMMONS_FROM_WILDS, commonsServed, commonsStand, forgetCommons, prepareCommons, servedCommons } from '../src/game/commons-served.ts';
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

// Review P1 (S2): meadow stands in before the chunks come, so a hero can walk
// into what the served map walls in: an open pocket in the woods. Open is not
// enough; the hero stands only where an arrival anchor's ground reaches.
test('on the served Commons, a tile the arrivals do not reach stands at the nearest one that they do', () => {
  const world = servedCommonsFixture({ festival: null, wick: 'Quiet' });
  const { width: w, height: h, solid } = world;
  // Flood from every anchor, independently of the adapter.
  const f = PLACES.fixed.find((f) => f.id === 'commons')!;
  const reach = new Set<string>();
  const queue = f.anchors.map((a) => [a.tx, a.ty]).filter(([x, y]) => !solid[y]![x]);
  for (const [x, y] of queue) reach.add(`${x},${y}`);
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || solid[ny]![nx] || reach.has(`${nx},${ny}`)) continue;
      reach.add(`${nx},${ny}`);
      queue.push([nx, ny]);
    }
  }
  // The review's pocket: open, walled in on every side.
  assert.equal(solid[2]![3], false);
  assert.equal(reach.has('3,2'), false);
  const pockets: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!solid[y]![x] && !reach.has(`${x},${y}`)) pockets.push([x, y]);
  for (const [x, y] of pockets) {
    const s = commonsStand(world, x, y);
    assert.ok(reach.has(`${s.tx},${s.ty}`), `${x},${y} stands on reached ground, not ${s.tx},${s.ty}`);
    // The nearest such tile: none reached is closer.
    const d = (s.tx - x) ** 2 + (s.ty - y) ** 2;
    for (const k of reach) {
      const [rx, ry] = k.split(',').map(Number);
      assert.ok((rx! - x) ** 2 + (ry! - y) ** 2 >= d, `${x},${y}: ${k} is nearer than ${s.tx},${s.ty}`);
    }
  }
  // Reached ground stands where it is; the arrivals are on it.
  for (const k of reach) {
    const [x, y] = k.split(',').map(Number);
    assert.deepEqual(commonsStand(world, x!, y!), { tx: x, ty: y });
  }
  for (const a of [COMMONS_FROM_VILLAGE, COMMONS_FROM_WILDS, ...world.gates.map((g) => g.entry)]) assert.ok(reach.has(`${a.tx},${a.ty}`));
  // A solid tile or one off the map stands on reached ground too.
  assert.ok(reach.has(Object.values(commonsStand(world, 0, 0)).join(',')));
  assert.ok(reach.has(Object.values(commonsStand(world, -5, 100)).join(',')));
  // The meadow is all open: anywhere on it stands.
  forgetCommons();
  const meadow = servedCommons();
  assert.equal(meadow.served, false);
  assert.deepEqual(commonsStand(meadow, 3, 2), { tx: 3, ty: 2 });
});
