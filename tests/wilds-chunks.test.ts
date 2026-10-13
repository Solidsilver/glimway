import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, toBinary, type JsonValue } from '@bufbuild/protobuf';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import { FakeOperations } from '../src/lib/api/operations.ts';
import { WildsChunkSchema, WildsNearResultSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { TERRAIN } from '../src/lib/tile.ts';
import { epochKindAt } from '../src/lib/wilds/coords.ts';
import { DECOR_ART } from '../src/game/wilds/decor.ts';
import { cachedTerrain, forgetChunks, loadChunk, pruneChunks } from '../src/game/wilds/chunks.ts';
import { applyClaim, applyEchoSettled, applyLanterns, applyNear, chunkEpoch, chunkThings, groundChanges, isClaimed, readMark, refreshNear, resetWilds, takeReadRequest, wildsEpoch, wildsFrontier, wildsLive, wildsStale, wildsView } from '../src/game/wilds/store.ts';
import { bus, EV } from '../src/game/events.ts';
import type { Session } from '../src/game/session.ts';
import { chunkAt, fixtureChunk, fixtureTerrain } from './wilds-fixture.ts';

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { name: string; case: string; json: JsonValue }[];
/** The near read O-A's contract ships (centre (-2, -4), the 0.8 frontier), as the server writes it. */
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;
const CENTER = { cx: NEAR.center.cx as number, cy: NEAR.center.cy as number };

test('a served chunk unpacks into grids, decor, sites, bodies, its tier and land', () => {
  const m = fixtureChunk('tangle');
  const t = fixtureTerrain('tangle');
  assert.equal(t.epochId, m.epochId);
  assert.deepEqual([t.cx, t.cy, t.size, t.tier, t.land], [0, -1, 24, 1, 'woods']);
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
  for (const e of t.entities) assert.equal(t.solid[e.ty]![e.tx], false);
  const outer = fixtureTerrain('whitequiet-0-4');
  assert.equal(outer.look, 'outer');
  assert.ok(outer.mark, 'the outer look carries its Mark');
  // The Beyond's fixtures: a dark lamp stone by the road, a ford over the Wend.
  assert.ok(fixtureTerrain('road').sites.some((s) => s.kind === 'lamp-stone'));
  const ford = fixtureTerrain('ford');
  assert.ok(ford.ground.some((row) => row.includes(TERRAIN.water_b)), 'ford shallows');
  assert.ok(ford.ground.some((row) => row.includes(TERRAIN.water_a)), 'and the river')
  // A place's landmark mark comes with its chunk.
  const placed = chunkAt('whitequiet-0-4', 0, -4);
  placed.places = [{ $typeName: 'glimway.v1.WildsPlaceMark', id: 'place:0:-1', kind: 'ruin', tx: 5, ty: 6 }];
  assert.deepEqual(decodeChunk(toBinary(WildsChunkSchema, placed)).places.map((p) => p.id), ['place:0:-1']);
});

test('decoding refuses a tampered chunk', () => {
  const m = fixtureChunk('tangle');
  m.decor!.tx.pop();
  assert.throws(() => decodeChunk(toBinary(WildsChunkSchema, m)));
  const bad = fixtureChunk('tangle');
  bad.ground[0] = 0xff;
  assert.throws(() => decodeChunk(toBinary(WildsChunkSchema, bad)));
});

test('the chunk cache fetches each chunk once and forgets old epochs', async () => {
  forgetChunks();
  let calls = 0;
  const api = { chunk: async () => (calls++, fixtureChunk('tangle')) };
  const [a, b] = await Promise.all([loadChunk(api, 'fixture-inner', 0, -1), loadChunk(api, 'fixture-inner', 0, -1)]);
  assert.equal(calls, 1, 'one fetch for two callers');
  assert.equal(a, b);
  assert.equal(cachedTerrain('fixture-inner', 0, -1), a);
  await loadChunk(api, 'fixture-inner', 0, -1);
  assert.equal(calls, 1, 'served from memory');
  await pruneChunks(['another-epoch']);
  assert.equal(cachedTerrain('fixture-inner', 0, -1), null, 'an epoch no longer current is forgotten');
  // A chunk that isn't the one asked for never lands in the cache.
  await assert.rejects(loadChunk({ chunk: async () => { throw new Error('identity'); } }, 'other', 0, 0));
  assert.equal(cachedTerrain('other', 0, 0), null);
});

/** A connected session as far as the Wilds store and operations read it. */
function fakeSession(ops: FakeOperations): Session {
  const link = { api: { operations: ops.api }, lease: 'lease-1', status: 'online', busy: false, accountId: 'me' };
  return { link, state: { area: 'wilds', position: { x: 0, y: 0 }, flags: [] } } as unknown as Session;
}

/** A near read around (cx, cy) as the server writes it: the fixture's, moved, with its own extras. */
function nearAt(cx: number, cy: number, edit: (j: Record<string, any>) => void = () => {}): JsonValue {
  const j = structuredClone(NEAR);
  j.center = { ...j.center, cx, cy };
  edit(j);
  return j as JsonValue;
}

/** Answer every chunk of the window around (cx, cy) inside the frontier, each in its epoch (the Tangle's still, else the wick's). */
function serveWindow(ops: FakeOperations, cx: number, cy: number, wick = NEAR.wick.id as string): void {
  const f = NEAR.frontier.rect;
  for (let y = cy - 2; y <= cy + 2; y++)
    for (let x = cx - 2; x <= cx + 2; x++) {
      if (x < f.minCx || x > f.maxCx || y < f.minCy || y > f.maxCy) continue;
      const epoch = epochKindAt(x, y) === 'still' ? (NEAR.still.id as string) : wick;
      const m = chunkAt(epochKindAt(x, y) === 'still' ? 'tangle' : 'whitequiet-0-4', x, y);
      m.epochId = epoch;
      // The fixture's states name node 0 of each chunk.
      Object.assign(m.entities[0]!, { id: `node:${x}:${y}:0`, kind: 'node', material: 'stone', enemies: [], tier: 0, poi: '' });
      ops.responses.set(`/api/wilds/chunk/${epoch}/0/${x}/${y}`, [toBinary(WildsChunkSchema, m)]);
    }
}

test('a near read loads its window, each chunk in its epoch, and merges bodies with the server’s states', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const session = fakeSession(ops);
  // The fixture's harvested node is the first entity of chunk (-2, -4).
  ops.responses.set(`/api/wilds/near/${CENTER.cx}/${CENTER.cy}`, [nearAt(CENTER.cx, CENTER.cy)]);
  serveWindow(ops, CENTER.cx, CENTER.cy);
  assert.equal(await refreshNear(session, CENTER.cx, CENTER.cy), true);
  assert.equal(wildsEpoch('still').id, NEAR.still.id);
  assert.equal(wildsEpoch('wick').id, NEAR.wick.id);
  assert.deepEqual(wildsFrontier(), { minCx: -4, minCy: -8, maxCx: 4, maxCy: 0 });
  // The window is 5×5; all of it lies inside the frontier here. The Tangle's
  // chunks come in the still epoch, the rest in the wick's.
  const fetched = ops.calls.filter((c) => c.path.startsWith('/api/wilds/chunk/')).map((c) => c.path)
  assert.equal(fetched.length, 25);
  assert.ok(fetched.includes(`/api/wilds/chunk/${NEAR.still.id}/0/-1/-2`), 'a Tangle chunk in the still epoch');
  assert.ok(fetched.includes(`/api/wilds/chunk/${NEAR.wick.id}/0/-2/-4`), 'a Beyond chunk in the wick epoch');
  assert.equal(chunkEpoch(0, -1)!.kind, 'still');
  assert.equal(chunkEpoch(0, -4)!.kind, 'wick');
  const things = chunkThings(-2, -4);
  const merged = things.find((e) => e.id === 'node:-2:-4:0')!;
  assert.deepEqual([merged.cycle, merged.state, merged.by, merged.cx, merged.cy], [1, 'harvested', 'fixture-account', -2, -4]);
  const fresh = things.find((e) => e.id !== merged.id)!;
  assert.deepEqual([fresh.cycle, fresh.state], [0, 'available'], 'no row: cycle 0, available');
  const view = wildsView()!;
  assert.equal(view.materials.stone, 4);
  assert.deepEqual(view.echoes.get('echo:0'), { member: 'tam', settled: false });
  assert.ok(isClaimed('chest:-2:-4:0'));
  assert.deepEqual(groundChanges(-2, -4).map((c) => c.change), ['cleared', 'stone']);
  assert.deepEqual(view.glimpse.get('-5,-4'), { land: 'meadow', river: true });
  assert.equal(view.ways.size, 1);
  assert.equal(view.lanterns.size, 1);
  // A claim's answer moves the view.
  applyClaim({ $typeName: 'glimway.v1.WildsClaimResult', epoch: NEAR.wick.id, entity: { $typeName: 'glimway.v1.WildsEntityState', campClaimable: false, id: fresh.id, cycle: 0, state: 'harvested', availableAt: 500, by: 'me', at: 1, epoch: NEAR.wick.id }, loot: undefined, materials: { fiber: 6 }, wardenSliverFound: false, stormDropFound: false, papers: [] });
  assert.equal(chunkThings(-2, -4).find((e) => e.id === fresh.id)!.state, 'harvested');
  assert.equal(wildsView()!.materials.fiber, 6);

  // A chunk read within 10 s is reused; another chunk is read.
  const reads = () => ops.calls.filter((c) => c.path.startsWith('/api/wilds/near/')).length;
  assert.equal(await refreshNear(session, CENTER.cx, CENTER.cy, 10_000), true);
  assert.equal(reads(), 1, 'reused');

  // Freshness: live while fresh and online; a failed refresh keeps the view to look at, stale.
  assert.ok(wildsLive(session));
  assert.equal(wildsStale(session), false);
  const offline = { ...session, link: { ...session.link!, status: 'offline' } } as unknown as Session;
  assert.equal(wildsLive(offline), null, 'no offers without a connection');
  assert.equal(wildsStale(offline), true);
  const version = wildsView()!.version;
  assert.equal(await refreshNear(session, CENTER.cx, CENTER.cy), false, 'the read fails (no answer queued)');
  assert.ok(wildsView(), 'the last view stays to look at');
  assert.equal(wildsView()!.stale, true);
  assert.ok(wildsView()!.version > version, 'scenes re-render as stale');
  assert.equal(wildsLive(session), null, 'nothing offered from a stale view');
  assert.equal(await refreshNear(session, CENTER.cx, CENTER.cy, 60_000), false, 'a stale view is never "recent enough"');
  // A fresh read (its chunks cached now) makes it live again.
  ops.responses.set(`/api/wilds/near/${CENTER.cx}/${CENTER.cy}`, [nearAt(CENTER.cx, CENTER.cy)]);
  assert.equal(await refreshNear(session, CENTER.cx, CENTER.cy), true);
  assert.equal(wildsView()!.stale, false);
  assert.ok(wildsLive(session));
});

