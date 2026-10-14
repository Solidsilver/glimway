/**
 * The open map's operations against the store, in order and by identity
 * (O-E round 1, review findings 1 to 9): a lost answer keeps its prediction
 * and its replay settles it; a near read can't undo a newer answer nor count
 * a committed debit twice; answers for land that has turned aren't applied;
 * refusals ask for a fresh read; the rumour's bundle isn't sent under the
 * next wick; the Map reads an ended wick again; a way someone else broke
 * goes; touch buttons press once; a plank across a chunk edge turns to meet
 * its neighbour.
 */
import './helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';

const { WildsNearResultSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
const store = await import('../src/game/wilds/store.ts');
const ops = await import('../src/game/wilds/ops.ts');
const { forgetChunks, loadChunk } = await import('../src/game/wilds/chunks.ts');
const { pathTileAt } = await import('../src/game/wilds/path-tile.ts');
const { WildsPaths } = await import('../src/game/wilds/paths.ts');
const { openRumourFind } = await import('../src/game/wilds/rumour-find.ts');
const { loadMap, forgetMapRead } = await import('../src/game/wilds/map-data.ts');
const { pressGate, CLICK_AFTER_DOWN_MS } = await import('../src/ui/press-gate.ts');
const { AttachedChunk, BuildQueue } = await import('../src/game/wilds/window-chunk.ts');
const { TERRAIN } = await import('../src/lib/tile.ts');
const { loadWilds } = await import('../src/lib/wilds/data.ts');
const { EV, bus } = await import('../src/game/events.ts');
const { chunkAt } = await import('./wilds-fixture.ts');
const { rig, online, S, env, tick } = await import('./helpers/link-rig.ts');

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[];
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;
const fresh = (edit: (j: Record<string, any>) => void = () => {}) => {
  const j = structuredClone(NEAR);
  edit(j);
  return fromJson(WildsNearResultSchema, j as JsonValue);
};
const WICK = NEAR.wick.id as string;
/** The chunk (-2, -4)'s changes with a stone at (5, 5) by `me`, in `epoch`. */
const stoneAt55 = (epoch = WICK) => ({ $typeName: 'glimway.v1.ChunkGroundChanges', chunk: { $typeName: 'glimway.v1.WildsChunkKey', realm: 'hearthwick', layer: 0, cx: -2, cy: -4 }, epoch, changes: { $typeName: 'glimway.v1.GroundChanges', changes: [{ $typeName: 'glimway.v1.GroundChange', tx: 5, ty: 5, change: 'stone', by: 'me', at: 1 }] } }) as never;
const change55 = { tx: 5, ty: 5, change: 'stone', by: 'me', at: 1 } as never;

function start(): void {
  store.resetWilds({ quiet: true });
  forgetChunks();
  ops.forgetOps();
  store.applyNear(fresh((j) => (j.ground = [])));
  store.takeReadRequest();
}

const settled = (r: { events: Array<[string, unknown]> }) => r.events.filter(([e]) => e === EV.wildsSettled).map(([, p]) => p as never);

// ------------------------------------------------------------ 1. a lost answer, its replay

test('a lay whose answer is lost keeps showing; its replay (same key) settles it with the server’s ground and balances', async (t) => {
  start();
  assert.equal(store.wildsMaterials()!.stone, 4);
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/wilds/lay', 'network');
  const token = store.predictGround(-2, -4, 5, 5, change55, { id: 'stone', delta: -1 });
  ops.trackOp({ key: 'lay-1', kind: 'lay', world: r.link.worldId, wick: WICK, epoch: WICK, cx: -2, cy: -4, token, material: 'stone' });
  const answer = await r.link.wildsPath('lay', { epoch: WICK, x: -43, y: -91, kind: 'stone', where: { area: 'outdoors', x: -680, y: -1448 }, key: 'lay-1' });
  assert.deepEqual(answer, { ok: false, code: 'pending' });
  assert.deepEqual(settled(r), [], 'pending is no outcome');
  assert.ok(ops.tracked('lay-1'));
  assert.equal(store.wildsMaterials()!.stone, 3, 'the prediction stays while the outbox holds it');
  assert.equal(store.groundChanges(-2, -4).length, 1);
  // Back online: the outbox replays the same key, and its answer reaches the store.
  const result = structuredClone((fixtures.find((f) => f.case === 'wilds-lay-way')!.json as Record<string, any>).wildsLay);
  result.ground = { chunk: { realm: 'hearthwick', layer: 0, cx: -2, cy: -4 }, epoch: WICK, changes: { changes: [{ tx: 5, ty: 5, change: 'stone', by: 'me', at: 1 }] } };
  result.waysMade = [];
  result.materials = { stone: 3 };
  r.server.on('GET /api/state', { body: { state: S({ version: 10 }), leaseActive: true } });
  r.server.on('POST /api/wilds/lay', env(S({ version: 11 }), { wildsLay: result }));
  await r.link.reconnect(false);
  await r.link.flush();
  assert.equal(r.link.outbox.length, 0);
  const sent = r.server.sent('POST /api/wilds/lay');
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.body.epoch, WICK, 'the captured epoch is sent');
  assert.equal(sent[1]!.body.epoch, WICK, 'retry keeps the captured epoch');
  assert.equal(sent[0]!.body.op.key, sent[1]!.body.op.key, 'one key, so the server does it once');
  const events = settled(r);
  assert.equal(events.length, 1);
  for (const e of events) ops.settleWildsOp(e);
  assert.equal(ops.tracked('lay-1'), false);
  assert.equal(store.wildsMaterials()!.stone, 3, 'the server’s balance, counted once');
  assert.deepEqual(store.groundChanges(-2, -4).map((c) => [c.tx, c.ty, c.change]), [[5, 5, 'stone']]);
});

