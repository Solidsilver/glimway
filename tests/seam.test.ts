/**
 * The Commons–Tangle join on the client (docs/design/location-seam.md 4, 6
 * lane S5): the Commons' fixed chunks attach to the open map's window and
 * detach again leaving nothing behind (display objects, tweens, static
 * bodies, textures, interaction points, workable pieces, occluders, tile
 * art, bus listeners); every object belongs to one chunk; the homestead
 * layer's lane fixtures come and go with the chunk that owns them; ground on
 * fixed chunks answers the scene's lookups (pocket-safe); and safe ground's
 * edge is the zero-HP barrier.
 */
import './helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Phaser is a stub in node tests: give it what a fixed chunk's collision and glows touch.
const Phaser = (await import('phaser')).default as Record<string, unknown>;
class FakeObject {
  alive = true;
  body: unknown;
  data = new Map<string, unknown>();
  width = 64;
  height = 64;
  scene: FakeScene | null;
  x: number;
  y: number;
  texture: { key: string };
  type: string;
  constructor(scene: FakeScene | null, x = 0, y = 0, texture = { key: '' }, type = 'Image') {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.texture = texture;
    this.type = type;
  }
  setOrigin() { return this; }
  setDepth() { return this; }
  setFlipX() { return this; }
  setTint() { return this; }
  clearTint() { return this; }
  setScale() { return this; }
  setAlpha() { return this; }
  setAngle() { return this; }
  setBlendMode() { return this; }
  setVisible() { return this; }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  play() { return this; }
  setDisplaySize() { return this; }
  setData(k: string, v: unknown) { this.data.set(k, v); return this; }
  getData(k: string) { return this.data.get(k); }
  getBounds() { return { contains: () => false }; }
  on() { return this; }
  off() { return this; }
  destroy() {
    if (!this.alive) return;
    this.alive = false;
    const list = this.scene?.children.list;
    const i = list ? list.indexOf(this) : -1;
    if (i >= 0) list!.splice(i, 1);
  }
}
Phaser.Physics = { Arcade: { Image: class extends FakeObject { constructor(_s: unknown, x: number, y: number) { super(null, x, y, { key: 'px' }, 'Body'); } }, StaticBody: class { enable = true; } } };
Phaser.BlendModes = { ADD: 1 };

const { FixedChunk } = await import('../src/game/wilds/fixed-chunk.ts');
const { footprint, forgetFixed, fixedSolidAt, fixedGroundAt, fixedStand, anchorTile, commonsLane, chunkOfTile, objectOut } = await import('../src/game/wilds/fixed.ts');
const { outdoorStandAt, outdoorSolidAt, gridBounds, waitingFixedAt } = await import('../src/game/wilds/wilds-world.ts');
const { WildsWindow, onWindow, gridDistance } = await import('../src/game/wilds/window.ts');
const { BuildQueue } = await import('../src/game/wilds/window-chunk.ts');
const { TileArt } = await import('../src/game/area/tile-art.ts');
const { refreshLanternVisuals } = await import('../src/game/area/lanterns.ts');
const { HomesteadArt } = await import('../src/game/entities/homestead-art.ts');
const { chunkCacheKey, forgetChunks } = await import('../src/game/wilds/chunks.ts');
const { fixedEpoch } = await import('../src/lib/api/chunks.ts');
const { at, onGrid } = await import('../src/lib/location.ts');
const { bus, EV } = await import('../src/game/events.ts');
const { serveFixtureCommons, COMMONS_PLACE } = await import('./commons-fixture.ts');
const { TILE } = await import('../src/lib/tile.ts');
const { holdOnSafe, stopAtEdge } = await import('../src/game/safe-barrier.ts');