test('a read replaces only its own window: states, claims and changes elsewhere stay', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const session = fakeSession(ops);
  ops.responses.set(`/api/wilds/near/${CENTER.cx}/${CENTER.cy}`, [nearAt(CENTER.cx, CENTER.cy)]);
  serveWindow(ops, CENTER.cx, CENTER.cy);
  await refreshNear(session, CENTER.cx, CENTER.cy);
  // Two chunks east: (-2, -4) is still in the new window (cx -2..2), so its
  // state, claim and changes are the new read's (none); the fixture's lantern
  // at tiles (400, 300) is far from both windows and stays.
  ops.responses.set(`/api/wilds/near/0/-4`, [nearAt(0, -4, (j) => {
    j.entities = [];
    j.personalClaims = [];
    j.ground = [];
    j.lanterns = [];
    j.discoveries = [];
    j.glimpse = [];
  })]);
  serveWindow(ops, 0, -4);
  assert.equal(await refreshNear(session, 0, -4), true);
  assert.equal(chunkThings(-2, -4).find((e) => e.id === 'node:-2:-4:0')!.state, 'available', 'the window’s own state replaced');
  assert.equal(isClaimed('chest:-2:-4:0'), false);
  assert.deepEqual(groundChanges(-2, -4), []);
  assert.equal(wildsView()!.lanterns.size, 1, 'a lantern outside the window stays');
  assert.deepEqual(wildsView()!.glimpse.get('-5,-4'), { land: 'meadow', river: true }, 'what was glimpsed stays');
});