test('a replay nobody tracks (sent before a reload) asks for a fresh read rather than guessing', () => {
  start();
  ops.settleWildsOp({ kind: 'wilds-lay', key: 'from-before-the-reload', world: 'w', outcome: { ok: true, result: {} } });
  assert.equal(store.takeReadRequest(), true);
  ops.settleWildsOp({ kind: 'wilds-lay', key: 'dropped-unsent', world: 'w', outcome: { ok: false, code: 'offline' } });
  assert.equal(store.takeReadRequest(), false, 'never sent: nothing to read');
});

test('a discover whose answer is lost is never asked again under a new key while it is unresolved', async (t) => {
  start();
  const r = await rig(t);
  await online(r);
  r.server.on('POST /api/wilds/discover', 'network');
  const session = { link: r.link, state: { area: 'outdoors', position: { x: 0, y: 0 } } } as never;
  assert.equal(ops.mayAsk('place:1:-1'), true);
  await ops.discoverPlace(session, { id: 'place:1:-1', cx: 2, cy: -4 }, { x: 0, y: 0 });
  assert.equal(r.server.sent('POST /api/wilds/discover').length, 1);
  assert.equal(ops.asking('place:1:-1'), true);
  assert.equal(ops.mayAsk('place:1:-1'), false, 'its replay will settle it');
});

// ------------------------------------------------------------ 2. order

test('a near read asked before an answer landed cannot undo it', () => {
  start();
  const since = store.readMark();
  const older = fresh((j) => (j.ground = []));
  assert.equal(store.applyPathAnswer(stoneAt55(), { stone: 3 }), true);
  store.applyNear(older, since);
  assert.equal(store.wildsMaterials()!.stone, 3, 'the answer’s balance stands');
  assert.ok(store.groundChanges(-2, -4).some((c) => c.tx === 5 && c.ty === 5), 'and its stone');
  // A read asked after the answer is the newest word again.
  store.applyNear(fresh((j) => (j.ground = [])), store.readMark());
  assert.equal(store.wildsMaterials()!.stone, 4);
});

