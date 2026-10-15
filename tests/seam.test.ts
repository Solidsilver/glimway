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
import { registerHooks } from 'node:module';

// Phaser is a stub in node tests: give it what a fixed chunk's collision and glows touch.
const Phaser = (await import('phaser')).default as Record<string, unknown>;
class FakeObject {
  alive = true;
  active = true;
  body: unknown;
  data = new Map<string, unknown>();
  width = 64;
  height = 64;
  scene: FakeScene | null;
  x: number;
  y: number;
  texture: { key: string };
  type: string;
  depth = 0;
  visible = true;
  constructor(scene: FakeScene | null, x = 0, y = 0, texture = { key: '' }, type = 'Image') {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.texture = texture;
    this.type = type;
  }
  once() { return this; }
  fillStyle() { return this; }
  fillRect() { return this; }
  lineStyle() { return this; }
  strokeRect() { return this; }
  lineBetween() { return this; }
  strokeCircle() { return this; }
  clear() { return this; }
  setScrollFactor() { return this; }
  setTexture(key: string) { this.texture.key = key; return this; }
  setOrigin() { return this; }
  setDepth(depth: number) { this.depth = depth; return this; }
  setFlipX() { return this; }
  setTint() { return this; }
  clearTint() { return this; }
  setScale() { return this; }
  setAlpha() { return this; }
  setAngle() { return this; }
  setBlendMode() { return this; }
  setVisible(visible: boolean) { this.visible = visible; return this; }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  play() { return this; }
  setDisplaySize(width: number, height: number) { this.width = width; this.height = height; return this; }
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

// Phaser is a stub here, so this stands in for Phaser.GameObjects.Text: sign-labels.ts
// rasterizes a label through scene.make.text and reads its canvas and displayed size.
class FakeText {
  static n = 0;
  canvas = { width: 12, height: 8 };
  width = 12;
  height = 8;
  texture = { key: `fake-text-${FakeText.n++}` };
  constructor(_scene?: unknown, _x?: number, _y?: number, _text?: string, _style?: unknown) {}
  destroy() {}
}
Object.assign(Phaser, { GameObjects: { Text: FakeText } });

const { FixedChunk } = await import('../src/game/wilds/fixed-chunk.ts');
const { footprint, forgetFixed, fixedSolidAt, fixedGroundAt, fixedStand, anchorTile, commonsLane, chunkOfTile, objectOut } = await import('../src/game/wilds/fixed.ts');
const { outdoorStandAt, outdoorSolidAt, gridBounds, waitingFixedAt } = await import('../src/game/wilds/wilds-world.ts');
const { WildsWindow, onWindow, gridDistance, prewarmFixedArt } = await import('../src/game/wilds/window.ts');
const { BuildQueue } = await import('../src/game/wilds/window-chunk.ts');
const { TileArt } = await import('../src/game/area/tile-art.ts');
const { refreshLanternVisuals } = await import('../src/game/area/lanterns.ts');
const { HomesteadArt } = await import('../src/game/entities/homestead-art.ts');
const { chunkCacheKey, forgetChunks } = await import('../src/game/wilds/chunks.ts');
const { fixedEpoch } = await import('../src/lib/api/chunks.ts');
const { at, onGrid } = await import('../src/lib/location.ts');
const { bus, EV } = await import('../src/game/events.ts');
const { serveFixtureCommons, serveFixtureLots, COMMONS_PLACE } = await import('./commons-fixture.ts');
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
    get: () => ({ customData: { density: 0, w: 7, resolution: 1 }, has: () => true, get: () => ({ height: 32, width: 32 }) }),
    createCanvas: (key: string) => {
      this.textures.added.push(key);
      return { context: { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }, refresh() {} };
    },
    addCanvas: (key: string) => {
      this.textures.added.push(key);
      return { customData: {} };
    },
    remove: (key: string) => { const i = this.textures.added.indexOf(key); if (i >= 0) this.textures.added.splice(i, 1); },
  };
  events = new EventEmitter();
  cameras = { main: { width: 1200, height: 760, zoom: 2, midPoint: { x: 0, y: 0 }, stopFollow() {}, startFollow() {}, pan() {} } };
  sys = { isActive: () => true };
  anims = { exists: () => false, create() {} };
  input = Object.assign(new EventEmitter(), { keyboard: new EventEmitter() });
  scale = new EventEmitter();
  timers = new Set<unknown>();
  time = {
    addEvent: () => {
      const timer = { remove: () => this.timers.delete(timer) };
      this.timers.add(timer);
      return timer;
    },
    delayedCall: () => {
      const timer = { remove: () => this.timers.delete(timer) };
      this.timers.add(timer);
      return timer;
    },
  };
  bodies = new Set<unknown>();
  physics = {
    world: { add: (b: unknown) => this.bodies.add(b) },
    add: { existing: (o: FakeObject) => ((o.body = { enable: true }), this.bodies.add(o.body), o) },
  };
  solids = {
    children: {},
    members: new Set<FakeObject>(),
    add: (o: FakeObject) => this.solids.members.add(o),
    remove: (o: FakeObject) => {
      this.solids.members.delete(o);
      this.bodies.delete(o.body);
    },
  };
  add = {
    graphics: () => this.put(new FakeObject(this, 0, 0, { key: '' }, 'Graphics')),
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
    text: (c: { x?: number; y?: number; text?: string; style?: unknown }) => new FakeText(this, c.x ?? 0, c.y ?? 0, c.text, c.style),
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
  const fp = footprint('hearthwick') ?? serveFixtureCommons();
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
    interactables: { invalidatePrompt() {}, register: (owner: object, p: unknown[]) => (p.length ? points.set(owner, p) : points.delete(owner)) },
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
  timers: r.scene.timers.size,
  sceneListeners: r.scene.events.eventNames().reduce((n, e) => n + r.scene.events.listenerCount(e), 0),
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
  for (const k of ['tree', 'prop', 'lamp', 'scenery', 'well', 'board', 'exit', 'npc-post', 'repair', 'gather']) assert.ok(kinds.has(k), k);
  for (let round = 0; round < 3; round++) {
    const chunks = [...r.fp.objects.keys()].map((k) => {
      const [cx, cy] = k.split(',').map(Number) as [number, number];
      return new FixedChunk(r.deps as never, r.fp, cx, cy);
    });
    for (const c of chunks) r.builds.finish(c);
    const during = snapshot(r);
    assert.ok(during.objects > before.objects + 50, 'trees, canopies, pieces, signs drawn');
    assert.ok(during.tweens > before.tweens, 'lamp glows and exit chevrons pulse');
    assert.ok(during.solids > 0 && during.bodies > 0, 'collision');
    assert.equal(during.layers, 9, 'one ground layer a chunk');
    assert.ok(during.points >= 1, 'the Yard’s door');
    assert.ok(during.gathered >= 1, 'the Bloom patches, out today');
    assert.ok(during.occluders > 0, 'canopies and overhangs fade');
    assert.equal(during.hooked, 9, 'the lane’s fixtures attach with their chunks');
    assert.deepEqual(chunks.flatMap(c => c.exits).map(e => e.to), ['woodland'], 'only Brackenwood is a curated outdoor portal');
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
  const fp = footprint('hearthwick') ?? serveFixtureCommons();
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
  const fp = footprint('hearthwick') ?? serveFixtureCommons();
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
  assert.equal(objects, lane.gates.length * 4 + 2, 'gate posts, sign and its words; the hame and its glint');
  assert.equal(tweens, 1, 'the hame’s glint');
  art.drawGates();
  assert.deepEqual(count(), [objects, tweens], 'a redraw replaces, never adds');
  for (const k of keys) art.detachChunk(k);
  assert.deepEqual(count(), [0, 0]);
});