test('a read in another wick is the turning: the view starts over and the scene is told', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const session = fakeSession(ops);
  ops.responses.set(`/api/wilds/near/${CENTER.cx}/${CENTER.cy}`, [nearAt(CENTER.cx, CENTER.cy)]);
  serveWindow(ops, CENTER.cx, CENTER.cy);
  await refreshNear(session, CENTER.cx, CENTER.cy);
  let turned = 0;
  const on = () => turned++;
  bus.on(EV.turning, on);
  try {
    // The next wick: every state of the old one is gone with it.
    ops.responses.set(`/api/wilds/near/${CENTER.cx}/${CENTER.cy}`, [nearAt(CENTER.cx, CENTER.cy, (j) => {
      j.wick = { ...j.wick, id: 'wick-epoch-2', startsAt: j.wick.endsAt, endsAt: j.wick.endsAt + 604800, season: `t:${j.wick.endsAt}:${j.wick.endsAt + 604800}` };
      j.ground = j.ground.filter(() => false);
      j.entities = [];
      j.personalClaims = [];
      j.discoveries = [];
      j.ways = [];
    })]);
    serveWindow(ops, CENTER.cx, CENTER.cy, 'wick-epoch-2');
    assert.equal(await refreshNear(session, CENTER.cx, CENTER.cy), true);
    assert.equal(turned, 1);
    assert.equal(wildsEpoch('wick').id, 'wick-epoch-2');
    assert.equal(isClaimed('chest:-2:-4:0'), false);
    assert.equal(wildsView()!.ways.size, 0);
    assert.equal(chunkEpoch(-2, -4)!.id, 'wick-epoch-2');
    assert.ok(chunkThings(-2, -4).length > 0, 'the new wick’s chunk is loaded');
    assert.equal(chunkEpoch(0, -1)!.id, NEAR.still.id, 'the Tangle keeps its still epoch');
  } finally {
    bus.off(EV.turning, on);
  }
});