test('a near read that already holds a pending lay’s stone doesn’t count its debit twice', () => {
  start();
  const lay = store.predictGround(-2, -4, 5, 5, change55, { id: 'stone', delta: -1 });
  assert.equal(store.wildsMaterials()!.stone, 3);
  store.applyNear(fresh((j) => {
    j.materials = { stone: 3 };
    j.ground = [{ chunk: { realm: 'hearthwick', layer: 0, cx: -2, cy: -4 }, epoch: WICK, changes: { changes: [{ tx: 5, ty: 5, change: 'stone', by: 'me', at: 1 }] } }];
  }));
  assert.equal(store.wildsMaterials()!.stone, 3, 'committed: the read’s 3, not 2');
  store.settlePrediction(lay);
  // A pending lift whose tile the read no longer shows: its refund is in the read too.
  const lift = store.predictGround(-2, -4, 5, 5, null, { id: 'stone', delta: 1 }, 'me');
  store.applyNear(fresh((j) => {
    j.materials = { stone: 4 };
    j.ground = [];
  }));
  assert.equal(store.wildsMaterials()!.stone, 4);
  store.settlePrediction(lift);
});

// ------------------------------------------------------------ 3. identity

test('an answer for land that has turned is not applied; the Wilds are read again', () => {
  start();
  store.applyNear(fresh((j) => {
    j.wick.id = 'next-wick';
    j.ground = [];
    j.ways = [];
    j.discoveries = [];
  }));
  assert.equal(store.applyPathAnswer(stoneAt55('wick-epoch'), { stone: 3 }), false);
  assert.equal(store.groundChanges(-2, -4).length, 0, 'no old stone on the new land');
  assert.equal(store.applyDiscovery({ entityId: 'place:-1:-2', poiId: 'camp-glade', discovererId: 'old', displayName: 'Old finder' }, WICK), false);
  assert.equal(store.wildsView()!.discoveries.has('place:-1:-2'), false);
  // Through the registry: an op made in the old wick settles without touching the new one.
  ops.trackOp({ key: 'old', kind: 'lay', world: 'w', wick: WICK, epoch: WICK, cx: -2, cy: -4, token: null, material: 'stone' });
  ops.settleWildsOp({ kind: 'wilds-lay', key: 'old', world: 'w', outcome: { ok: true, result: { $typeName: 'glimway.v1.WildsLayResult', ground: stoneAt55(), materials: { stone: 3 }, waysMade: [] } } });
  assert.equal(store.groundChanges(-2, -4).length, 0);
  assert.equal(store.wildsMaterials()!.stone, 4, 'old balances aren’t laid over the new read');
  assert.equal(store.takeReadRequest(), true, 'the balances are read again');
  ops.trackOp({ key: 'old-find', kind: 'discover', world: 'w', wick: WICK, epoch: WICK, cx: -2, cy: -4, token: null, place: 'place:-1:-2' });
  ops.settleWildsOp({ kind: 'wilds-discover', key: 'old-find', world: 'w', outcome: { ok: true, result: { epoch: WICK, first: true, discovery: { entityId: 'place:-1:-2', poiId: 'camp-glade', discovererId: 'old', displayName: 'Old finder' }, loot: { materials: [] }, materials: {} } } });
  assert.equal(store.wildsView()!.discoveries.has('place:-1:-2'), false);
});

/** A tile in chunk (-2, -4) where a stone can go. */
async function layable(): Promise<{ tx: number; ty: number }> {
  const api = { chunk: async (epoch: string, _l: number, cx: number, cy: number) => {
    const m = chunkAt('whitequiet-0-4', cx, cy);
    m.epochId = epoch;
    return m;
  } };
  await loadChunk(api, WICK, -2, -4);
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      const t = pathTileAt(-48 + x, -96 + y);
      if (t && !t.baseSolid && !t.change && !t.occupied && t.surface === 'land' && t.decor.length === 0) return { tx: -48 + x, ty: -96 + y };
    }
  throw new Error('no open tile');
}