test('a chunk sign label is rasterized once and drawn from cache on re-attach', () => {
  serveFixtureCommons();
  const scene = new FakeScene();
  // Canvas textures live in the texture manager: track them by key so a
  // re-attach finds its cached entry instead of rasterizing again.
  const canvases = new Map<string, { customData: Record<string, unknown> }>();
  Object.assign(scene.textures, {
    exists: (key?: string) => !!key && canvases.has(key),
    get: (key: string) => canvases.get(key) ?? { customData: {} },
    addCanvas: (key: string) => {
      const t = { customData: {} as Record<string, unknown> };
      canvases.set(key, t);
      scene.textures.added.push(key);
      return t;
    },
  });
  // signLabel rasterizes through a (stubbed) Phaser Text and clones its canvas.
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
  } as unknown as Document;
  try {
    const lane = commonsLane()!;
    const home = {
      scene,
      deps: { reducedMotion: false, solidGroup: scene.solids, session: { state: { flags: [] } } },
      commons: lane,
      homes: { gateInfo: () => null, status: 'guest', myGate: null },
    };
    const art = new HomesteadArt(home as never);
    const keys = [...new Set(lane.gates.map((g) => g.chunk))];

    assert.deepEqual(scene.textures.added, [], 'nothing drawn before a chunk attaches');
    for (const k of keys) for (const step of art.attachChunk(k)) step();
    const first = [...scene.textures.added];
    assert.ok(first.length > 0, 'gate sign labels rasterized on attach');

    for (const k of keys) art.detachChunk(k);
    assert.deepEqual(scene.textures.added, first, 'detach keeps cached label textures');

    for (const k of keys) for (const step of art.attachChunk(k)) step();
    assert.deepEqual(scene.textures.added, first, 're-attach draws from cache, no new texture');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('a label drawn before its font loads is not cached; a later attach caches it', () => {
  serveFixtureCommons();
  const scene = new FakeScene();
  const canvases = new Map<string, { customData: Record<string, unknown> }>();
  Object.assign(scene.textures, {
    exists: (key?: string) => !!key && canvases.has(key),
    get: (key: string) => canvases.get(key) ?? { customData: {} },
    addCanvas: (key: string) => {
      const t = { customData: {} as Record<string, unknown> };
      canvases.set(key, t);
      scene.textures.added.push(key);
      return t;
    },
  });
  let fontReady = false;
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
    fonts: { check: () => fontReady },
  } as unknown as Document;
  try {
    const lane = commonsLane()!;
    const home = {
      scene,
      deps: { reducedMotion: false, solidGroup: scene.solids, session: { state: { flags: [] } } },
      commons: lane,
      homes: { gateInfo: () => null, status: 'guest', myGate: null },
    };
    const art = new HomesteadArt(home as never);
    const keys = [...new Set(lane.gates.map((g) => g.chunk))];

    // Font not loaded yet: labels draw as plain text and are never cached.
    for (const k of keys) for (const step of art.attachChunk(k)) step();
    assert.deepEqual(scene.textures.added, [], 'not-ready labels are not cached');
    assert.ok(scene.children.list.some((o) => o.type === 'Text'), 'drawn as plain text');

    // The font loads; a redraw caches the right font.
    fontReady = true;
    for (const k of keys) art.detachChunk(k);
    for (const k of keys) for (const step of art.attachChunk(k)) step();
    const first = [...scene.textures.added];
    assert.ok(first.length > 0, 'cached once the font is ready');

    // And a re-attach still draws from that cache.
    for (const k of keys) art.detachChunk(k);
    for (const k of keys) for (const step of art.attachChunk(k)) step();
    assert.deepEqual(scene.textures.added, first, 're-attach keeps the cached font');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('a stocked gate shelf detaches after Phaser has destroyed the static group', () => {
  serveFixtureCommons();
  serveFixtureLots();
  const scene = new FakeScene();
  const lane = commonsLane()!;
  const slot = lane.gates[0]!;
  const home = {
    scene,
    deps: { reducedMotion: false, solidGroup: scene.solids, session: { state: { flags: [] } } },
    commons: lane,
    homes: { gateInfo: () => ({ shelf: true, shelfStocked: true, homeId: 'fixture', names: [] }), status: 'guest', myGate: null },
  };
  const art = new HomesteadArt(home as never);
  for (const draw of art.attachChunk(slot.chunk)) draw();
  assert.ok(scene.solids.members.size > 0, 'the shelf has collision');
  const bodies = [...scene.solids.members];
  // Phaser Group.destroy clears membership without destroying its children.
  scene.solids.members.clear();
  Object.assign(scene.solids, { children: undefined, remove: () => assert.fail('group is already destroyed') });
  art.detachChunk(slot.chunk);
  art.detachChunk(slot.chunk);
  assert.ok(bodies.every((o) => !o.alive), 'remaining shelf bodies are destroyed once');
  assert.equal(scene.children.list.filter((o) => o.alive).length, 0);
  assert.equal(scene.tweens.live.length, 0);
});

test('fixed ground answers the open map’s lookups; a pocket stands at the nearest ground the arrivals reach', () => {
  forgetFixed();
  assert.equal(fixedSolidAt(2, 26), true, 'solid while the chunks aren’t here');
  assert.equal(fixedStand(2, 26), null);
  assert.equal(waitingFixedAt(40, 700), true);
  assert.deepEqual(outdoorStandAt(40, 700), { x: 40, y: 700 }, 'a slow read preserves the saved position');
  const fp = serveFixtureCommons();
  assert.equal(waitingFixedAt(40, 700), false);
  const arch = anchorTile('hearthwick:arch');
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
  assert.equal(onWindow(0, 3), true, 'south of it: the drift');
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
  assert.equal(fixedEpoch(COMMONS_PLACE.layout, COMMONS_PLACE.revision), 'fixed:hearthwick@1');
  assert.match(chunkCacheKey(fixedEpoch('hearthwick', 2), 0, 1), /:fixed:hearthwick@2:0:1$/);
  assert.notEqual(chunkCacheKey(fixedEpoch('hearthwick', 2), 0, 1), chunkCacheKey(fixedEpoch('hearthwick', 3), 0, 1));
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
  assert.equal(calls, 17, 'one shared footprint fetch');
  for (let frame = 0; frame < 60; frame++) window['load']('0,1');
  await flushed();
  assert.equal(calls, 17, 'failed reads are paced');
  window['retryAt'].set('0,1', 0);
  window['load']('0,1');
  await flushed();
  assert.equal(calls, 34, 'retry after the backoff');
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
  const { Fishing } = await import('../src/game/entities/fishing.ts');
  const { PipWalkOn } = await import('../src/game/entities/pip-walk-on.ts');
  const { Touches } = await import('../src/game/entities/touches.ts');
  const { buildWildsWorld } = await import('../src/game/wilds/wilds-world.ts');
  const { villageFor } = await import('../src/game/village.ts');
  const { itemsFor } = await import('../src/game/items.ts');
  const { createNewGame } = await import('../src/lib/state.ts');
  const { repairsForArea } = await import('../src/lib/repairs.ts');
  const { PAPERS } = await import('../src/content/papers.ts');
  const placed = PAPERS.find((p) => p.source.kind === 'placed')!;
  const originalSource = placed.source;
  placed.source = { kind: 'placed', area: 'hearthwick', tx: 24, ty: 62, look: 'folded', spot: 'test fixture' };
  const { setGameNow } = await import('../src/game/clock.ts');
  const r = rig();
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ fillRect() {}, setTransform() {} }) }) } as unknown as Document;
  r.scene.textures.exists = (key) => !key?.startsWith('repair-') || r.scene.textures.added.includes(key);
  prewarmFixedArt(r.scene as never, r.fp);
  const world = buildWildsWorld();
  const interactions = new Interactables(r.scene as never, { reducedMotion: false });
  r.deps.interactables = interactions as never;
  const state = createNewGame();
  const session = { state, questStage: 'complete', link: { server: {}, readWaters: async () => ({ ok: true, value: [] }) }, checkSpend: () => ({ ok: false, cost: 1, reason: 'full' }) } as never;
  // The real HomesteadLayer creates this session model before markers read it.
  const { homesteadsFor } = await import('../src/game/homestead.ts');
  homesteadsFor(session);
  const model = villageFor(session);
  model.ensureCalendar = () => {};
  model.loadProjects = async () => {};
  model.worldFlags = ['project:well-canopy:complete', 'project:cooley-window-fund:complete'];
  model.repairsStatus = 'ready';
  model.repairs.open = repairsForArea('outdoors').map((d) => ({ id: d.id })) as never;
  const items = itemsFor(session);
  items.view = { pickedUp: [], stacks: [], instances: [], pockets: [] } as never;
  items.pickedUp = () => [];
  const rootListeners = Object.values(EV).reduce((n, e) => n + bus.listenerCount(e as never), 0);
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
  const fishing = new Fishing(scene, { ...(deps as object), hero: () => ({ sprite: { x: 536, y: 1166 } }), notePosition() {} } as never);
  const pip = new PipWalkOn(scene, { world, npcs, hero: () => ({ x: 280, y: 920 }) });
  const { HouseLights } = await import('../src/game/entities/house-lights.ts');
  const lights = new HouseLights(scene, { world, reducedMotion: false });
  const life = new FixedLife({ lights, world, npcs, cycle, talk, pickups, papers, repairs, village, touches, fishing, pip, homes: () => ({ attach: (key) => home.attachFixedChunk(key), detach: (key) => home.detachFixedChunk(key) }) });
  r.deps.hooks = () => life as never;
  interactions.buildMarkers();
  const count = () => ({ ...snapshot(r), timers: r.scene.timers.size, points: interactions.list.length, owners: interactions['byOwner'].size, people: npcs.npcs.length, posts: world.npcs.length });
  setGameNow(Date.parse('2026-01-05T00:05:00Z') / 1000);
  const before = count();
  assert.equal(before.objects, 1, 'only the persistent interaction key hint before chunks');
  assert.deepEqual(doorFor('silas', 'outdoors', 'in:commons:yard'), { step: { tx: 34, ty: 35 }, door: { tx: 34, ty: 34 } });
  for (const festival of ['Carting Day', 'Closure Night', 'Amberwake', 'The Breaking']) {
    model.calendar = { ...model.calendar, festival, notice: 'A fixture notice' } as never;
    bus.emit(EV.villageChanged, { what: 'calendar' });
    r.deps.day = () => ({ festival, wick: 'Bloom' });
    for (let round = 0; round < 3; round++) {
      const chunks = [...r.fp.objects.keys()].map((k) => {
        const [cx, cy] = k.split(',').map(Number) as [number, number];
        return new FixedChunk(r.deps as never, r.fp, cx, cy);
      });
      for (const c of chunks) r.builds.finish(c);
      assert.equal(npcs.npcs.length, 8);
      assert.ok(pickups.ids().length > 0, 'pickups drawn');
      assert.ok(papers.lying().length > 0, 'papers drawn');
      assert.ok(repairs.ids().length > 0, 'repairs drawn');
      const points = interactions.list;
      for (const id of ['home:hame', 'village:board', 'village:hopper', 'hearth', 'home:well', 'home:toolbox', 'home:firebox', 'silas', 'touch:bench:8,61', 'touch:sign:post:16,59']) assert.ok(points.some((p) => p.id === id), id);
      assert.equal(points.find((p) => p.id === 'village:board')?.marker?.(), model.calendar.notice ? 'talk' : null);
      assert.ok(points.some((p) => p.id.startsWith('fish:')), 'fishing banks attached');
      assert.ok(points.some((p) => p.id.startsWith('touch:sign:boundary:')), 'boundary labels readable');
      assert.deepEqual({ x: village['millView']?.x, y: village['millView']?.y }, { x: 519, y: 1220 });
      const wheel = r.scene.children.list.find((o) => o.x === 519 && o.y === 1220)!;
      assert.ok(wheel.depth > 1232, 'wheel sorts in front of mill house');
      assert.ok(lights.view().length >= 2, 'outdoor resident light overlays attach');
      assert.equal(r.scene.children.list.filter((o) => o.texture.key === 'well-canopy').length, 1);
      assert.equal(r.scene.children.list.filter((o) => o.texture.key === 'spark' && o.x === 520 && o.y === 842).length, 1, 'Ada’s permanent window light');
      assert.ok(points.some((p) => p.id === 'elara'), 'resident talk registered');
      assert.ok(points.some((p) => p.id.startsWith('touch:sign:gate:')), 'exit post readable');
      if (festival === 'Carting Day') {
        assert.equal(r.scene.children.list.filter((o) => /^stall-/.test(o.texture.key)).length, 3);
        assert.ok(points.some((p) => p.id === 'village:stall'));
      }
      if (festival === 'Amberwake' || festival === 'Closure Night') assert.ok(r.scene.children.list.some((o) => o.texture.key.includes('window-lamp-glow')), 'window lamps');
      if (festival === 'The Breaking') assert.ok(r.scene.children.list.some((o) => o.texture.key.includes('candle-hull')), 'Breaking candles');
      if (festival === 'Closure Night') {
        assert.equal(r.scene.children.list.filter((o) => o.type === 'Rectangle' && o.depth === 3990).length, 1, 'one shade across the camera view');
        r.scene.cameras.main.width = 960;
        r.scene.cameras.main.zoom = 1.5;
        r.scene.events.emit('prerender');
        const shade = r.scene.children.list.find((o) => o.type === 'Rectangle')!;
        assert.equal(shade.width, 640);
        assert.equal(shade.height, 760 / 1.5);
        assert.equal(shade.x, 480);
      }
      const dressing = [...village['chunks'].values()].flatMap((c) => c.drawn);
      bus.emit(EV.villageChanged, { what: 'repairs' });
      const afterRepair = [...village['chunks'].values()].flatMap((c) => c.drawn);
      assert.equal(afterRepair.length, dressing.length, 'repair refresh preserves dressing');
      assert.ok(afterRepair.every((o, i) => o === dressing[i]), 'festival objects are retained');
      assert.ok(dressing.every((o) => (o as unknown as FakeObject).alive), 'festival objects stay on screen');
      assert.ok(interactions['markers'].size > 0, 'marker images and bob tweens are built');
      const timersBeforeProject = r.scene.timers.size;
      model.worldFlags = [...model.worldFlags.filter((f) => f !== 'project:mill-wheel:complete'), ...(round % 2 ? ['project:mill-wheel:complete'] : [])];
      bus.emit(EV.villageChanged, { what: 'projects' });
      r.builds.step(Infinity);
      assert.equal(village['millView']?.mended, !!(round % 2), 'project refresh changes the served wheel');
      assert.equal(r.scene.timers.size, timersBeforeProject, 'project refresh replaces its timer');
      assert.equal([...village['chunks'].values()].reduce((n, c) => n + c.timers.length, 0), 1, 'one wheel timer');
      // A watched departure is cancelled by teardown, including its collision body.
      cycle.check(Date.parse('2026-01-05T00:21:00Z') / 1000);
      assert.ok(npcs.npcs.find((n) => n.id === 'silas')?.path, 'Silas walks to his door on outdoors');
      model.calendar = { ...model.calendar, festival: festival === 'Carting Day' ? 'Closure Night' : 'Carting Day' } as never;
      bus.emit(EV.villageChanged, { what: 'calendar' });
      r.builds.step(-1);
      for (const c of chunks) c.destroy();
      r.builds.step(Infinity);
      model.calendar = { ...model.calendar, festival } as never;
      bus.emit(EV.villageChanged, { what: 'calendar' });
      assert.deepEqual(count(), before, `${festival}, round ${round}: nothing left`);
    }
  }
  // Newly attached Elara must start hidden while she is at the library desk.
  setGameNow(Date.parse('2026-01-05T00:21:00Z') / 1000);
  const key = chunkOfTile(6, 27);
  for (const step of life.attach(key)) step();
  assert.equal(npcs.npcs.find((n) => n.id === 'elara')?.spot, 'camp');
  assert.equal(npcs.npcs.find((n) => n.id === 'elara')?.present, false);
  assert.equal(npcs.gone('elara'), true);
  life.detach(key);
  assert.deepEqual(count(), before, 'desk-phase attachment leaves nothing');
  const exit = [...r.fp.objects.values()].flat().find((o) => o.id === 'exit:woodland')!;
  const exitFestival = exit.festival;
  exit.festival = 'fixture-off';
  const exitKey = chunkOfTile(exit.tx, exit.ty);
  for (const step of life.attach(exitKey)) step();
  assert.ok(!interactions.list.some((p) => p.id.startsWith('touch:sign:gate:')), 'out-of-season exit has no readable sign');
  life.detach(exitKey);
  exit.festival = exitFestival;
  model.calendar = { ...model.calendar, festival: 'Closure Night' } as never;
  r.deps.day = () => ({ festival: 'Closure Night', wick: 'Quiet' });
  const closing = [...r.fp.objects.keys()].map((key) => { const [cx, cy] = key.split(',').map(Number); return new FixedChunk(r.deps as never, r.fp, cx!, cy!); });
  for (const c of closing) r.builds.finish(c);
  // The window registers after the entities; exercise that shutdown order
  // with active pickups, NPCs, wheel, lamps and interactions still attached.
  r.scene.events.once('shutdown', () => { for (const c of closing) c.destroy(); });
  assert.ok(r.scene.children.list.some((o) => o.type === 'Rectangle'));
  r.scene.events.emit('shutdown');
  assert.equal(snapshot(r).objects, 1, 'only the scene-owned key hint remains');
  assert.equal(snapshot(r).tweens, 0);
  assert.equal(snapshot(r).bodies, 0);
  assert.equal(snapshot(r).gathered, 0);
  assert.equal(interactions.list.length, 0);
  assert.equal(npcs.npcs.length, 0);
  assert.equal(r.scene.events.listenerCount('prerender'), 0, 'shade update listener released');
  assert.equal(r.scene.children.list.filter((o) => o.type === 'Rectangle').length, 0, 'scene teardown releases active shade');
  assert.equal(village['chunks'].size, 0);
  assert.equal(r.scene.timers.size, 0, 'all scene timers released');
  assert.equal(r.scene.input.keyboard.listenerCount('keydown'), 0);
  assert.equal(r.scene.events.listenerCount('destroy'), 0, 'alternate scene-end hooks removed on shutdown');
  assert.equal(snapshot(r).listeners, rootListeners, 'all town bus listeners released');
  globalThis.document = originalDocument;
  placed.source = originalSource;
  setGameNow(null);
  r.scene.events.emit('shutdown');
});