// ------------------------------------------------------------ late reads (step-back review F1, F3)

const nearPath = (cx: number, cy: number) => `/api/wilds/near/${cx}/${cy}`;

/** A session whose near reads wait until the test answers them (`go`), in any order; `fail` loses one. */
function deferredSession(ops: FakeOperations): { session: Session; waiting: { cx: number; cy: number; go: () => void; fail: () => void }[] } {
  const session = fakeSession(ops);
  const waiting: { cx: number; cy: number; go: () => void; fail: () => void }[] = [];
  const real = ops.api;
  const operations = {
    ...real,
    near: (cx: number, cy: number) =>
      new Promise<Awaited<ReturnType<typeof real.near>>>((resolve, reject) => {
        waiting.push({ cx, cy, go: () => resolve(real.near(cx, cy)), fail: () => reject(new Error('lost')) });
      }),
  };
  (session.link as unknown as { api: unknown }).api = { operations };
  return { session, waiting };
}

/** Let pending answers and their chunk loads run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Everything a player sees of the Wilds' state, for whole-view comparisons. */
function visible() {
  const v = wildsView();
  if (!v) return null;
  return {
    still: v.still.id,
    wick: v.wick.id,
    stale: v.stale,
    states: Object.fromEntries([...v.states].sort()),
    claims: [...v.claims].sort(),
    lanterns: Object.fromEntries([...v.lanterns].map(([id, l]) => [id, l.litBy])),
    echoes: Object.fromEntries(v.echoes),
    materials: Object.fromEntries(Object.entries(v.materials).filter(([, q]) => q !== 0)),
    ground: Object.fromEntries([...v.ground].map(([k, g]) => [k, g.map((c) => c.change)])),
    ways: [...v.ways.keys()].sort(),
  };
}

