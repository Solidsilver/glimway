/**
 * What the world map loads (docs/design/world-map.md 2, 4): chunks at most
 * eight at a time, the same chunk reused while its ground holds, a chunk
 * that won't load keeping its last picture (or left blank), offline maps of
 * the land already read, an ended wick showing only the Tangle, and nothing
 * from another world or wick shown as current.
 */
import './helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { create, fromJson, type JsonValue } from '@bufbuild/protobuf';

const { WildsNearResultSchema, WildsMapStatusSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
const store = await import('../src/game/wilds/store.ts');
const { forgetFixed } = await import('../src/game/wilds/fixed.ts');
const { decodeChunk } = await import('../src/lib/api/chunks.ts');
const { lotAt } = await import('../src/lib/lots.ts');
const { forgetChunks } = await import('../src/game/wilds/chunks.ts');
const { loadMap, forgetMapData, forgetMapRead, MAP_LOAD_CONCURRENCY } = await import('../src/game/wilds/map-data.ts');
const { forgetWalked, markWalked } = await import('../src/game/wilds/walked.ts');
const { chunkAt } = await import('./wilds-fixture.ts');

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[];
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;
const WICK = NEAR.wick.id as string;

function start(edit: (j: Record<string, any>) => void = () => {}): void {
  store.resetWilds({ quiet: true });
  forgetChunks();
  forgetFixed();
  forgetMapData();
  forgetMapRead();
  forgetWalked();
  const j = structuredClone(NEAR);
  edit(j);
  store.applyNear(fromJson(WildsNearResultSchema, j as JsonValue));
  store.takeReadRequest();
  // The fixture's wick is long over by the wall clock: a wick still running.
  store.wildsView()!.wick.endsAt = Math.floor(Date.now() / 1000) + 3600;
}

/** A chunk API that counts how many loads run at once, and can refuse some. */
function chunkApi(o: { fail?: (cx: number, cy: number) => boolean } = {}) {
  const c = { calls: 0, running: 0, most: 0, near: 0 };
  const api = {
    mapStatus: async (_keys: readonly { cx: number; cy: number }[]) => create(WildsMapStatusSchema, { wick: store.wildsView()!.wick.id }),
    near: async () => {
      c.near++;
      throw new Error('offline');
    },
    chunk: async (epoch: string, _l: number, cx: number, cy: number) => {
      c.calls++;
      c.running++;
      c.most = Math.max(c.most, c.running);
      await new Promise((r) => setTimeout(r, 2));
      c.running--;
      if (o.fail?.(cx, cy)) throw new Error('no chunk');
      const m = epoch.startsWith('fixed:') ? decodeChunk(readFileSync(new URL(`./fixtures/hearthwick-${cx}-${cy}.bin`, import.meta.url))) : epoch.startsWith('plot:') ? decodeChunk(readFileSync(new URL(`./fixtures/plot-${lotAt(cx, cy)}.bin`, import.meta.url))) : chunkAt('whitequiet-0-5', cx, cy);
      m.epochId = epoch;
      return m;
    },
  };
  return { api, c };
}

const session = (api: unknown, o: { online?: boolean; world?: string; area?: string } = {}) =>
  ({ state: { area: o.area ?? 'outdoors', position: { x: 88, y: 968 } }, link: { online: o.online ?? true, status: (o.online ?? true) ? 'online' : 'offline', worldId: o.world ?? 'world-a', api: { operations: api } } }) as never;

/** Walk a block of Beyond chunks this wick. */
function walk(n: number): void {
  for (let i = 0; i < n; i++) markWalked(WICK, `${-4 + (i % 9)},${-8 + Math.floor(i / 9)}`);
}

test('a guest or an unread session gets the shell and a reason, not a map', async () => {
  store.resetWilds({ quiet: true });
  forgetMapData();
  assert.deepEqual(await loadMap({ state: { area: 'village' }, link: null } as never), { input: null, scope: '', missing: 'guest', offline: true, partial: false, ended: false, endsAt: null });
  const { api } = chunkApi();
  const got = await loadMap(session(api, { online: false }));
  assert.equal(got.missing, 'unread', 'offline and never read: it needs the Wilds read once');
  assert.equal(got.offline, true);
});

test('chunks load at most eight at a time, and an unchanged chunk is the same picture next time', async () => {
  start();
  walk(30);
  const { api, c } = chunkApi();
  const first = await loadMap(session(api));
  assert.ok(first.input && first.input.chunks.length >= 30);
  assert.ok(c.most <= MAP_LOAD_CONCURRENCY, `at most ${MAP_LOAD_CONCURRENCY} at once, saw ${c.most}`);
  assert.ok(c.most > 1, 'but more than one');
  assert.equal(first.scope, `world-a|${NEAR.still.id}|${WICK}`);
  const calls = c.calls;
  const again = await loadMap(session(api));
  assert.equal(c.calls, calls, 'chunks come from memory the second time');
  const byKey = (l: typeof first) => new Map(l.input!.chunks.map((ch) => [`${ch.cx},${ch.cy}`, ch]));
  const a = byKey(first);
  const b = byKey(again);
  for (const [k, ch] of a) assert.equal(b.get(k), ch, `the same chunk object (and revision) for ${k}`);
  // A path laid in one chunk: that chunk alone gets a new revision.
  store.predictGround(-2, -6, 6, 6, { tx: 6, ty: 6, change: 'stone', by: 'me', at: 1 } as never, { id: 'stone', delta: -1 });
  const laid = byKey(await loadMap(session(api)));
  assert.notEqual(laid.get('-2,-6')!.rev, a.get('-2,-6')!.rev);
  assert.equal(laid.get('-1,-6'), a.get('-1,-6'));
});

test('a chunk that fails keeps its last picture this wick; one never loaded is blank and the map says it’s partial', async () => {
  start();
  walk(12);
  const good = chunkApi();
  const first = await loadMap(session(good.api));
  assert.equal(first.partial, false);
  const n = first.input!.chunks.length;
  // Memory forgets them (a reload), and now two chunks fail: the snapshot keeps them.
  forgetChunks();
  const bad = chunkApi({ fail: (cx, cy) => cx === -4 && (cy === -8 || cy === -7) });
  const second = await loadMap(session(bad.api));
  assert.equal(second.input!.chunks.length, n, 'nothing cleared');
  assert.equal(second.partial, false);
  // A fresh session (no snapshot): the failed chunks are blank, the rest drawn.
  forgetMapData();
  forgetChunks();
  const third = await loadMap(session(bad.api));
  assert.equal(third.partial, true);
  assert.equal(third.input!.chunks.length, n - 2);
});

test('offline with the Wilds read: the land already read, zoomable, said to be offline', async () => {
  start();
  walk(6);
  const { api } = chunkApi();
  await loadMap(session(api));
  const off = await loadMap(session(api, { online: false }));
  assert.equal(off.offline, true);
  assert.equal(off.ended, false);
  assert.ok(off.input!.chunks.length >= 6);
});

test('a wick that ended with no read since: only the Tangle, no Beyond, no ways or finds, and a read is needed', async () => {
  start();
  walk(9);
  const { api, c } = chunkApi();
  const live = await loadMap(session(api));
  assert.ok(live.input!.ways.length > 0 && live.input!.glimpse.length > 0);
  store.wildsView()!.wick.endsAt = 1;
  const ended = await loadMap(session(api, { online: false }));
  assert.equal(c.near, 0, 'offline: no read tried');
  assert.equal(ended.ended, true);
  const tangle = new Set(['-1,-2', '0,-2', '1,-2', '-1,-1', '0,-1', '1,-1', '-1,0', '0,0', '1,0']);
  assert.ok(ended.input!.chunks.length > 0);
  for (const ch of ended.input!.chunks) assert.ok(tangle.has(`${ch.cx},${ch.cy}`), `${ch.cx},${ch.cy} is the Tangle`);
  assert.deepEqual(ended.input!.ways, []);
  assert.deepEqual(ended.input!.glimpse, []);
  assert.deepEqual(ended.input!.places.filter((p) => p.foundBy), []);
});

test('another world or another wick is another map: nothing carried over', async () => {
  start();
  walk(9);
  const { api } = chunkApi();
  const a = await loadMap(session(api, { world: 'world-a' }));
  forgetChunks();
  // The same epochs named in another world (never happens on a server, but the map mustn't trust it).
  const fail = chunkApi({ fail: () => true });
  const b = await loadMap(session(fail.api, { world: 'world-b' }));
  assert.notEqual(a.scope, b.scope);
  assert.equal(b.input!.chunks.length, 0, 'world-a’s snapshot is not world-b’s land');
  assert.equal(b.partial, true);
  // The next wick: walked land starts over and the old wick's snapshot isn't used.
  start((j) => (j.wick.id = 'wick-2'));
  const c2 = await loadMap(session(fail.api, { world: 'world-b' }));
  assert.ok(c2.scope.endsWith('|wick-2'));
  assert.equal(c2.input!.chunks.length, 0);
});

/** A chunk API whose answers wait until `release()`. */
function heldApi() {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const c = { asked: 0 };
  const api = {
    mapStatus: async (_keys: readonly { cx: number; cy: number }[]) => create(WildsMapStatusSchema, { wick: store.wildsView()!.wick.id }),
    near: async () => {
      throw new Error('offline');
    },
    chunk: async (epoch: string, _l: number, cx: number, cy: number) => {
      c.asked++;
      await gate;
      const m = epoch.startsWith('fixed:') ? decodeChunk(readFileSync(new URL(`./fixtures/hearthwick-${cx}-${cy}.bin`, import.meta.url))) : epoch.startsWith('plot:') ? decodeChunk(readFileSync(new URL(`./fixtures/plot-${lotAt(cx, cy)}.bin`, import.meta.url))) : chunkAt('whitequiet-0-5', cx, cy);
      m.epochId = epoch;
      return m;
    },
  };
  return { api, c, release: () => open() };
}

/** Name new epochs in the store without forgetting the map's caches (what a real switch or turning does). */
function storeNames(edit: (j: Record<string, any>) => void): void {
  store.resetWilds({ quiet: true });
  const j = structuredClone(NEAR);
  edit(j);
  store.applyNear(fromJson(WildsNearResultSchema, j as JsonValue));
  store.takeReadRequest();
  store.wildsView()!.wick.endsAt = Math.floor(Date.now() / 1000) + 3600;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('a load overtaken by another world never writes into, nor reads from, the new world’s snapshot', async () => {
  start();
  walk(9);
  const held = heldApi();
  const a = loadMap(session(held.api, { world: 'world-a' }));
  await tick();
  assert.ok(held.c.asked > 0, 'world A’s chunks are on their way');
  // Another world, with its own epochs; its chunks won't load at all.
  storeNames((j) => {
    j.still.id = 'still-B';
    j.wick.id = 'wick-B';
  });
  for (let i = 0; i < 9; i++) markWalked('wick-B', `${-4 + i},-8`);
  const fail = chunkApi({ fail: () => true });
  const b1 = await loadMap(session(fail.api, { world: 'world-b' }));
  assert.equal(b1.input!.chunks.length, 0);
  // World A's chunks arrive late.
  held.release();
  const late = await a;
  forgetChunks();
  const b2 = await loadMap(session(fail.api, { world: 'world-b' }));
  assert.equal(b2.input!.chunks.length, 0, 'nothing of world A’s in world B’s snapshot');
  assert.equal(b2.partial, true);
  assert.equal(late.superseded, true, 'A’s load says it was overtaken');
  assert.equal(late.input, null, 'and shows nothing');
});

test('a turning during a load (the map closed and opened again on the new wick) mixes no epochs and leaks nothing', async () => {
  start();
  walk(9);
  const held = heldApi();
  const old = loadMap(session(held.api));
  await tick();
  // The Beyond turns while the map is closed; it's opened again on the new wick and loads.
  storeNames((j) => (j.wick.id = 'wick-2'));
  for (let i = 0; i < 4; i++) markWalked('wick-2', `${-4 + i},-8`);
  const good = chunkApi();
  const fresh = await loadMap(session(good.api));
  assert.ok(fresh.scope.endsWith('|wick-2'));
  const n = fresh.input!.chunks.length;
  for (const ch of fresh.input!.chunks) assert.doesNotMatch(ch.rev!, new RegExp(WICK), 'no chunk of the old wick');
  held.release();
  const stale = await old;
  assert.equal(stale.superseded, true);
  // The new wick's snapshot holds only its own: a failing load gives back the same chunks, no more.
  forgetChunks();
  const again = await loadMap(session(chunkApi({ fail: () => true }).api));
  assert.equal(again.input!.chunks.length, n);
  for (const ch of again.input!.chunks) assert.doesNotMatch(ch.rev!, new RegExp(WICK));
});

test('indoor hero map-dot resolves to the exterior door on hearthwick or lot doorstep', async () => {
  const { mapHeroTile } = await import('../src/game/wilds/map-data.ts');
  assert.deepEqual(mapHeroTile('in:home:0'), { tx: -37, ty: 32 });
  assert.deepEqual(mapHeroTile('in:village:bakery'), { tx: 6, ty: 53 });
  assert.deepEqual(mapHeroTile('in:village:mill'), { tx: 21, ty: 103 });
  assert.deepEqual(mapHeroTile('in:village:mill:2'), { tx: 21, ty: 103 }, 'nested mill loft resolves through ground mill');
  assert.deepEqual(mapHeroTile('in:commons:yard:deeds'), { tx: 23, ty: 58 }, 'land office has its own town door');
  assert.deepEqual(mapHeroTile('outdoors', { x: 64, y: 32 }), { tx: 4, ty: 2 });
  assert.equal(mapHeroTile('unknown-area'), null);
});



test('status requests contain only known terrain; offline and expired maps reuse no new knowledge', async () => {
  start();
  markWalked(WICK,'2,-4');
  const { api } = chunkApi();
  let calls=0; let asked: { cx: number; cy: number }[] = [];
  const { create } = await import('@bufbuild/protobuf');
  const { WildsMapStatusSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
  api.mapStatus = async (keys) => {
    calls++; asked=[...keys];
    return create(WildsMapStatusSchema, { wick: WICK, chunks: [{ chunk: { realm: 'hearthwick',cx:2,cy:-4 },tier:'common',visited:true,nextTurning:'carries',ground:{changes:[{tx:3,ty:14,change:'stone',by:'builder',at:1}]} }] });
  };
  const live=await loadMap(session(api));
  assert.equal(calls,1);
  assert.ok(asked.some((k) => k.cx===2 && k.cy===-4));
  assert.ok(asked.every((k) => (k.cx===2 && k.cy===-4) || (k.cx>=-1 && k.cx<=1 && k.cy>=-2 && k.cy<=0)),'the near window is never treated as explored');
  assert.equal(live.input!.land!.find((s) => s.tier==='common')!.visited,true);
  await loadMap(session(api));assert.equal(calls,1,'same knowledge and version reuses the status read');
  const offline=await loadMap(session(api,{online:false}));
  assert.equal(calls,1);assert.equal(offline.input!.land!.length,live.input!.land!.length);
  store.wildsView()!.wick.endsAt=1;
  const ended=await loadMap(session(api,{online:false}));
  assert.deepEqual(ended.input!.land,[]);assert.deepEqual(ended.input!.lamps,[]);
});