test('fixed pieces stop after each piece once the slice expires', (t) => {
  const r = rig();
  const piece = [...r.fp.objects.values()].flat().find((o) => o.kind === 'well')!;
  const fp = { ...r.fp, objects: new Map([['0,1', [piece, piece, piece, piece]]]) };
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const c = new FixedChunk(r.deps as never, fp, 0, 1);
  const image = r.scene.add.image;
  let drawn = 0;
  t.mock.method(r.scene.add, 'image', (...args: Parameters<typeof image>) => {
    drawn++;
    clock += 2;
    return image(...args);
  });
  assert.equal(c.build(3), false);
  assert.equal(drawn, 2, 'a third piece does not start after the second passes the deadline');
  r.builds.finish(c);
  assert.equal(c.whole, true);
  assert.equal(drawn, 4);
  c.destroy();
});


test('window teardown drains a row one chunk per frame even while standing still', () => {
  const w = Object.create(WildsWindow.prototype) as InstanceType<typeof WildsWindow>;
  const dropped: string[] = [];
  const chunks = (keys: string[]) => new Map(keys.map((key) => [key, { destroy: () => dropped.push(key) }]));
  Object.assign(w, { deps: { hero: () => ({ x: 40, y: 428 }) }, plan: { attach: [], drift: [] }, heroTile: '', drops: 0,
    paints: new Map(), attached: chunks(['8,8', '9,8', '10,8']), fixed: chunks(['8,9', '9,9', '10,9']), drifts: new Map() });
  for (let i = 0; i < 6; i++) {
    w['dropBehind']();
    assert.equal(dropped.length, i + 1, 'one chunk per call on the same tile');
  }
  w['dropBehind']();
  assert.equal(w['drops'], 6);
  assert.equal(w['attached'].size + w['fixed'].size, 0);
});

test('draining releases generated and drift textures outside the fetched ring on the same tile', () => {
  const w = Object.create(WildsWindow.prototype) as InstanceType<typeof WildsWindow>;
  const removed: string[] = [];
  const chunk = { destroy() {} };
  Object.assign(w, { deps: { hero: () => ({ x: 40, y: 428 }), scene: { textures: {
    exists: () => true, remove: (key: string) => removed.push(key),
  } } }, plan: { attach: [], drift: [], fetch: ['9,8'] }, heroTile: '', drops: 0,
    attached: new Map([['8,8', chunk], ['9,8', chunk]]), fixed: new Map(), drifts: new Map([['10,8', chunk]]),
    paints: new Map(['8,8', '9,8', '10,8'].map((key) => [key, { key: `texture:${key}`, sig: '' }])) });
  w['dropBehind']();
  assert.deepEqual(removed, ['texture:8,8']);
  w['dropBehind']();
  assert.deepEqual(removed, ['texture:8,8'], 'a fetched chunk keeps its cached paint');
  w['dropBehind']();
  assert.deepEqual(removed, ['texture:8,8', 'texture:10,8']);
  assert.deepEqual([...w['paints'].keys()], ['9,8']);
});

test('fixed exit signs draw from cached labels without using the slice', (t) => {
  const r = rig();
  const exit = [...r.fp.objects.values()].flat().find((o) => o.id === 'exit:woodland')!;
  const fp = { ...r.fp, objects: new Map([['0,1', [exit, exit, exit]]]) };
  // Cached labels cost nothing to draw, so a chunk's exits never yield mid-signs.
  t.mock.method(performance, 'now', () => 0);
  const c = new FixedChunk(r.deps as never, fp, 0, 1);
  assert.equal(c.build(4), true, 'all exit signs draw in one pass');
  assert.equal(c.whole, true);
  assert.equal(r.scene.children.list.filter((o) => o.texture.key.startsWith('sign-label:')).length, 3, 'one cached label image per exit');
  c.destroy();
});