test('a read asked before a reset is dropped: the old world’s answer never revives or changes the new one', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const old = deferredSession(ops);
  serveWindow(ops, CENTER.cx, CENTER.cy);
  ops.responses.set(nearPath(CENTER.cx, CENTER.cy), [nearAt(CENTER.cx, CENTER.cy), nearAt(CENTER.cx, CENTER.cy)]);
  let turned = 0;
  const on = () => turned++;
  bus.on(EV.turning, on);
  try {
    // Leave the world while a read is out: its answer finds nothing to fill.
    const first = refreshNear(old.session, CENTER.cx, CENTER.cy);
    resetWilds();
    old.waiting[0]!.go();
    assert.equal(await first, false);
    assert.equal(wildsView(), null, 'the cleared view stays cleared');

    // Again, with another world entered and read before the old answer lands.
    const late = refreshNear(old.session, CENTER.cx, CENTER.cy);
    resetWilds();
    const ops2 = new FakeOperations();
    const next = fakeSession(ops2);
    ops2.responses.set(nearPath(CENTER.cx, CENTER.cy), [nearAt(CENTER.cx, CENTER.cy, (j) => {
      j.entities = [];
      j.personalClaims = [];
      j.materials = { stone: 77 };
    })]);
    serveWindow(ops2, CENTER.cx, CENTER.cy);
    assert.equal(await refreshNear(next, CENTER.cx, CENTER.cy), true);
    const before = visible();
    const version = wildsView()!.version;
    old.waiting[1]!.go();
    assert.equal(await late, false);
    assert.deepEqual(visible(), before, 'the new world’s view is untouched');
    assert.equal(wildsView()!.version, version, 'not even a re-render');
    assert.equal(wildsView()!.materials.stone, 77);
    assert.equal(chunkThings(-2, -4).find((e) => e.id === 'node:-2:-4:0')!.state, 'available');
    assert.equal(turned, 0, 'no turning from a dropped answer');
  } finally {
    bus.off(EV.turning, on);
  }
});

test('an old read’s failure after a reset doesn’t mark the new view stale', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const old = deferredSession(ops);
  const late = refreshNear(old.session, CENTER.cx, CENTER.cy);
  resetWilds();
  const ops2 = new FakeOperations();
  const next = fakeSession(ops2);
  ops2.responses.set(nearPath(CENTER.cx, CENTER.cy), [nearAt(CENTER.cx, CENTER.cy)]);
  serveWindow(ops2, CENTER.cx, CENTER.cy);
  assert.equal(await refreshNear(next, CENTER.cx, CENTER.cy), true);
  const version = wildsView()!.version;
  old.waiting[0]!.fail();
  assert.equal(await late, false);
  assert.equal(wildsView()!.stale, false);
  assert.equal(wildsView()!.version, version);
  assert.ok(wildsLive(next), 'still offered');
});

test('two overlapping reads answered backwards leave the later read’s view, and the earlier one’s own chunks', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const { session, waiting } = deferredSession(ops);
  serveWindow(ops, CENTER.cx, CENTER.cy);
  serveWindow(ops, CENTER.cx + 1, CENTER.cy);
  // The earlier read, around (-2, -4): the fixture's, plus a harvested node in column -4, which only it covers.
  ops.responses.set(nearPath(CENTER.cx, CENTER.cy), [nearAt(CENTER.cx, CENTER.cy, (j) => {
    j.entities = [...j.entities, { ...j.entities[0], id: 'node:-4:-4:0' }];
  })]);
  // The later read, around (-1, -4): the node and chest are back, the ground and the way gone, the Echo settled.
  ops.responses.set(nearPath(CENTER.cx + 1, CENTER.cy), [nearAt(CENTER.cx + 1, CENTER.cy, (j) => {
    j.entities = [];
    j.personalClaims = [];
    j.ground = [];
    j.ways = [];
    j.materials = { stone: 8 };
    j.echoes = [{ site: 'echo:0', member: 'tam', settled: true }];
  })]);
  const earlier = refreshNear(session, CENTER.cx, CENTER.cy);
  const later = refreshNear(session, CENTER.cx + 1, CENTER.cy);
  waiting[1]!.go();
  assert.equal(await later, true);
  const after = visible()!;
  waiting[0]!.go();
  assert.equal(await earlier, true);
  const v = visible()!;
  assert.deepEqual(v, {
    ...after,
    // Only the column the later read didn't cover takes the earlier read's state.
    states: { 'node:-4:-4:0': { cycle: 1, state: 'harvested', available_at: 1791400020, by: 'fixture-account', at: 1791400000, camp_claimable: false } },
  });
  assert.equal(v.materials.stone, 8);
  assert.deepEqual(v.claims, []);
  assert.deepEqual(v.ground, {});
  assert.deepEqual(v.ways, []);
  assert.deepEqual(v.echoes['echo:0'], { member: 'tam', settled: true });
  assert.equal(chunkThings(-2, -4).find((e) => e.id === 'node:-2:-4:0')!.state, 'available');
});