function scenePaths(link: Record<string, unknown>, hero: { x: number; y: number }) {
  const session = { link: { status: 'online', accountId: 'me', worldId: 'w', ...link }, state: { area: 'outdoors', position: hero } };
  const scene = { input: { keyboard: null }, events: { once() {} } };
  return new WildsPaths(scene as never, { session: session as never, interactables: { register() {} } as never, fx: { sparkBurst() {} } as never, reducedMotion: true, hero: () => ({ sprite: hero, facing: { x: 1, y: 0 } }), notePosition() {}, live: () => true });
}

test('jobs queued in a wick that has ended are never sent', async () => {
  start();
  const at = await layable();
  const sent: unknown[] = [];
  let release: (v: unknown) => void = () => {};
  const paths = scenePaths({ wildsPath: (_op: string, req: unknown) => (sent.push(req), new Promise((r) => (release = r))) }, { x: at.tx * 16 + 8, y: at.ty * 16 + 8 });
  paths.onAction(`lay:stone:${at.tx}:${at.ty}`);
  paths.onAction(`lay:stone:${at.tx + 1}:${at.ty}`);
  await tick();
  assert.equal(sent.length, 1);
  // The wick turns while the first is out.
  store.applyNear(fresh((j) => {
    j.wick.id = 'next-wick';
    j.ground = [];
  }));
  release({ ok: false, code: 'too-far-away' });
  await tick();
  await tick();
  assert.equal(sent.length, 1, 'the second, from the ended wick, is dropped unsent');
  assert.equal(paths.debug().queued, 0);
});

// ------------------------------------------------------------ 4. refusals that disprove the store

test('a refusal that shows the pack or the tile was wrong takes the prediction back and asks for a fresh read', async () => {
  start();
  const at = await layable();
  const paths = scenePaths({ wildsPath: async () => ({ ok: false, code: 'insufficient-materials' }) }, { x: at.tx * 16 + 8, y: at.ty * 16 + 8 });
  paths.onAction(`lay:stone:${at.tx}:${at.ty}`);
  await tick();
  await tick();
  assert.equal(paths.debug().last, 'refused:insufficient-materials');
  assert.equal(store.wildsMaterials()!.stone, 4, 'the prediction is gone');
  assert.equal(store.takeReadRequest(), true, 'and the server is asked what the pack holds');
  // A step too far proves nothing about the store.
  const far = scenePaths({ wildsPath: async () => ({ ok: false, code: 'too-far-away' }) }, { x: at.tx * 16 + 8, y: at.ty * 16 + 8 });
  far.onAction(`lay:stone:${at.tx}:${at.ty}`);
  await tick();
  await tick();
  assert.equal(store.takeReadRequest(), false);
});

// ------------------------------------------------------------ 5. the rumour's bundle across the turning

test('the rumour’s bundle is not claimed under the next wick when the fresh read names one', async () => {
  start();
  let claimed: unknown = null;
  const turned = fresh((j) => {
    j.wick.id = 'next-wick';
    j.ground = [];
    j.ways = [];
    j.discoveries = [];
    j.personalClaims = [];
  });
  const api = { near: async () => turned, chunk: async (epoch: string, _l: number, cx: number, cy: number) => {
    const m = chunkAt('whitequiet-0-4', cx, cy);
    m.epochId = epoch;
    return m;
  } };
  const session = { state: { area: 'outdoors' }, link: { status: 'online', api: { operations: api }, wildsClaim: async (req: unknown) => ((claimed = req), { ok: false, code: 'entity-not-found' }) } };
  const turnings: unknown[] = [];
  const onTurning = (p: unknown) => turnings.push(p);
  bus.on(EV.turning, onTurning);
  const r = await openRumourFind(session as never, { id: 'rumour:-2:-4', cx: -2, cy: -4 }, WICK, { x: 0, y: 0 });
  bus.off(EV.turning, onTurning);
  assert.deepEqual(r, { ok: false, why: 'turned' });
  assert.equal(claimed, null, 'nothing sent');
});