/** A scene as far as a fixed chunk and the lane's fixtures touch it, counting what they leave. */
class FakeScene {
  children = { list: [] as FakeObject[], addChildCallback() {}, removeChildCallback() {} };
  tweens = {
    live: [] as { targets: unknown[] }[],
    add: (cfg: { targets: unknown }) => {
      const t = { targets: Array.isArray(cfg.targets) ? cfg.targets : [cfg.targets] };
      this.tweens.live.push(t);
      return t;
    },
    killTweensOf: (o: unknown) => {
      this.tweens.live = this.tweens.live.filter((t) => !t.targets.includes(o));
    },
  };
  textures = {
    added: [] as string[],
    exists: (_key?: string) => true,
    get: () => ({ customData: { density: 0 }, has: () => true, get: () => ({ height: 32, width: 32 }) }),
    addCanvas: (key: string) => this.textures.added.push(key),
    remove: (key: string) => { const i = this.textures.added.indexOf(key); if (i >= 0) this.textures.added.splice(i, 1); },
  };
  events = new EventEmitter();
  sys = { isActive: () => true };
  anims = { exists: () => false };
  timers = new Set<unknown>();
  time = {
    addEvent: () => {
      const timer = { remove: () => this.timers.delete(timer) };
      this.timers.add(timer);
      return timer;
    },
    delayedCall: () => ({ remove() {} }),
  };
  bodies = new Set<unknown>();
  physics = {
    world: { add: (b: unknown) => this.bodies.add(b) },
    add: { existing: (o: FakeObject) => ((o.body = { enable: true }), this.bodies.add(o.body), o) },
  };
  solids = {
    children: undefined,
    members: new Set<FakeObject>(),
    add: (o: FakeObject) => this.solids.members.add(o),
    remove: (o: FakeObject) => {
      this.solids.members.delete(o);
      this.bodies.delete(o.body);
    },
  };
  add = {
    image: (x: number, y: number, key: string) => this.put(new FakeObject(this, x, y, { key })),
    sprite: (x: number, y: number, key: string) => this.put(new FakeObject(this, x, y, { key }, 'Sprite')),
    rectangle: (x: number, y: number) => this.put(new FakeObject(this, x, y, { key: '' }, 'Rectangle')),
    text: (x: number, y: number) => this.put(new FakeObject(this, x, y, { key: '' }, 'Text')),
    existing: (o: FakeObject) => this.put(o),
  };
  make = {
    image: (c: { x: number; y: number; key: string }, add = true) => {
      const o = new FakeObject(this, c.x, c.y, { key: c.key });
      return add ? this.put(o) : o;
    },
  };
  private put(o: FakeObject): FakeObject {
    this.children.list.push(o);
    return o;
  }
}

/** The footprint's painted ground, as a map that lays layers and counts them. */
function fakeGround() {
  const layers = new Set<{ destroy(): void }>();
  const map = {
    createBlankLayer: () => {
      const layer = { putTilesAt() {}, setScale() { return layer; }, setDepth() { return layer; }, destroy: () => layers.delete(layer) };
      layers.add(layer);
      return layer;
    },
  };
  return { layers, ground: { map, tiles: {}, layers: [[[0]]].concat(), density: 1, pending: null } };
}

function rig() {
  const scene = new FakeScene();
  const fp = footprint('commons') ?? serveFixtureCommons();
  const g = fakeGround();
  // Every tile laid with one cell: a layer per attached chunk.
  g.ground.layers = [Array.from({ length: fp.h }, () => Array<number>(fp.w).fill(0))];
  const tileArt = new TileArt<FakeObject>();
  const points = new Map<object, unknown[]>();
  const gatherChunks = new Map<string, unknown[]>();
  const occluders = new Set<unknown>();
  const hooks = { attached: new Set<string>(), attach(k: string) { this.attached.add(k); return []; }, detach(k: string) { this.attached.delete(k); } };
  const builds = new BuildQueue();
  const deps = {
    scene,
    solids: scene.solids,
    tileArt,
    gathering: () => ({ addChunk: (k: string, s: unknown[]) => gatherChunks.set(k, s), removeChunk: (k: string) => gatherChunks.delete(k) }),
    occluders: { add: (l: { image: unknown }[]) => l.forEach((o) => occluders.add(o.image)), remove: (l: unknown[]) => l.forEach((o) => occluders.delete(o)) },
    interactables: { register: (owner: object, p: unknown[]) => (p.length ? points.set(owner, p) : points.delete(owner)) },
    reducedMotion: false,
    ground: g.ground,
    day: () => ({ festival: 'Carting Day', wick: 'Bloom' }),
    light: (lamps: never[]) => refreshLanternVisuals(scene as never, lamps, 'new', {} as never),
    enter: () => {},
    hooks: () => hooks,
    builds,
  };
  return { scene, fp, g, tileArt, points, gatherChunks, occluders, hooks, builds, deps };
}