test('an old wick’s answer after the new wick can’t turn the land back', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const { session, waiting } = deferredSession(ops);
  serveWindow(ops, CENTER.cx, CENTER.cy);
  ops.responses.set(nearPath(CENTER.cx, CENTER.cy), [nearAt(CENTER.cx, CENTER.cy)]);
  const first = refreshNear(session, CENTER.cx, CENTER.cy);
  waiting[0]!.go();
  assert.equal(await first, true);
  const nextWick = (j: Record<string, any>) => {
    j.wick = { ...j.wick, id: 'wick-epoch-2', startsAt: j.wick.endsAt, endsAt: j.wick.endsAt + 604800, season: `t:${j.wick.endsAt}:${j.wick.endsAt + 604800}` };
    j.entities = [];
    j.personalClaims = [];
    j.ground = [];
    j.ways = [];
    j.materials = { stone: 2 };
  };
  serveWindow(ops, CENTER.cx + 1, CENTER.cy, 'wick-epoch-2');
  serveWindow(ops, CENTER.cx, CENTER.cy, 'wick-epoch-2');
  ops.responses.set(nearPath(CENTER.cx, CENTER.cy), [nearAt(CENTER.cx, CENTER.cy)]);
  ops.responses.set(nearPath(CENTER.cx + 1, CENTER.cy), [nearAt(CENTER.cx + 1, CENTER.cy, nextWick)]);
  let turned = 0;
  const on = () => turned++;
  bus.on(EV.turning, on);
  try {
    const old = refreshNear(session, CENTER.cx, CENTER.cy);
    const fresh = refreshNear(session, CENTER.cx + 1, CENTER.cy);
    waiting[2]!.go();
    assert.equal(await fresh, true);
    assert.equal(turned, 1);
    const after = visible();
    waiting[1]!.go();
    assert.equal(await old, false, 'the old wick’s answer is dropped');
    await settle();
    assert.equal(turned, 1, 'no second turning');
    assert.equal(wildsEpoch('wick').id, 'wick-epoch-2');
    assert.deepEqual(visible(), after);
    assert.equal(chunkEpoch(-2, -4)!.id, 'wick-epoch-2');
    // A read asked after the turning that still names the ended wick (a lagging server) is dropped too.
    const lagging = JSON.parse(JSON.stringify(nearAt(CENTER.cx, CENTER.cy)));
    assert.equal(applyNear(fromJson(WildsNearResultSchema, lagging), readMark()), null);
    assert.deepEqual(visible(), after);
  } finally {
    bus.off(EV.turning, on);
  }
});