// ------------------------------------------------------------ 6. the Map and an ended wick

test('the Map reads an ended or stale wick again before drawing, once in a while, not in a loop', async () => {
  start();
  forgetMapRead();
  store.wildsView()!.wick.endsAt = 1;
  let reads = 0;
  const api = {
    near: async () => {
      reads++;
      return fresh((j) => (j.wick.id = 'next-wick'));
    },
    chunk: async (epoch: string, _l: number, cx: number, cy: number) => {
      const m = chunkAt('tangle', cx, cy);
      m.epochId = epoch;
      return m;
    },
  };
  const session = { state: { area: 'village' }, link: { online: true, status: 'online', api: { operations: api } } };
  const first = await loadMap(session as never);
  assert.ok(first.input);
  assert.equal(reads, 1, 'the village visit’s Map reads the current wick');
  assert.equal(store.wildsEpoch('wick').id, 'next-wick');
  store.wildsView()!.stale = true;
  await loadMap(session as never);
  assert.equal(reads, 1, 'the map redrawing on the read’s own news doesn’t read again at once');
});

// ------------------------------------------------------------ 7. a way someone else broke

test('a near read that no longer names a way crossing its window drops it; ways elsewhere stay', () => {
  start();
  store.applyNear(fresh(), store.readMark());
  const fixtureWay = [...store.wildsView()!.ways.keys()][0]!;
  const far = { $typeName: 'glimway.v1.WildsWay', id: 'way:place:3:-3:place:4:-3', a: 'place:3:-3', b: 'place:4:-3', name: 'Far way', by: 'x', tiles: 3, epoch: WICK, at: 1, path: [{ x: 200, y: -180 }, { x: 201, y: -180 }, { x: 202, y: -180 }], signA: undefined, signB: undefined } as never;
  store.applyPathAnswer(undefined, { stone: 4 }, { made: [far] });
  // Someone else lifted a tile of the fixture's way: the same window, read again, without it.
  store.applyNear(fresh((j) => (j.ways = [])), store.readMark());
  assert.equal(store.wildsView()!.ways.has(fixtureWay), false, 'the broken way goes');
  assert.equal(store.wildsView()!.ways.has('way:place:3:-3:place:4:-3'), true, 'a way outside the window stays');
});

// ------------------------------------------------------------ 8. touch buttons

test('a touch button presses on pointerdown, lets its echo click pass, and presses on a click with no pointer', () => {
  let now = 0;
  const gate = pressGate(() => now);
  assert.equal(gate.down('path-lay-stone'), true);
  now += 120;
  assert.equal(gate.click('path-lay-stone'), false, 'the click after a tap is its echo');
  now += 50;
  assert.equal(gate.click('path-lay-stone'), true, 'Enter, Space, assistive tech');
  assert.equal(gate.down('path-lift'), true);
  now += CLICK_AFTER_DOWN_MS + 1;
  assert.equal(gate.click('path-lift'), true, 'a click long after is its own press');
  assert.equal(gate.down('a'), true);
  assert.equal(gate.click('b'), true, 'another button’s click is its own');
});

// ------------------------------------------------------------ 9. planks across a chunk edge