// Exercise the scene guards together: Body.reset also moves the sprite.
test('zero HP mouth slide and safeSpot stay on attached fixed ground', async () => {
  Phaser.Scene = class {};
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier.endsWith('/store.svelte')) return { url: 'data:text/javascript,export const ui = {}', shortCircuit: true };
    return next(specifier, context);
  } });
  const { WorldScene } = await import('../src/game/scenes/WorldScene.ts');
  hook.deregister();
  const s = Object.create(WorldScene.prototype) as InstanceType<typeof WorldScene>;
  const h = { x: 382, y: 386, body: {} };
  const body = { position: { x: 4, y: -64 }, prevFrame: { x: 0, y: 0 }, velocity: { x: 80, y: -80 },
    reset(x: number, y: number) { h.x = x; h.y = y; this.position = { x: 0, y: 0 }; },
    setVelocity(x: number, y: number) { this.velocity = { x, y }; } };
  h.body = body;
  Object.assign(s, { hero: { sprite: h, halt() {} }, session: { zeroHpLocked: true, state: { position: {} } },
    world: { areaId: 'outdoors' }, window: { hasFixed: (cx: number, cy: number) => cx === 0 && cy === 1 }, safeSpot: null });
  s['holdSafe'](1 / 60);
  s['holdFixed'](1 / 60);
  assert.deepEqual({ x: h.x, y: h.y }, { x: 382, y: 386 });
  assert.deepEqual(s['safeSpot'], { x: 382, y: 386 });
  // A safe but undelivered diagonal step must not become the saved safeSpot.
  body.position = { x: 4, y: 4 };
  s['holdSafe'](1 / 60);
  assert.deepEqual(s['safeSpot'], { x: 382, y: 390 });
  assert.equal(s['fixedReady'](s['safeSpot']!.x, s['safeSpot']!.y), true);
  body.position = { x: 4, y: -64 };
  s['holdSafe'](1 / 60);
  s['holdFixed'](1 / 60);
  s['notePosition']();
  assert.ok(h.x < 384);
  assert.ok(s['session'].state.position.x < 384);
  // A reset/warp onto missing ground cannot disable the fixed guard.
  h.x = 386;
  h.y = 386;
  s['holdFixed'](1 / 60);
  assert.ok(h.x < 384);
  const boot = new WorldScene();
  Object.assign(boot, { session: {}, waitingFixed: true, fixedWait: 3.9 });
  assert.equal(boot['frame'].hold(), 'cinematic');
  Object.assign(boot, { fixedWait: 4 });
  assert.equal(boot['frame'].hold(), null, 'cinematic hold ends after four seconds');
  const cues: string[] = [];
  const cue = (p: { text: string }) => cues.push(p.text);
  bus.on(EV.toast, cue);
  try {
    boot['waitForCommons']();
    boot['waitForCommons']();
    assert.deepEqual(cues, ['Waiting for the Commons…']);
  } finally { bus.off(EV.toast, cue); }
});

test('a throwing build stage is dropped and later stages and chunks continue', (t) => {
  const r = rig();
  const c = new FixedChunk(r.deps as never, r.fp, 0, 1);
  let throws = 0, later = 0;
  Object.assign(c, { todo: [() => { throws++; throw new Error('bad sign'); }, () => { later++; return true; }] });
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  let following = 0;
  r.builds.add({ build: () => { following++; return true; } } as never);
  r.builds.step(Infinity);
  r.builds.step(Infinity);
  assert.equal(throws, 1);
  assert.equal(later, 1);
  assert.equal(following, 1);
  assert.equal(errors.length, 1);
  assert.equal(c.whole, true);
  c.destroy();
});

test('drain keeps the chunk under the hero and reattaches a returned fixed chunk once', () => {
  const r = rig();
  const w = Object.create(WildsWindow.prototype) as InstanceType<typeof WildsWindow>;
  const hero = { x: 40, y: 428 };
  const c = new FixedChunk(r.deps as never, r.fp, 0, 1);
  Object.assign(w, { deps: { ...r.deps, hero: () => hero, session: {} }, builds: r.builds,
    fixed: new Map([['0,1', c]]), attached: new Map(), drifts: new Map(), far: new Map(),
    fixedGround: new Map([['hearthwick', r.g.ground]]), failedGround: new Set(),
    plan: { attach: [], drift: [], ring: [] }, waiters: [], heroTile: '', drops: 0, attaches: 1 });
  w['dropBehind']();
  assert.equal(w.hasFixed(0, 1), true, 'ground under hero is retained outside plan');
  hero.y = -1000;
  w['dropBehind']();
  assert.equal(w.hasFixed(0, 1), false);
  r.builds.step(Infinity);
  assert.equal(c.whole, true, 'destroy clears its pending stages');
  hero.y = 428;
  Object.assign(w, { plan: { attach: ['0,1'], drift: [], ring: [] } });
  w['step']();
  w['step']();
  assert.equal(w['attaches'], 2, 'one replacement attachment');
  assert.equal(w['fixed'].size, 1);
  w['fixed'].get('0,1')!.destroy();
});

test('window shutdown destroys chunks still waiting in the drain', () => {
  const w = Object.create(WildsWindow.prototype) as InstanceType<typeof WildsWindow>;
  const dropped: string[] = [];
  const chunks = (key: string) => new Map([[key, { destroy: () => dropped.push(key) }]]);
  Object.assign(w, { attached: chunks('generated'), fixed: chunks('fixed'), drifts: chunks('drift'),
    fixedGround: new Map(), paints: new Map(), far: new Map(), waiters: [] });
  w['destroy']();
  w['destroy']();
  assert.deepEqual(dropped, ['generated', 'fixed', 'drift']);
});

test('null fixed ground reports once and is never rebuilt each frame', (t) => {
  let maps = 0, destroyed = 0;
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const scene = { sys: { game: { renderer: { type: 1 } } }, textures: { exists: () => true },
    cache: { json: { get: () => null } }, make: { tilemap: () => {
      maps++;
      return { addTilesetImage: () => null, destroy: () => { destroyed++; } };
    } } };
  const w = Object.create(WildsWindow.prototype) as InstanceType<typeof WildsWindow>;
  Object.assign(w, { deps: { scene }, fixedGround: new Map(), failedGround: new Set(), fixed: new Map() });
  const fp = footprint('hearthwick')!;
  for (let i = 0; i < 60; i++) w['attachFixed'](fp, 0, 1);
  assert.equal(maps, 1);
  assert.equal(destroyed, 1, 'failed tilemap is released');
  assert.equal(errors.length, 1);
  assert.equal(w.hasFixed(0, 1), false);
});

test('all eight lot anchors seed their physical footprint and preserve saved world pixels', async () => {
  const { readFileSync } = await import('node:fs');
  const { decodeChunk } = await import('../src/lib/api/chunks.ts');
  const { PLACES } = await import('../src/lib/places.ts');
  const { fixedChunkKeys, serveFixed } = await import('../src/game/wilds/fixed.ts');
  const { outdoorStandAt } = await import('../src/game/wilds/wilds-world.ts');
  const place = PLACES.fixed.find((p) => p.id === 'homestead-lots')!;
  const fp = serveFixed(place, fixedChunkKeys(place).map(({ cx, cy }) => decodeChunk(new Uint8Array(readFileSync(new URL(`./fixtures/homestead-lots-${cx}-${cy}.bin`, import.meta.url))))));
  assert.ok(fp.reach.some(Boolean));
  for (let gate = 0; gate < 8; gate++) {
    const t = anchorTile(`hearthwick:lot:${gate}`);
    assert.deepEqual(fixedStand(t.tx, t.ty), t, `lot ${gate} remains on its doorstep`);
    const p = { x: t.tx * 16 + 6, y: t.ty * 16 + 9 };
    assert.deepEqual(outdoorStandAt(p.x, p.y), p, `lot ${gate} keeps saved pixels`);
  }
});

test('served artwork meets its collision footprint and woodland returns to the town anchor', async () => {
  const { sceneryOf, exitOf } = await import('../src/game/wilds/fixed.ts');
  const { buildArea } = await import('../src/game/worlds.ts');
  const fp = serveFixtureCommons();
  const objects = [...fp.objects.values()].flat();
  for (const o of objects.filter((o) => o.id.startsWith('fence:') || (o.kind === 'scenery' && o.tw > 0))) {
    assert.equal(sceneryOf(o)!.y, (o.ty + 1) * 16, o.id);
    if (o.tw > 0) assert.deepEqual(sceneryOf(o)!.groundUnder, { tx: o.tx, ty: o.ty - o.th + 1, tw: o.tw, th: o.th, tile: 0 });
  }
  for (const o of objects.filter((o) => o.kind === 'gather')) {
    assert.equal(o.art!.ox, 8); assert.equal(o.art!.oy, 16); assert.equal(o.art!.tile, true);
  }
  const well = objects.find((o) => o.id === 'town-well')!;
  assert.deepEqual({ x: sceneryOf(well)!.x, y: sceneryOf(well)!.y }, { x: 208, y: 992 });
  for (const ty of [60, 61]) for (const tx of [12, 13]) assert.equal(fixedSolidAt(tx, ty), true);
  const woodland = objects.find((o) => o.id === 'exit:woodland')!;
  assert.equal(exitOf(woodland, fp)!.label, woodland.label);
  const back = buildArea('woodland').exits.find((e) => e.tx === 0)!;
  assert.equal(back.to, 'outdoors'); assert.deepEqual(back.entry, anchorTile('hearthwick:east-road'));
  assert.equal(objects.find((o) => o.id === 'bunting')!.art!.depth, 5000);
});

test('calendar marks attach Mudrise shore and Quiet ice with their authored gather frames', () => {
  for (const [mark, wick, expected] of [['Mudrise', 'Thaw', 'freshet-shore'], ['Quiet', 'Leaf', 'pond-ice'], ['Bloom', 'Bloom', 'bloom-patch']]) {
    const r = rig();
    r.deps.day = () => ({ festival: '', wick: wick!, mark: mark! });
    const before = snapshot(r);
    const chunks = [...r.fp.objects.keys()].map((key) => { const [cx, cy] = key.split(',').map(Number); return new FixedChunk(r.deps as never, r.fp, cx!, cy!); });
    for (const c of chunks) r.builds.finish(c);
    const spots = [...r.gatherChunks.values()].flat() as { target: string; art: { frame?: string } }[];
    assert.equal(spots.filter((s) => s.target === expected).length, expected === 'bloom-patch' ? 5 : 3, mark);
    if (expected === 'freshet-shore') assert.deepEqual(spots.filter((s) => s.target === expected).map((s) => s.art.frame).sort(), ['pebbles-0', 'pebbles-1', 'pebbles-2']);
    for (const c of chunks) c.destroy();
    assert.deepEqual(snapshot(r), before);
  }
});