type Rig = ReturnType<typeof rig>;
const snapshot = (r: Rig) => ({
  objects: r.scene.children.list.filter((o) => o.alive).length,
  tweens: r.scene.tweens.live.length,
  bodies: r.scene.bodies.size,
  solids: r.scene.solids.members.size,
  textures: r.scene.textures.added.length,
  layers: r.g.layers.size,
  points: r.points.size,
  gathered: r.gatherChunks.size,
  occluders: r.occluders.size,
  hooked: r.hooks.attached.size,
  listeners: Object.values(EV).reduce((n, e) => n + bus.listenerCount(e as never), 0),
});

test('every Commons chunk attaches every kind of object it owns and detaches leaving nothing behind', () => {
  const r = rig();
  const before = snapshot(r);
  const kinds = new Set<string>();
  for (const key of r.fp.objects.keys()) for (const o of r.fp.objects.get(key)!) kinds.add(o.kind);
  // Every object kind the layout has (the yard door comes from rooms.json, through a chunk too).
  for (const k of ['tree', 'bush', 'rock', 'overhang', 'prop', 'lamp', 'scenery', 'well', 'board', 'gate', 'sign', 'shelf', 'exit', 'npc-post', 'repair', 'gather']) assert.ok(kinds.has(k), k);
  for (let round = 0; round < 3; round++) {
    const chunks = [...r.fp.objects.keys()].map((k) => {
      const [cx, cy] = k.split(',').map(Number) as [number, number];
      return new FixedChunk(r.deps as never, r.fp, cx, cy);
    });
    for (const c of chunks) r.builds.finish(c);
    const during = snapshot(r);
    assert.ok(during.objects > before.objects + 1500, 'trees, canopies, pieces, signs drawn');
    assert.ok(during.tweens > before.tweens, 'lamp glows and exit chevrons pulse');
    assert.ok(during.solids > 0 && during.bodies > 0, 'collision');
    assert.equal(during.layers, 6, 'one ground layer a chunk');
    assert.ok(during.points >= 1, 'the Yard’s door');
    assert.ok(during.gathered >= 1, 'the Bloom patches, out today');
    assert.ok(during.occluders > 1000, 'canopies and overhangs fade');
    assert.equal(during.hooked, 6, 'the lane’s fixtures attach with their chunks');
    assert.ok(chunks.some((c) => c.exits.some((e) => e.to === 'village')) && chunks.reduce((n, c) => n + c.exits.filter((e) => /^home:/.test(e.to)).length, 0) === 8);
    assert.ok(!chunks.some((c) => c.exits.some((e) => e.to === 'outdoors')), 'no portal at the arch');
    for (const c of chunks) c.destroy();
    assert.deepEqual(snapshot(r), before, `round ${round}: nothing left`);
  }
});

test('a chunk dropped before it was built never builds, and still leaves nothing', () => {
  const r = rig();
  const before = snapshot(r);
  const c = new FixedChunk(r.deps as never, r.fp, 0, 1);
  r.builds.step(-1);
  c.destroy();
  r.builds.step(Infinity);
  assert.deepEqual(snapshot(r), before);
});

test('a fixed chunk defers all drawing when its build deadline has passed', () => {
  const r = rig();
  const c = new FixedChunk(r.deps as never, r.fp, 0, 1);
  const before = snapshot(r);
  assert.equal(c.build(-1), false);
  assert.deepEqual(snapshot(r), before, 'no scenery, signs or fixtures built after the deadline');
  r.builds.finish(c);
  assert.equal(c.whole, true);
  assert.ok(snapshot(r).objects > before.objects);
  c.destroy();
});