test('a plank laid across a chunk edge turns its neighbour in the next chunk to meet it', () => {
  const plank = (TERRAIN as Record<string, number>)[loadWilds().grounds.find((g) => g.id === 'laid-plank')!.terrain]!;
  const blank = (cx: number) => ({ epochId: 'e', cx, cy: 0, size: 24, ground: Array.from({ length: 24 }, () => Array(24).fill(0)), solid: Array.from({ length: 24 }, () => Array(24).fill(false)), decor: [], sites: [], entities: [], places: [], look: 'tangle', mark: null, tier: 1, land: 'woods' });
  const world = new Map([['23,5', plank]]);
  const image = (key: string) => {
    const img = { texture: { key }, setOrigin: () => img, setDepth: () => img, setTexture: (k: string) => ((img.texture.key = k), img), destroy() {} };
    return img;
  };
  const children = { list: [] as unknown[], addChildCallback() {}, removeChildCallback() {} };
  const scene = { add: { image: (_x: number, _y: number, key: string) => image(key) }, make: { image: (c: { key: string }) => image(c.key) }, children, textures: { exists: () => true } };
  const deps = { scene, ground: { ground: (x: number, y: number) => world.get(`${x},${y}`) ?? 0, solid: () => false }, entities: { attach() {}, detach() {} }, gathering: () => null, occluders: { add() {}, remove() {} }, tileArt: { fell: () => [], take: () => [], keep() {} }, solids: { add() {}, remove() {} }, reducedMotion: true, gather: () => [] };
  const westTerrain = blank(0);
  westTerrain.ground[5]![23] = plank;
  const west = new AttachedChunk(deps as never, westTerrain as never, 'west');
  const east = new AttachedChunk(deps as never, blank(1) as never, 'east');
  assert.match(west.laidArtKeys().get('23,5')!, /path-plank-v/, 'alone, a plank runs along');
  world.set('24,5', plank);
  const next = blank(1);
  next.ground[5]![0] = plank;
  const chunks = new Map([['0,0', west], ['1,0', east]]);
  assert.equal(east.patch(next as never, (tx, ty) => chunks.get(`${Math.floor(tx / 24)},${Math.floor(ty / 24)}`)?.relay(tx, ty)), true);
  assert.match(east.laidArtKeys().get('24,5')!, /path-plank-h/);
  assert.match(west.laidArtKeys().get('23,5')!, /path-plank-h/, 'the west chunk’s plank turns to meet it');
});

test('chunks are built in the order they were attached, and finishing one early finishes the ones before it first', () => {
  const log: string[] = [];
  // A chunk built a slice at a time: `slices` steps, one per call while time is left.
  const chunk = (name: string, slices: number) => ({
    name,
    left: slices,
    build(deadline: number) {
      while (this.left > 0) {
        this.left--;
        log.push(name);
        if (deadline !== Infinity) return this.left === 0;
      }
      return true;
    },
  });
  const q = new BuildQueue();
  const [a, b, c] = [chunk('a', 3), chunk('b', 2), chunk('c', 2)];
  q.add(a);
  q.add(b);
  q.add(c);
  q.step(0);
  assert.deepEqual(log, ['a'], 'a slice of the first attached');
  // A patch (or a relay) needs b whole now: a finishes first, then b; c waits its turn.
  q.finish(b);
  assert.deepEqual(log, ['a', 'a', 'a', 'b', 'b']);
  q.finish(b);
  assert.equal(log.length, 5, 'finishing a chunk already whole builds nothing');
  q.drop(c);
  q.step(Infinity);
  assert.equal(log.length, 5, 'a dropped chunk is never built further');
});


test('generated builds stop between stages when the slice expires', (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const c = Object.create(AttachedChunk.prototype) as InstanceType<typeof AttachedChunk>;
  const ran: string[] = [];
  c['todo'] = [() => { ran.push('scenery'); clock += 5; return true; }, () => { ran.push('gathering'); return true; }];
  assert.equal(c.build(0), false);
  assert.deepEqual(ran, [], 'an expired slice starts nothing');
  assert.equal(c.build(4), false);
  assert.deepEqual(ran, ['scenery'], 'gathering waits after scenery uses the slice');
  assert.equal(c.build(Infinity), true);
  assert.deepEqual(ran, ['scenery', 'gathering']);
});