test('fishing floats use served ground and bank detach removes landing effects and timers', async () => {
  const { Fishing } = await import('../src/game/entities/fishing.ts');
  const { buildWildsWorld } = await import('../src/game/wilds/wilds-world.ts');
  const { createNewGame } = await import('../src/lib/state.ts');
  const r = rig(), world = buildWildsWorld();
  const before = snapshot(r);
  const fishing = new Fishing(r.scene as never, { world, session: { state: createNewGame(), link: null }, fx: {}, reducedMotion: true, hero: () => ({ sprite: { x: 552, y: 1166 } }), interactables: r.deps.interactables, notePosition() {} } as never);
  assert.equal(r.points.size, 0, 'no bank markers before a chunk attaches');
  fishing.attachChunk('1,3');
  Object.assign(fishing, { line: { water: 'water:village:mill-pond', bank: 'north', species: 'mill-roach', readyAt: Infinity, holdUntil: Infinity, predicted: false } });
  const at = fishing['floatSpot']();
  assert.ok(at, 'the open world has pond water despite its empty legacy ground grid');
  fishing['landing'](at, 'mill-roach');
  assert.ok(r.scene.timers.size > 0);
  assert.ok(snapshot(r).objects > before.objects);
  fishing.detachChunk('1,3');
  assert.equal(r.scene.timers.size, 0);
  assert.equal(r.points.size, 0);
  assert.equal(snapshot(r).objects, before.objects);
  assert.equal(snapshot(r).tweens, before.tweens);
  r.scene.events.emit('destroy');
  assert.deepEqual(snapshot(r), before, 'destroy without shutdown releases fishing listeners');
  assert.equal(r.scene.input.keyboard.listenerCount('keydown'), 0);
  assert.equal(r.scene.events.listenerCount('shutdown'), 0);
});

test('Pip runs out through the garden gap and her conversation listener leaves with her post', async () => {
  const { PipWalkOn } = await import('../src/game/entities/pip-walk-on.ts');
  const { Npcs } = await import('../src/game/entities/npcs.ts');
  const { fixedNpcs } = await import('../src/game/wilds/fixed.ts');
  const { buildWildsWorld } = await import('../src/game/wilds/wilds-world.ts');
  const { uiState } = await import('../src/game/input.ts');
  const r = rig(), world = buildWildsWorld();
  world.npcs = fixedNpcs().filter((n) => n.id === 'pip');
  const npcs = new Npcs(r.scene as never, world, r.scene.solids as never);
  const before = snapshot(r).listeners;
  assert.equal(world.open!.solidAt(16, 59), true, 'signpost occupies preferred target');
  const pip = new PipWalkOn(r.scene as never, { world, npcs, hero: () => ({ x: 15 * 16 + 8, y: 59 * 16 + 12 }) });
  assert.equal(pip.play(), true);
  const person = npcs.npcs[0]!;
  assert.ok(person.path!.points.some((p) => Math.floor(p.x / 16) === 9 && Math.floor((p.y - 1) / 16) === 76), 'garden rail gap is on the path');
  for (const p of person.path!.points) assert.equal(world.open!.solidAt(Math.floor(p.x / 16), Math.floor((p.y - 1) / 16)), false);
  person.path!.done();
  assert.ok(pip['closed'], 'waiting for the message to close');
  npcs.remove(['pip']); pip.detachChunk();
  assert.equal(pip['closed'], null);
  r.scene.events.emit('destroy');
  assert.equal(snapshot(r).listeners, before);
  assert.equal(r.scene.events.listenerCount('shutdown'), 0);
  uiState.dialogueOpen = false;
});

test('GoalGuide routes outdoor town goals directly and follows the arch and served room doors', async () => {
  const { GoalGuide } = await import('../src/game/entities/goal-guide.ts');
  const { buildWildsWorld } = await import('../src/game/wilds/wilds-world.ts');
  const r = rig(), world = buildWildsWorld();
  let position = { x: 72, y: 968 };
  let goal: unknown = { kind: 'quest', where: { area: 'hearthwick', npc: 'orrin' } };
  const guide = new GoalGuide(r.scene as never, { world, position: () => position, goal: () => goal, npcAt: () => ({ x: 280, y: 928 }), spotAt: () => null, enemyAt: () => null, wardenAt: () => null, lootAt: () => null, placeKind: () => null, guidePoint: () => ({ x: -568, y: 1096 }), reducedMotion: true, exits: () => [] } as never);
  assert.deepEqual(guide.target(), { x: 280, y: 928, here: true, id: 'orrin' });
  goal = { kind: 'quest', where: { area: 'woodland', spot: 'test' } };
  assert.deepEqual(guide.target(), { x: 680, y: 1000, here: false }, 'east-road anchor works before its exit chunk attaches');
  goal = { kind: 'guide', where: 'gate' };
  assert.deepEqual(guide.target(), { x: -568, y: 1096, here: true });
  position = { x: 40, y: 360 };
  assert.deepEqual(guide.target(), { x: 40, y: 424, here: false }, 'Tangle leads through Hearthwick’s arch');
  position = { x: 72, y: 968 };
  goal = { kind: 'quest', where: { area: 'in:village:library', spot: 'shelves' } };
  const target = guide.target()!;
  assert.equal(target.here, false);
  assert.equal(Math.floor(target.x / 16), -11, 'library door uses its signed world tile');
  r.scene.events.emit('destroy');
  assert.equal(r.scene.children.list.length, 0);
});

test('a cast answer after bank detach or scene destroy cancels its reservation and cannot restore the line', async () => {
  const { Fishing } = await import('../src/game/entities/fishing.ts');
  const { FISHING } = await import('../src/lib/fishing.ts');
  const { buildWildsWorld } = await import('../src/game/wilds/wilds-world.ts');
  const { createNewGame } = await import('../src/lib/state.ts');
  for (const end of ['detach', 'destroy']) {
    const r = rig(), before = snapshot(r);
    let answer!: (r: unknown) => void;
    const cancelled: string[] = [];
    const link = { online: true, server: {}, readWaters: async () => ({ ok: true, value: [] }), fishCast: () => new Promise((resolve) => { answer = resolve; }), fishCancel: async (id: string) => { cancelled.push(id); return { ok: true }; } };
    const fishing = new Fishing(r.scene as never, { world: buildWildsWorld(), session: { state: createNewGame(), link }, fx: {}, reducedMotion: true, hero: () => ({ sprite: { x: 552, y: 1166 } }), interactables: r.deps.interactables, notePosition() {} } as never);
    Object.assign(fishing, { rodInHand: () => 'fixture-rod', drawLine() {} });
    fishing.attachChunk('1,3');
    const water = FISHING.waters[0]!, bank = water.banks[0]!;
    const cast = fishing['cast'](water, bank);
    if (end === 'detach') fishing.detachChunk('1,3');
    else r.scene.events.emit('destroy');
    answer({ ok: true, result: { cast: { id: 'late-cast', water: water.id, bank: bank.id, species: 'mill-roach', readyAt: 0, holdUntil: Infinity, band: 'healthy' }, band: 'healthy' } });
    await cast;
    assert.deepEqual(cancelled, ['late-cast'], end);
    assert.equal(fishing.view().line, null);
    r.scene.events.emit('destroy');
    assert.deepEqual(snapshot(r), before);
  }
});