test('one owner per object: each is served in, and drawn by, the chunk holding its tile', () => {
  const fp = footprint('commons') ?? serveFixtureCommons();
  const seen = new Set<string>();
  for (const [key, list] of fp.objects)
    for (const o of list) {
      assert.equal(chunkOfTile(o.tx, o.ty), key, `${o.id} belongs to ${key}`);
      assert.ok(!seen.has(o.id), `${o.id} is served once`);
      seen.add(o.id);
    }
  // The lane's fixtures too: a gate's sign and its gate owned by one chunk each.
  for (const g of commonsLane()!.gates) assert.equal(g.chunk, chunkOfTile(g.sign.tx, g.sign.ty));
  // Festival pieces are out only on their day.
  const bloom = [...fp.objects.values()].flat().find((o) => o.festival === 'Bloom')!;
  assert.equal(objectOut(bloom, { festival: null, wick: 'Quiet' }), false);
  assert.equal(objectOut(bloom, { festival: null, wick: 'Bloom' }), true);
});

test('the lane’s gate signs, shelves and hame come and go with the chunk that owns them', () => {
  const fp = footprint('commons') ?? serveFixtureCommons();
  void fp;
  const scene = new FakeScene();
  const lane = commonsLane()!;
  const home = {
    scene,
    deps: { reducedMotion: false, solidGroup: scene.solids, session: { state: { flags: [] } } },
    commons: lane,
    homes: { gateInfo: () => null, status: 'guest', myGate: null },
  };
  const art = new HomesteadArt(home as never);
  const count = () => [scene.children.list.filter((o) => o.alive).length, scene.tweens.live.length];
  assert.deepEqual(count(), [0, 0]);
  art.drawGates();
  assert.deepEqual(count(), [0, 0], 'nothing drawn for a chunk not attached');
  const keys = [...new Set(lane.gates.map((g) => g.chunk).concat(chunkOfTile(lane.features.hame.tx, lane.features.hame.ty)))];
  for (const k of keys) for (const step of art.attachChunk(k)) step();
  const [objects, tweens] = count();
  assert.equal(objects, lane.gates.length * 2 + 2, 'a sign and its words a gate, the hame and its glint');
  assert.equal(tweens, 1, 'the hame’s glint');
  art.drawGates();
  assert.deepEqual(count(), [objects, tweens], 'a redraw replaces, never adds');
  for (const k of keys) art.detachChunk(k);
  assert.deepEqual(count(), [0, 0]);
});

test('fixed ground answers the open map’s lookups; a pocket stands at the nearest ground the arrivals reach', () => {
  forgetFixed();
  assert.equal(fixedSolidAt(2, 26), true, 'solid while the chunks aren’t here');
  assert.equal(fixedStand(2, 26), null);
  assert.equal(waitingFixedAt(40, 700), true);
  assert.deepEqual(outdoorStandAt(40, 700), { x: 40, y: 700 }, 'a slow read preserves the saved position');
  const fp = serveFixtureCommons();
  assert.equal(waitingFixedAt(40, 700), false);
  const arch = anchorTile('commons:arch');
  assert.deepEqual(arch, { tx: 2, ty: 26 });
  assert.equal(fixedSolidAt(arch.tx, arch.ty), false);
  assert.ok(fixedGroundAt(arch.tx, arch.ty) !== null);
  assert.deepEqual(fixedStand(arch.tx, arch.ty), arch);
  assert.deepEqual(outdoorStandAt(arch.tx * TILE + 8, arch.ty * TILE + 8), { x: arch.tx * TILE + 8, y: arch.ty * TILE + 8 });
  // The verge woods: solid, and a hero saved there stands on reachable ground.
  assert.equal(outdoorSolidAt(fp.tx, fp.ty + 30), true);
  const s = outdoorStandAt(fp.tx * TILE + 8, (fp.ty + 30) * TILE + 8)!;
  const t = { tx: Math.floor(s.x / TILE), ty: Math.floor(s.y / TILE) };
  assert.equal(fp.reach[(t.ty - fp.ty) * fp.w + (t.tx - fp.tx)], 1);
  // An open pocket the arrivals don't reach moves too.
  let pocket: { tx: number; ty: number } | null = null;
  for (let i = 0; i < fp.reach.length && !pocket; i++) {
    const x = i % fp.w;
    const y = (i - x) / fp.w;
    if (!fp.solid[y]![x] && !fp.reach[i]) pocket = { tx: fp.tx + x, ty: fp.ty + y };
  }
  if (pocket) assert.notDeepEqual(fixedStand(pocket.tx, pocket.ty), pocket);
});