test('answers outrank an earlier near read: claims, relights and settled Echoes stay, whole', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const session = fakeSession(ops);
  ops.responses.set(nearPath(CENTER.cx, CENTER.cy), [nearAt(CENTER.cx, CENTER.cy)]);
  serveWindow(ops, CENTER.cx, CENTER.cy);
  assert.equal(await refreshNear(session, CENTER.cx, CENTER.cy), true);
  assert.equal(chunkThings(-3, -4).find((e) => e.id === 'node:-3:-4:0')!.state, 'available');
  // A read is asked; before its answer lands, a harvest, a relight and a settle are answered.
  const since = readMark();
  const snapshot = fromJson(WildsNearResultSchema, nearAt(CENTER.cx, CENTER.cy));
  const wick = NEAR.wick.id as string;
  applyClaim({ $typeName: 'glimway.v1.WildsClaimResult', epoch: wick, entity: { $typeName: 'glimway.v1.WildsEntityState', campClaimable: false, id: 'node:-3:-4:0', cycle: 0, state: 'harvested', availableAt: 1791400900, by: 'me', at: 1791400100, epoch: wick }, loot: undefined, materials: { stone: 9 }, wardenSliverFound: false, stormDropFound: false, papers: [] });
  assert.equal(applyLanterns([{ $typeName: 'glimway.v1.WildsLantern', id: 'fallen-lamp', ownerId: 'peer-account', displayName: 'Peer', x: 400, y: 300, litBy: 'me', at: 1791400000, litAt: 1791400200 }], wick), true);
  assert.equal(applyEchoSettled('echo:0', wick), true);
  const answered = visible()!;
  assert.equal(answered.materials.stone, 9);
  // The earlier read lands.
  applyNear(snapshot, since);
  assert.deepEqual(visible(), answered, 'nothing the answers set moved back');
  const node = chunkThings(-3, -4).find((e) => e.id === 'node:-3:-4:0')!;
  assert.deepEqual([node.state, node.cycle], ['harvested', 0]);
  assert.equal(wildsView()!.lanterns.get('fallen-lamp')!.litBy, 'me');
  assert.deepEqual(wildsView()!.echoes.get('echo:0'), { member: 'tam', settled: true });
  // A read asked after the answers is the newer word: it is adopted, whole.
  applyNear(fromJson(WildsNearResultSchema, nearAt(CENTER.cx, CENTER.cy, (j) => (j.materials = { stone: 10 }))), readMark());
  assert.equal(wildsView()!.materials.stone, 10);
  assert.equal(chunkThings(-3, -4).find((e) => e.id === 'node:-3:-4:0')!.state, 'available');
  assert.equal(wildsView()!.lanterns.get('fallen-lamp')!.litBy, 'fixture-account');
  assert.deepEqual(wildsView()!.echoes.get('echo:0'), { member: 'tam', settled: false });
});

test('an answer for land that turned since is not applied to the new land', async () => {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const session = fakeSession(ops);
  ops.responses.set(nearPath(CENTER.cx, CENTER.cy), [nearAt(CENTER.cx, CENTER.cy)]);
  serveWindow(ops, CENTER.cx, CENTER.cy);
  assert.equal(await refreshNear(session, CENTER.cx, CENTER.cy), true);
  takeReadRequest();
  const before = visible()!;
  const old = 'wick-epoch-0';
  const drop = applyClaim({ $typeName: 'glimway.v1.WildsClaimResult', epoch: old, entity: { $typeName: 'glimway.v1.WildsEntityState', campClaimable: false, id: 'node:-3:-4:0', cycle: 4, state: 'harvested', availableAt: 1, by: 'me', at: 1, epoch: old }, loot: { $typeName: 'glimway.v1.WildsLoot', materials: [{ $typeName: 'glimway.v1.WildsMaterial', id: 'stone', qty: 2 }] } as never, materials: { stone: 6 }, wardenSliverFound: false, stormDropFound: false, papers: [] });
  assert.deepEqual(drop.materials, [{ id: 'stone', qty: 2 }], 'the loot is still told');
  assert.deepEqual(visible()!.states, before.states, 'the old land’s state isn’t the new land’s');
  assert.equal(wildsView()!.materials.stone, 6, 'the balances are the account’s');
  assert.equal(applyLanterns([{ $typeName: 'glimway.v1.WildsLantern', id: 'fallen-lamp', ownerId: 'peer-account', displayName: 'Peer', x: 400, y: 300, litBy: 'me', at: 1, litAt: 2 }], old), false);
  assert.equal(wildsView()!.lanterns.get('fallen-lamp')!.litBy, 'fixture-account');
  assert.equal(applyEchoSettled('echo:0', old), false);
  assert.equal(wildsView()!.echoes.get('echo:0')!.settled, false);
  assert.equal(takeReadRequest(), true, 'the Wilds are read again');
});