test('six claimed lots build in slices, refresh and detach without retaining home resources', async () => {
  const { HomesteadLayer } = await import('../src/game/entities/homesteads.ts');
  const { LotHomes } = await import('../src/game/wilds/lot-chunk.ts');
  const { HomesteadTalk } = await import('../src/game/entities/homestead-talk.ts');
  const { FixedScope } = await import('../src/game/wilds/fixed-scope.ts');
  const { serveFixtureLand } = await import('./land-fixture.ts');
  const { createNewGame } = await import('../src/lib/state.ts');
  serveFixtureLots();
  serveFixtureLand('guest', 8);
  const { setLandSource } = await import('../src/game/lot-land.ts');
  setLandSource({ worldId: () => 'guest', state: () => null, fetchLand: () => null });
  const r = rig();
  const owners = new Map<unknown, unknown[]>();
  const refreshes: string[] = [];
  const hero = { x: -61 * TILE + 8, y: 32 * TILE + 12, setVelocity() {} };
  const homes = new Map(Array.from({ length: 6 }, (_, gate) => [gate, {
    id: `home-${gate}`, worldId: 'guest', gate, tier: gate % 2 ? 2 : 0, landSeed: gate,
    member: gate === 0, desolate: false, members: [{ id: `owner-${gate}`, displayName: 'Owner' }],
    cleared: [], stumps: [], plants: [], yardPets: [{ pet: 'Cat-Base', ownerId: `owner-${gate}`, slot: 1 }], stalls: [],
    items: [
      { id: `stool-${gate}`, itemDef: 'wooden-stool', scene: 'outdoor', x: 9, y: 11, rotation: 0 },
      { id: `stable-${gate}`, itemDef: 'stable', scene: 'outdoor', x: 14, y: 11, rotation: 0, stalls: 1 }
    ]
  }]));
  const root = Object.assign(Object.create(HomesteadLayer.prototype), {
    scene: r.scene, gate: null, land: null, gone: false, yardRoom: null, commons: commonsLane(),
    homes: { homes, connected: false, myGate: null, myId: 'owner-0', status: 'guest', arrived() {}, gateInfo: () => ({ shelf: true, homeId: 'claimed', names: ['Owner'] }) },
    village: { waitingCount: () => 0 }, fixedScope: new FixedScope(true),
    deps: { session: { state: createNewGame(), link: null }, reducedMotion: false, hero: () => hero, solidGroup: r.scene.solids,
      world: { open: true, areaId: 'outdoors', npcs: [] }, refreshLot: (key: string) => refreshes.push(key),
      interactables: { register: (owner: unknown, points: unknown[]) => points.length ? owners.set(owner, points) : owners.delete(owner) } }
  }) as InstanceType<typeof HomesteadLayer>;
  Object.assign(root, { lots: new LotHomes(root), art: new HomesteadArt(root), talk: new HomesteadTalk(root) });
  const { HomesteadYard } = await import('../src/game/entities/homestead-yard.ts');
  const pendingPets: ((keys: string[]) => void)[] = [];
  const before = { ...snapshot(r), timers: r.scene.timers.size };
  const keys = ['-3,1', '-2,1', '-3,2', '-2,2', '-3,3', '-2,3'];
  for (let round = 0; round < 3; round++) {
    const steps = keys.map((key) => root.attachFixedChunk(key));
    for (const [gate, { child }] of root.lots!['lots']) Object.assign(child, { yard: new HomesteadYard(r.scene as never, false, () => hero, { x: (-72 + gate % 2 * 24) * TILE, y: (24 + Math.floor(gate / 2) * 24) * TILE }, () => new Promise((resolve) => pendingPets.push(resolve))) });
    assert.ok(steps.every((s) => s.length >= 7), 'site, mailbox and each furnishing are separate steps');
    assert.deepEqual({ ...snapshot(r), timers: r.scene.timers.size }, before, 'enqueueing draws nothing');
    // Simulate an exhausted frame, then one home step per lot per frame.
    const jobs = steps.map((queue) => ({ build(deadline: number) { while (queue.length && performance.now() < deadline) queue.shift()!(); return !queue.length; }, destroy() {} }));
    jobs.forEach((j) => assert.equal(j.build(performance.now() - 1), false));
    assert.deepEqual({ ...snapshot(r), timers: r.scene.timers.size }, before);
    while (steps.some((s) => s.length)) steps.forEach((s) => s.shift()?.());
    if (round === 0) {
      pendingPets.splice(0).forEach((resolve) => resolve(['yard-pet-fixture']));
      await Promise.resolve(); await Promise.resolve();
      assert.equal(r.scene.children.list.filter((o) => o.texture.key === 'yard-pet-fixture').length, 6);
      assert.ok(r.scene.children.list.filter((o) => o.texture.key === 'yard-pet-fixture').every((o) => o.x < 0 && o.y >= 24 * TILE));
    }
    assert.ok(r.scene.children.list.some((o) => o.texture.key === 'camp-patch'));
    assert.ok(r.scene.children.list.some((o) => o.texture.key.startsWith('cottage')));
    assert.ok([...owners.keys()].length >= 6, 'each lot publishes its own interactions');
    const child = root.lots!['lots'].get(0)!.child;
    const originalWindow = globalThis.window;
    const dom = new EventEmitter();
    globalThis.window = { addEventListener: (e: string, fn: (...args: unknown[]) => void) => dom.on(e, fn), removeEventListener: (e: string, fn: (...args: unknown[]) => void) => dom.off(e, fn) } as unknown as Window & typeof globalThis;
    try {
      child.arranging.update(1);
      child.arranging.startPlacement();
      assert.equal(child.arranging.placement?.ox, -72 * TILE);
      assert.equal(child.arranging.placement?.oy, 24 * TILE);
      assert.equal(child.arranging.placement?.cols, 24);
      root.lots!.refresh(new Set([0]));
      assert.equal(refreshes.length, round, 'active Arrange defers its fixed refresh');
      child.arranging.endPlacement();
      root.lots!.update(0);
      assert.equal(refreshes.at(-1), '-3,1', 'deferred refresh flushes after Arrange');
      root.detachFixedChunk('-3,1');
      assert.equal(dom.listenerCount('keydown'), 0);
      assert.equal(r.scene.input.listenerCount('pointerdown'), 0);
      assert.equal(r.scene.scale.listenerCount('resize'), 0);
    } finally { globalThis.window = originalWindow; }
    keys.slice(1).forEach((key) => root.detachFixedChunk(key));
    pendingPets.splice(0).forEach((resolve) => resolve(['yard-pet-fixture']));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(owners.size, 0);
    assert.deepEqual({ ...snapshot(r), timers: r.scene.timers.size }, before);
    // Streaming away halfway through construction makes queued steps inert.
    const partial = root.attachFixedChunk(keys[0]!);
    partial.shift()!();
    root.detachFixedChunk(keys[0]!);
    partial.forEach((step) => step());
    assert.deepEqual({ ...snapshot(r), timers: r.scene.timers.size }, before);
  }
  root.lots!.destroy();
});

test('plot overlays open only cleared local obstacles and restore the immutable base', async () => {
  const { applyLotHome } = await import('../src/game/wilds/fixed.ts');
  serveFixtureLots();
  const base = footprint('homestead-lots')!;
  const obstacle = base.objects.get('-3,1')!.find((o) => o.id.startsWith('land:'))!;
  const x = obstacle.tx + 72, y = obstacle.ty - 24;
  const savedSolid = base.solid.map((r) => [...r]);
  const home = { worldId: 'fixture-world', cleared: [[x, y]], stumps: [], plants: [] };
  applyLotHome(0, home as never);
  assert.equal(fixedSolidAt(obstacle.tx, obstacle.ty), false);
  assert.ok(!footprint('homestead-lots')!.objects.get('-3,1')!.some((o) => o.id === obstacle.id));
  assert.deepEqual(base.solid, savedSolid, 'cached base stays immutable');
  applyLotHome(0, null);
  assert.equal(fixedSolidAt(obstacle.tx, obstacle.ty), true);
  applyLotHome(0, { ...home, worldId: 'other-world' } as never);
  assert.equal(fixedSolidAt(obstacle.tx, obstacle.ty), true, 'old-world state cannot clear this world');
});