test('the window’s grid is the frontier and the Commons; the drift fogs from both, and the bounds span both', () => {
  // The window's grid answers before a read only for fixed chunks (the frontier is the server's).
  assert.equal(onWindow(0, 1), true);
  assert.equal(onWindow(-1, 2), true);
  assert.equal(onWindow(2, 1), false, 'beside the Commons: the drift');
  assert.equal(onWindow(0, 3), false, 'south of it: the drift');
  assert.equal(onGrid(0, 1), true);
  const f = { minCx: -4, minCy: -8, maxCx: 4, maxCy: 0 };
  assert.equal(gridDistance(f, 40, 424), 0, 'on the Commons');
  assert.ok(gridDistance(f, 2.5 * 384, 1.5 * 384) > 0 && gridDistance(f, 2.5 * 384, 1.5 * 384) <= 384, 'a chunk off the Commons');
  const b = gridBounds();
  assert.ok(b.y + b.h >= 3 * 384, 'the bounds reach the Commons’ south edge');
});

test('the mouth is the seam: safe on the Commons side, not on the Tangle’s; the barrier holds a hurt hero on safe ground', () => {
  assert.equal(at('outdoors', 40, 24 * TILE + 1).safe, true);
  assert.equal(at('outdoors', 40, 24 * TILE - 1).safe, false);
  // The barrier, as the scene keeps it (WorldScene.holdSafe): back an axis at a time onto safe ground.
  const safe = (x: number, y: number) => at('outdoors', x, y).safe;
  const hold = (was: { x: number; y: number }, now: { x: number; y: number }) => holdOnSafe(safe, was, now);
  assert.deepEqual(hold({ x: 40, y: 386 }, { x: 44, y: 382 }), { x: 44, y: 386 }, 'a diagonal step slides along the mouth');
  assert.deepEqual(hold({ x: 40, y: 400 }, { x: 40, y: 396 }), { x: 40, y: 396 }, 'inside the Commons: free');
  assert.deepEqual(hold({ x: 40, y: 385 }, { x: 40, y: 380 }), { x: 40, y: 385 }, 'straight at the mouth: held');
  // Before the step: walking north at the mouth stops; walking along it doesn't; a slant keeps its sideways part.
  assert.deepEqual(stopAtEdge(safe, { x: 40, y: 386 }, { x: 0, y: -80 }, 0.05), { x: 0, y: 0 });
  assert.deepEqual(stopAtEdge(safe, { x: 40, y: 386 }, { x: 80, y: 0 }, 0.05), { x: 80, y: 0 });
  assert.deepEqual(stopAtEdge(safe, { x: 40, y: 386 }, { x: 56, y: -56 }, 0.05), { x: 56, y: 0 });
  assert.deepEqual(stopAtEdge(safe, { x: 40, y: 420 }, { x: 0, y: -80 }, 0.05), { x: 0, y: -80 }, 'well inside: free');
});

test('fixed chunks are cached per layout revision under their pseudo-epoch', () => {
  assert.equal(fixedEpoch(COMMONS_PLACE.layout, COMMONS_PLACE.revision), 'fixed:commons@3');
  assert.match(chunkCacheKey(fixedEpoch('commons', 2), 0, 1), /:fixed:commons@2:0:1$/);
  assert.notEqual(chunkCacheKey(fixedEpoch('commons', 2), 0, 1), chunkCacheKey(fixedEpoch('commons', 3), 0, 1));
});

test('failed fixed reads wait before retrying instead of fetching every frame', async () => {
  forgetFixed();
  forgetChunks();
  let calls = 0;
  const window = new WildsWindow({
    scene: { events: { once() {} } },
    session: { link: { api: { operations: { chunk: async () => { calls++; throw new Error('offline'); } } } } },
  } as never);
  const flushed = () => new Promise<void>((resolve) => setImmediate(resolve));
  window['load']('0,1');
  await flushed();
  assert.equal(calls, 6, 'one shared footprint fetch');
  for (let frame = 0; frame < 60; frame++) window['load']('0,1');
  await flushed();
  assert.equal(calls, 6, 'failed reads are paced');
  window['retryAt'].set('0,1', 0);
  window['load']('0,1');
  await flushed();
  assert.equal(calls, 12, 'retry after the backoff');
  window['destroy']();
  serveFixtureCommons();
});