test('a late plot read from a previous world cannot replace the new world footprint', async () => {
  const { readFileSync } = await import('node:fs');
  const { decodeChunk } = await import('../src/lib/api/chunks.ts');
  const { prepareFixed } = await import('../src/game/wilds/fixed.ts');
  const { lotAt } = await import('../src/lib/lots.ts');
  serveFixtureCommons();
  forgetChunks();
  const waiting: { epoch: string; cx: number; cy: number; resolve: (value: unknown) => void }[] = [];
  const api = { chunk: (epoch: string, _layer: number, cx: number, cy: number) => new Promise((resolve) => waiting.push({ epoch, cx, cy, resolve })) };
  const old = prepareFixed({ link: { worldId: 'old-world', api: { operations: api } } } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const fresh = prepareFixed({ link: { worldId: 'new-world', api: { operations: api } } } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const answer = (world: string) => waiting.filter((w) => w.epoch.startsWith(`plot:${world}:`)).forEach((w) => {
    const chunk = decodeChunk(readFileSync(new URL(`./fixtures/plot-${lotAt(w.cx, w.cy)}.bin`, import.meta.url)));
    w.resolve({ ...chunk, epochId: w.epoch });
  });
  assert.equal(waiting.length, 8);
  // Concurrency limit of 8: resolve old requests to release slots for new world requests
  answer('old-world');
  await old;
  assert.equal(footprint('homestead-lots'), null, 'old completion cannot install into new world');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(waiting.filter((w) => w.epoch.startsWith('plot:new-world:')).length, 8);
  answer('new-world');
  await fresh;
  assert.equal(footprint('homestead-lots')?.epoch, 'plot:new-world@3');
  forgetFixed(); forgetChunks(); serveFixtureCommons(); serveFixtureLots();
});

test('town and woodland exit signs retain their authored lore keys', async () => {
 const { gateSignKey } = await import('../src/game/entities/touches.ts');
 const { signCopy } = await import('../src/content/touches.ts');
 assert.equal(gateSignKey('hearthwick', 'woodland'), 'gate:village:woodland');
 assert.equal(gateSignKey('woodland', 'outdoors'), 'gate:woodland:village');
 for (const [place,to] of [['hearthwick','woodland'],['woodland','outdoors']]) assert.notDeepEqual(signCopy(gateSignKey(place!,to!)), signCopy('sign:generic'));
});

test('HouseLights owns world-coordinate glass and smoke only while its chunk is attached', async () => {
 const { HouseLights } = await import('../src/game/entities/house-lights.ts');
 const { buildWildsWorld } = await import('../src/game/wilds/wilds-world.ts');
 const { ROOMS } = await import('../src/lib/rooms.ts');
 serveFixtureCommons();
 const r=rig(), lights=new HouseLights(r.scene as never,{world:buildWildsWorld(),reducedMotion:false});
 const before=snapshot(r);
 assert.equal(lights.view().length,0);
 const room=ROOMS.rooms.find((r)=>r.outside?.building==='house-west')!;
 const window=room.outside!.window!, chimney=room.outside!.chimney!;
 const key=chunkOfTile(window.tx,window.ty);
 const steps=lights.attachChunk(key);
 assert.deepEqual(snapshot(r),before,'queued lights draw nothing');
 steps.forEach((draw)=>draw());
 const glass=r.scene.children.list.find((o)=>o.type==='Rectangle')!;
 assert.deepEqual({x:glass.x,y:glass.y},{x:window.tx*16+10,y:window.ty*16+7});
 assert.ok(glass.depth>900,'glass sorts above the world building');
 assert.ok(r.scene.children.list.some((o)=>o.x===chimney.x && o.y===chimney.y));
 lights.refresh();
 assert.equal(glass.visible,!lights.view().find((l)=>l.room===room.id)!.window);
 lights.detachChunk(key);
 assert.deepEqual(snapshot(r),before);
 const late=lights.attachChunk(key);lights.detachChunk(key);late.forEach((draw)=>draw());
 assert.deepEqual(snapshot(r),before,'late build cannot restore lights');
 lights.attachChunk(key).forEach((draw)=>draw());r.scene.events.emit('destroy');
 assert.equal(r.scene.children.list.length,0);assert.equal(r.scene.events.eventNames().length,0);
});

test('fishing proximity uses the supplied water rather than the first water in the area', async () => {
 const { Fishing }=await import('../src/game/entities/fishing.ts');
 const { waterFor,bankFor }=await import('../src/lib/fishing.ts');
 const first=waterFor('water:village:mill-pond')!, bank=bankFor(first,'north')!;
 const fish=Object.assign(Object.create(Fishing.prototype),{deps:{world:{areaId:'outdoors'},hero:()=>({sprite:{x:(bank.tiles[0]!.tx+0.5)*16,y:(bank.tiles[0]!.ty+0.5)*16}})},waters:[{...first,area:'woodland'}]}) as InstanceType<typeof Fishing>;
 assert.equal(fish['heroWithin'](first,bank,48),true);
 assert.equal(fish['heroWithin']({...first,area:'woodland'},bank,48),false);
});


test('real window chunks slice six lot facades, defer Arrange refresh and clean up on shutdown', async (t) => {
  const { HomesteadLayer } = await import('../src/game/entities/homesteads.ts');
  const { LotHomes } = await import('../src/game/wilds/lot-chunk.ts');
  const { HomesteadTalk } = await import('../src/game/entities/homestead-talk.ts');
  const { FixedScope } = await import('../src/game/wilds/fixed-scope.ts');
  const { serveFixtureLand } = await import('./land-fixture.ts');
  const { createNewGame } = await import('../src/lib/state.ts');
  serveFixtureLots();
  serveFixtureLand('guest', 8);
  const { setLandSource } = await import('../src/game/lot-land.ts');
  setLandSource({ worldId: () => 'guest', state: () => null, fetchLand: () => null });
  const r = rig();
  const owners = new Map<unknown, unknown[]>();
  const refreshes: string[] = [];
  const hero = { x: -61 * TILE + 8, y: 32 * TILE + 12, setVelocity() {} };
  const homes = new Map(Array.from({ length: 6 }, (_, gate) => [gate, {
    id: `home-${gate}`, worldId: 'guest', gate, tier: gate % 2 ? 2 : 0, landSeed: gate,
    member: gate === 0, desolate: false, members: [{ id: `owner-${gate}`, displayName: 'Owner' }],
    cleared: [], stumps: [], plants: [], yardPets: [{ pet: 'Cat-Base', ownerId: `owner-${gate}`, slot: 1 }], stalls: [],
    items: [
      { id: `stool-${gate}`, itemDef: 'wooden-stool', scene: 'outdoor', x: 9, y: 11, rotation: 0 },
      { id: `stable-${gate}`, itemDef: 'stable', scene: 'outdoor', x: 14, y: 11, rotation: 0, stalls: 1 }
    ]
  }]));
  const root = Object.assign(Object.create(HomesteadLayer.prototype), {
    scene: r.scene, gate: null, land: null, gone: false, yardRoom: null, commons: commonsLane(),
    homes: { homes, connected: false, myGate: null, myId: 'owner-0', status: 'guest', arrived() {}, gateInfo: () => ({ shelf: true, homeId: 'claimed', names: ['Owner'] }) },
    village: { waitingCount: () => 0 }, fixedScope: new FixedScope(true),
    deps: { session: { state: createNewGame(), link: null }, reducedMotion: false, hero: () => hero, solidGroup: r.scene.solids,
      world: { open: true, areaId: 'outdoors', npcs: [] }, refreshLot: (key: string) => refreshes.push(key),
      interactables: { register: (owner: unknown, points: unknown[]) => points.length ? owners.set(owner, points) : owners.delete(owner) } }
  }) as InstanceType<typeof HomesteadLayer>;
  Object.assign(root, { lots: new LotHomes(root), art: new HomesteadArt(root), talk: new HomesteadTalk(root) });

  // Only the tilemap renderer is faked. Window plans, chunk construction,
  // the build queue, facade drawing and scene shutdown are production paths.
  const groundProto = WildsWindow.prototype as unknown as { groundFor: () => unknown };
  t.mock.method(groundProto, 'groundFor', () => r.g.ground);
  let following = true;
  r.scene.cameras.main.stopFollow = () => { following = false; };
  r.scene.cameras.main.startFollow = () => { following = true; };
  const w = new WildsWindow({ ...r.deps, session: root.deps.session, hero: () => hero, hooks: () => ({ attach: (key: string) => root.attachFixedChunk(key), detach: (key: string, refreshing?: boolean) => root.detachFixedChunk(key, refreshing) }) } as never);
  Object.assign(root.deps, { refreshLot: (key: string) => w.refreshFixed(key) });
  // A position-derived 3x3 window centred on the shared spine contains six lots.
  hero.x=-48*TILE; hero.y=60*TILE;
  w['recentre'](-2,2);
  w['plan']!.attach = w['plan']!.attach.filter((key) => key.startsWith('-3,') || key.startsWith('-2,'));
  for (let i=0;i<6;i++) assert.equal(w['step'](),true);
  assert.equal(w['fixed'].size,6);
  assert.equal(root.lots!['lots'].size,0,'fixture stage has not run synchronously');
  let clock=0;
  t.mock.method(performance,'now',()=>{clock+=0.01;return clock;});
  w.builds.step(clock+1);
  assert.ok([...w['fixed'].values()].some((c)=>!c.whole),'one walking slice never drains all chunks');
  for(let i=0;i<500 && [...w['fixed'].values()].some((c)=>!c.whole);i++) w.builds.step(clock+8);
  assert.equal(root.lots!['lots'].size,6);
  // An invalidation while a read is in flight must get one follow-up read,
  // even before a facade exists; rebuilding a facade must not reset freshness.
  let reads=0;const answers: (()=>void)[]=[];
  Object.assign(root.homes,{connected:true,fetchHome:async(gate:number)=>{if(gate===0){reads++;await new Promise<void>((resolve)=>answers.push(resolve));}return homes.get(gate);}});
  root.lots!.invalidate(0);root.lots!.invalidate(0);
  assert.equal(reads,1);
  answers.shift()!();await Promise.resolve();await Promise.resolve();
  assert.equal(reads,2);
  answers.shift()!();await Promise.resolve();await Promise.resolve();
  const child=root.lots!['lots'].get(0)!.child;
  hero.x=-61*TILE+8;hero.y=32*TILE+8;
  const originalWindow=globalThis.window;
  const dom=new EventEmitter();
  globalThis.window={addEventListener:(e:string,fn:()=>void)=>dom.on(e,fn),removeEventListener:(e:string,fn:()=>void)=>dom.off(e,fn)} as unknown as Window & typeof globalThis;
  try {
    child.arranging.update(1);child.arranging.startPlacement();assert.equal(following,false);
    root.lots!.refresh(new Set([0,1]));
    assert.equal(w['seasonalPending'].has('-3,1'),false,'placing lot waits');
    assert.equal(w['seasonalPending'].has('-2,1'),true,'other lot still refreshes');
    child.arranging.endPlacement();assert.equal(following,true);
    root.lots!.update(0);assert.equal(w['seasonalPending'].has('-3,1'),true);
    const old=w['fixed'].get('-2,1')!;
    w.update(0);assert.equal(old.whole,true,'old pending job is cancelled');
    w.update(0); // the deferred active-lot key also rebuilds through the window queue
    for(let i=0;i<500 && [...w['fixed'].values()].some((c)=>!c.whole);i++) w.builds.step(clock+8);
    assert.equal(reads,2,'overlay rebuild did not fetch again');
    assert.equal(root.lots!['read'].has(0),true);
    // Mid-Arrange shutdown exercises the real chunk detach path and restores follow.
    const active=root.lots!['lots'].get(0)!.child;
    active.arranging.update(1);active.arranging.startPlacement();assert.equal(following,false);
    r.scene.events.emit('shutdown');
    assert.equal(following,true);assert.equal(root.lots!['lots'].size,0);
    assert.equal(root.lots!['read'].has(0),false,'real streaming/scene detach requires a fresh read on revisit');
    assert.equal(dom.listenerCount('keydown'),0);
    assert.equal(r.scene.input.listenerCount('pointerdown'),0);
    assert.equal(r.scene.scale.listenerCount('resize'),0);
    assert.equal(w['fixed'].size,0);
    w.builds.step(clock+1000);
    assert.equal(r.scene.solids.members.size,0);
    assert.equal(r.scene.bodies.size,0);
  } finally {globalThis.window=originalWindow;w['destroy']();root.lots!.destroy();}
});

test('late fixed fixtures join once through the queue, including an already built chunk', () => {
  serveFixtureCommons();const r=rig();let ready=false,attaches=0,draws=0;
  const hooks={ attach:()=>{attaches++;return [()=>draws++];},detach:()=>{} };
  const c=new FixedChunk({...r.deps,hooks:()=>ready?hooks:null} as never,r.fp,0,1);
  r.builds.step(Infinity);assert.equal(draws,0);
  ready=true;c.fixturesReady();c.fixturesReady();
  assert.equal(draws,0,'late callback never draws synchronously');
  r.builds.step(Infinity);assert.equal(attaches,1);assert.equal(draws,1);
  c.fixturesReady();r.builds.step(Infinity);assert.equal(draws,1);
  c.destroy();
});

test('a late homestead layer joins an existing FixedLife hook once, without rebuilding the other fixtures', async () => {
  const { FixedLife } = await import('../src/game/wilds/fixed-life.ts');
  serveFixtureCommons();const r=rig();let ready=false,attaches=0,draws=0,detaches=0;
  const homeHooks={attach:()=>{attaches++;return [()=>draws++];},detach:()=>{detaches++;}};
  const life=new FixedLife({homes:()=>ready?homeHooks:null} as never);
  const hooks={attach:()=>[],late:(key:string)=>life.late(key),detach:(key:string)=>{if(life['homeKeys'].delete(key))homeHooks.detach();}};
  const c=new FixedChunk({...r.deps,hooks:()=>hooks} as never,r.fp,0,1);
  r.builds.step(Infinity);
  ready=true;c.fixturesReady();c.fixturesReady();
  assert.equal(attaches,1);assert.equal(draws,0);
  r.builds.step(Infinity);assert.equal(draws,1);
  c.destroy();assert.equal(detaches,1);
});

test('a usable gate shelf placement beats a nearer mailbox, only inside its own gate', async () => {
  serveFixtureCommons();
  serveFixtureLots();
  const { HomesteadTalk } = await import('../src/game/entities/homestead-talk.ts');
  const { Interactables } = await import('../src/game/entities/interactables.ts');
  const lane = commonsLane()!;
  const slot = lane.gates[0]!;
  const hero = { x: (slot.tx + 1) * 16 + 8, y: slot.ty * 16 + 8 };
  const scene = new FakeScene();
  const talk = new HomesteadTalk({ scene, deps: { world: { areaId: 'outdoors', npcs: [] }, hero: () => hero }, commons: lane,
    homes: { gateInfo: (gate: number) => ({ mine: gate === 0 }), mine: { items: [{ id: 'new-shelf', itemDef: 'gate-shelf', scene: null }] } },
  } as never);
  const placement = talk.interactionList().find((p) => p.id === 'home:place-shelf:new-shelf')!;
  assert.ok(placement);
  const picker = new Interactables(scene as never, { reducedMotion: true });
  const mailbox = { id: 'home:mail', x: hero.x + 16, y: hero.y - 16, label: 'Open the mailbox', activate() {} } as const;
  picker.register({}, [mailbox, placement]);
  assert.equal(picker.pick(hero)?.id, placement.id);
  hero.y += 16; // Public lane immediately south of the gate.
  assert.notEqual(picker.pick(hero)?.id, placement.id);
});

test('flower touches belong to visible authored flowers and detach with their chunk', async () => {
  const fp = serveFixtureCommons();
  const { Touches } = await import('../src/game/entities/touches.ts');
  const { Interactables } = await import('../src/game/entities/interactables.ts');
  const picker = new Interactables(new FakeScene() as never, { reducedMotion: true });
  const touches = new Touches({ world: { props: [], exits: [] }, interactables: picker } as never);
  const flowers = [...fp.objects.values()].flat().filter((o) => o.variant === 'wildflowers' && o.art);
  assert.ok(flowers.length > 0, 'real Bloom flower art is served in Hearthwick');
  const owner = {};
  touches.attachChunk(owner, [], 0, 'hearthwick', flowers.filter((o) => objectOut(o, { festival: null, wick: 'Quiet' })));
  assert.equal(picker.list.length, 0);
  touches.attachChunk(owner, [], 0, 'hearthwick', flowers.filter((o) => objectOut(o, { festival: null, wick: 'Bloom' })));
  assert.equal(picker.list.length, flowers.length);
  for (const flower of flowers) {
    const point = picker.pick({ x: flower.tx * 16 + flower.art!.ox, y: flower.ty * 16 + flower.art!.oy });
    assert.equal(point?.verb, 'Smell');
  }
  touches.detachChunk(owner);
  assert.equal(picker.list.length, 0);
  touches.attachFlowers(owner, [{ x: -120, y: -50 }]);
  assert.equal(picker.pick({ x: -120, y: -50 })?.verb, 'Smell');
  touches.attachFlowers(owner, []);
  assert.equal(picker.list.length, 0, 'a picked generated flower loses its touch');
});

test('the owner can open the placed shelf from inside the gate to put it away', async () => {
  serveFixtureCommons();
  serveFixtureLots();
  const { HomesteadTalk } = await import('../src/game/entities/homestead-talk.ts');
  const { Interactables } = await import('../src/game/entities/interactables.ts');
  const slot = commonsLane()!.gates[0]!;
  const hero = { x: (slot.tx + 1) * 16 + 8, y: slot.ty * 16 + 8 };
  const scene = new FakeScene();
  const talk = new HomesteadTalk({ scene, deps: { world: { areaId: 'outdoors', npcs: [] }, hero: () => hero }, commons: commonsLane(),
    homes: { gateInfo: (gate: number) => ({ mine: gate === 0, shelf: gate === 0 }) },
  } as never);
  const picker = new Interactables(scene as never, { reducedMotion: true });
  picker.register({}, [...talk.interactionList(), { id: 'home:mail', x: hero.x + 16, y: hero.y - 16, label: 'Open the mailbox', activate() {} }]);
  assert.equal(picker.pick(hero)?.label, 'Look at the gift shelf', 'management must be reachable where removal is permitted');
  hero.y += 16;
  const management = picker.list.find((p) => p.id === 'home:manage-shelf:0')!;
  assert.equal(management.available?.(), false, 'the priority management point stops at the fence');
});

test('fixed chunk attach makes no new textures after pre-warming, including when the footprint arrives on fixedReady', async (t) => {
  const { Interactables } = await import('../src/game/entities/interactables.ts');
  const { RepairsLayer } = await import('../src/game/entities/repairs.ts');
  const { buildWildsWorld } = await import('../src/game/wilds/wilds-world.ts');
  const { villageFor } = await import('../src/game/village.ts');
  const { createNewGame } = await import('../src/lib/state.ts');
  const { repairsForArea } = await import('../src/lib/repairs.ts');
  const r = rig();
  const footprints = [r.fp, footprint('homestead-lots')!];
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: false,
        globalAlpha: 1,
        fillStyle: '',
        fillRect() {},
        setTransform() {},
        drawImage() {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
    }),
  } as unknown as Document;
  try {
    const lazy = (key?: string) => !!key && (/^(hedge|fence)-(h|v)-/.test(key) || key.startsWith('repair-'));
    r.scene.textures.exists = (key) => !lazy(key) || r.scene.textures.added.includes(key!);
    const world = buildWildsWorld();
    const interactions = new Interactables(r.scene as never, { reducedMotion: false });
    r.deps.interactables = interactions as never;
    const session = { state: createNewGame(), questStage: 'complete', link: {} } as never;
    const model = villageFor(session);
    model.repairsStatus = 'ready';
    model.repairs.open = repairsForArea('outdoors').map((d) => ({ id: d.id })) as never;
    const repairs = new RepairsLayer(r.scene as never, { world, session, fx: {}, reducedMotion: false, interactables: r.deps.interactables } as never);
    r.deps.hooks = () => ({
      attach: (key: string) => [() => repairs.attachChunk(key)],
      detach: (key: string) => repairs.detachChunk(key),
    }) as never;

    assert.deepEqual(r.scene.textures.added, []);
    for (const fp of footprints) prewarmFixedArt(r.scene as never, fp);
    const warmed: string[] = [...r.scene.textures.added];
    for (const run of ['fence-v-5', 'fence-v-15', 'fence-h-14', 'fence-h-8', 'repair-hame-broken']) {
      assert.ok(warmed.includes(run), `pre-warmed ${run}`);
    }

    for (let round = 0; round < 2; round++) {
      const chunks = footprints.flatMap((fp) => [...fp.objects.keys()].map((k) => {
        const [cx, cy] = k.split(',').map(Number) as [number, number];
        return new FixedChunk(r.deps as never, fp, cx, cy);
      }));
      for (const c of chunks) r.builds.finish(c);
      assert.deepEqual(r.scene.textures.added, warmed, `round ${round}: attach makes no new textures`);
      for (const c of chunks) c.destroy();
      assert.deepEqual(r.scene.textures.added, warmed, `round ${round}: detach keeps pre-warmed textures`);
    }

    // Late arrival during the boot hold: EV.fixedReady queues pre-warming onto builds and spreads it across slices.
    r.scene.textures.added.length = 0;
    forgetFixed();
    const winScene = {
      ...r.scene,
      sys: { isActive: () => true, game: { renderer: { type: 1 } } },
      cache: { json: { get: () => null } },
      make: {
        ...r.scene.make,
        tilemap: () => ({
          ...r.g.ground.map,
          addTilesetImage: () => ({ texCoordinates: [] }),
          destroy() {},
        }),
      },
    };
    const listeners = bus.listenerCount(EV.fixedReady);
    const w = new WildsWindow({ ...r.deps, scene: winScene as never, hero: () => ({ x: 40, y: 424 }), session } as never);
    assert.deepEqual(r.scene.textures.added, [], 'nothing warmed before fixed chunks arrive');
    serveFixtureCommons();
    let clock = 0;
    t.mock.method(performance, 'now', () => (clock += 2));
    bus.emit(EV.fixedReady);
    assert.equal(w.builds['waiting'].length, 2, 'town and lots each queue a pre-warm job');
    bus.emit(EV.fixedReady);
    assert.equal(w.builds['waiting'].length, 2, 'another fixed-ready event does not duplicate pre-warming');
    w.builds.step(5);
    assert.ok(r.scene.textures.added.length > 0 && r.scene.textures.added.length < warmed.length, 'spread across slices');
    w.builds.step(Infinity);
    assert.deepEqual(r.scene.textures.added, warmed, 'all footprint textures warmed before chunks build');
    winScene.events.emit('destroy');
    assert.equal(bus.listenerCount(EV.fixedReady), listeners, 'destroy releases the fixed-ready listener without shutdown');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('claimed lot shade reaches the fence and rear edge, replaces one texture, and leaves public lanes clear', () => {
  const scene = new FakeScene();
  let claimed = true;
  const home = { scene, deps: {}, land: { width: 24, height: 24, gridOrigin: { x: -1152, y: 384 } }, here: () => claimed ? { items: [], desolate: false } : null };
  const art = new HomesteadArt(home as never);
  const created: number[][] = [];
  const make = scene.textures.createCanvas;
  scene.textures.createCanvas = (key: string, ...size: number[]) => { created.push(size); return make(key); };
  art.drawShade();
  const image = scene.children.list.find((o) => o.texture.key.startsWith('lot-shade:'))!;
  assert.deepEqual([image.x, image.y], [-1120, 384], 'shade starts at the fence margin and back edge');
  assert.deepEqual(created, [[320, 320]], 'ends at x22/y20 before the public spine/cross-lane');
  art.drawShade();
  assert.equal(scene.textures.added.filter((key) => key.startsWith('lot-shade:')).length, 1);
  assert.equal(image.alive, false, 'redraw destroys the old image before its texture');
  claimed = false;
  art.drawShade();
  assert.equal(scene.textures.added.filter((key) => key.startsWith('lot-shade:')).length, 0, 'no home means no lamp shade');
  claimed = true;
  art.drawShade();
  art.destroyLand();
  assert.equal(scene.textures.added.filter((key) => key.startsWith('lot-shade:')).length, 0, 'detach releases the generated texture');
});