test('Commons residents, pickups, papers, repairs, festival dressing and exit reads leave nothing after three attaches', async () => {
  const { Interactables } = await import('../src/game/entities/interactables.ts');
  const { HomesteadLayer } = await import('../src/game/entities/homesteads.ts');
  const { HomesteadTalk } = await import('../src/game/entities/homestead-talk.ts');
  const { FixedScope } = await import('../src/game/wilds/fixed-scope.ts');
  const { FixedLife } = await import('../src/game/wilds/fixed-life.ts');
  const { Npcs } = await import('../src/game/entities/npcs.ts');
  const { ResidentCycle, doorFor } = await import('../src/game/resident-cycle.ts');
  const { WorldTalk } = await import('../src/game/entities/world-talk.ts');
  const { PaperPickups } = await import('../src/game/entities/papers.ts');
  const { ItemPickups } = await import('../src/game/entities/item-pickups.ts');
  const { RepairsLayer } = await import('../src/game/entities/repairs.ts');
  const { VillageLayer } = await import('../src/game/entities/village-life.ts');
  const { Touches } = await import('../src/game/entities/touches.ts');
  const { buildWildsWorld } = await import('../src/game/wilds/wilds-world.ts');
  const { villageFor } = await import('../src/game/village.ts');
  const { itemsFor } = await import('../src/game/items.ts');
  const { createNewGame } = await import('../src/lib/state.ts');
  const { repairsForArea } = await import('../src/lib/repairs.ts');
  const { PAPERS } = await import('../src/content/papers.ts');
  const placed = PAPERS.find((p) => p.source.kind === 'placed')!;
  const originalSource = placed.source;
  placed.source = { kind: 'placed', area: 'commons', tx: 24, ty: 18, look: 'folded', spot: 'test fixture' };
  const { setGameNow } = await import('../src/game/clock.ts');
  const r = rig();
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ fillRect() {} }) }) } as unknown as Document;
  r.scene.textures.exists = (key) => !key?.startsWith('repair-') || r.scene.textures.added.includes(key);
  // The frozen Commons has no window or water tiles; exercise their terrain rules without changing its layout.
  const { TERRAIN } = await import('../src/lib/tile.ts');
  const windowTile = r.fp.ground[6]![34]!;
  const waterTile = r.fp.ground[7]![35]!;
  r.fp.ground[6]![34] = TERRAIN.window;
  r.fp.ground[7]![35] = TERRAIN.water_a;
  const world = buildWildsWorld();
  const interactions = new Interactables(r.scene as never, { reducedMotion: false });
  r.deps.interactables = interactions as never;
  const state = createNewGame();
  const session = { state, questStage: 'complete', link: {} } as never;
  const model = villageFor(session);
  model.ensureCalendar = () => {};
  model.loadProjects = async () => {};
  model.repairsStatus = 'ready';
  model.repairs.open = repairsForArea('outdoors').map((d) => ({ id: d.id })) as never;
  const items = itemsFor(session);
  items.view = { pickedUp: [], stacks: [], instances: [], pockets: [] } as never;
  items.pickedUp = () => [];
  const deps = { world, session, fx: {}, reducedMotion: false, interactables: r.deps.interactables } as never;
  const scene = r.scene as never;
  const npcs = new Npcs(scene, world, r.scene.solids as never);
  const cycle = new ResidentCycle(scene, { world, npcs, reducedMotion: false, block: (x, y, on) => npcs.block(x, y, on), onScreen: () => true });
  const papers = new PaperPickups(scene, deps);
  const pickups = new ItemPickups(scene, deps);
  const repairs = new RepairsLayer(scene, deps);
  const village = new VillageLayer(scene, { ...(deps as object), schedule: (job: { build(deadline: number): boolean }) => r.builds.add(job), unschedule: (job: { build(deadline: number): boolean }) => r.builds.drop(job) } as never);
  const talk = new WorldTalk({ ...(deps as object), village: model, papers } as never);
  const touches = new Touches({ world, interactables: r.deps.interactables, hero: () => ({}), fx: {} } as never);
  const home = Object.assign(Object.create(HomesteadLayer.prototype), {
    scene, deps: { ...(deps as object), reducedMotion: false, solidGroup: r.scene.solids }, commons: commonsLane(),
    village: model, land: null, yardRoom: null, homes: { gateInfo: () => ({ shelf: true, homeId: 'fixture', names: [] }), status: 'guest', myGate: null },
    fixedScope: new FixedScope(true),
  }) as InstanceType<typeof HomesteadLayer>;
  Object.assign(home, { art: new HomesteadArt(home), talk: new HomesteadTalk(home) });
  const life = new FixedLife({ world, npcs, cycle, talk, pickups, papers, repairs, village, touches, homes: () => ({ attach: (key) => home.attachFixedChunk(key), detach: (key) => home.detachFixedChunk(key) }) });
  r.deps.hooks = () => life as never;
  const count = () => ({ ...snapshot(r), timers: r.scene.timers.size, points: interactions.list.length, owners: interactions['byOwner'].size, people: npcs.npcs.length, posts: world.npcs.length });
  const before = count();
  assert.equal(before.objects, 0, 'no Commons objects before their chunks');
  assert.deepEqual(doorFor('silas', 'outdoors', 'in:commons:yard'), { step: { tx: 32, ty: 42 }, door: { tx: 32, ty: 41 } });
  setGameNow(Date.parse('2026-01-05T00:05:00Z') / 1000);
  for (const festival of ['Carting Day', 'Closure Night', 'Amberwake', 'The Breaking']) {
    model.calendar = { ...model.calendar, festival, notice: 'A fixture notice' } as never;
    for (let round = 0; round < 3; round++) {
      const chunks = [...r.fp.objects.keys()].map((k) => {
        const [cx, cy] = k.split(',').map(Number) as [number, number];
        return new FixedChunk(r.deps as never, r.fp, cx, cy);
      });
      for (const c of chunks) r.builds.finish(c);
      assert.equal(npcs.npcs.length, 2);
      assert.ok(pickups.ids().length > 0, 'pickups drawn');
      assert.ok(papers.lying().length > 0, 'papers drawn');
      assert.ok(repairs.ids().length > 0, 'repairs drawn');
      const points = interactions.list;
      for (const id of ['home:hame', 'home:board', 'home:well', 'home:toolbox', 'home:firebox', 'silas', 'home:sign:0', 'home:shelf:0']) assert.ok(points.some((p) => p.id === id), id);
      assert.equal(points.find((p) => p.id === 'home:board')?.marker?.(), model.calendar.notice ? 'talk' : null);
      assert.ok(points.some((p) => p.id === 'elara'), 'resident talk registered');
      assert.ok(points.some((p) => p.id.startsWith('touch:sign:gate:')), 'exit post readable');
      if (festival === 'Carting Day') {
        assert.equal(r.scene.children.list.filter((o) => /^stall-/.test(o.texture.key)).length, 3);
        assert.ok(points.some((p) => p.id === 'village:stall'));
      }
      if (festival === 'Amberwake' || festival === 'Closure Night') assert.ok(r.scene.children.list.some((o) => o.texture.key.includes('window-lamp-glow')), 'window lamps');
      if (festival === 'The Breaking') assert.ok(r.scene.children.list.some((o) => o.texture.key.includes('candle-hull')), 'Breaking candles');
      if (festival === 'Closure Night') assert.equal(r.scene.children.list.filter((o) => o.type === 'Rectangle').length, 6);
      // A watched departure is cancelled by teardown, including its collision body.
      cycle.check(Date.parse('2026-01-05T00:21:00Z') / 1000);
      assert.ok(npcs.npcs.find((n) => n.id === 'silas')?.path, 'Silas walks to his door on outdoors');
      bus.emit(EV.villageChanged, { what: 'calendar' });
      r.builds.step(-1);
      for (const c of chunks) c.destroy();
      r.builds.step(Infinity);
      assert.deepEqual(count(), before, `${festival}, round ${round}: nothing left`);
    }
  }
  globalThis.document = originalDocument;
  r.fp.ground[6]![34] = windowTile;
  r.fp.ground[7]![35] = waterTile;
  placed.source = originalSource;
  setGameNow(null);
  r.scene.events.emit('shutdown');
});
