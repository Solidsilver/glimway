import test from 'node:test';
import assert from 'node:assert/strict';
import { G, SURFACE } from '../src/game/height-lab/area.ts';
import { KIND, TILE_PX, findPath, move, step, zAt, E, type Walker } from '../src/game/height-lab/levels.ts';
import { WALK_RECIPE, buildWalkArea, decodeWalk, loadWalk, reachFrom, resumeAt, walkHere, type Strategy, type WalkWire } from '../src/game/height-lab/walk.ts';

/**
 * The generated area (src/game/height-lab/walk.ts) from a server answer
 * (server/internal/worldlab/walk.go): a small hand-made window, two chunks
 * wide, in negative world coordinates. West chunk level 0, east chunk
 * level 1 (a rim between them); the region plan's ramp joins them, the
 * per-chunk plan has none and strands the east chunk.
 */

const W = 48;
const H = 24;
const N = W * H;
const b64 = (a: Uint8Array | Int16Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

function strategy(ramp: boolean): WalkWire['strategies']['region'] {
  const kind = new Uint8Array(N);
  const top = new Uint8Array(N);
  const edges = new Int16Array(N * 4);
  const face = new Uint8Array(N * 3);
  const flags = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % W;
    const z = x >= 24 ? 1 : 0;
    top[i] = z;
    edges.fill(z * 256, i * 4, i * 4 + 4);
    if (!ramp && z === 1) flags[i] = 4;
  }
  // A face: rows 20–22 of the west chunk, below a level-1 lip at row 19 (cols 4–6).
  for (let y = 16; y <= 19; y++) for (let x = 4; x <= 6; x++) { top[y * W + x] = 1; edges.fill(256, (y * W + x) * 4, (y * W + x) * 4 + 4); }
  for (let r = 0; r < 3; r++) for (let x = 4; x <= 6; x++) {
    const i = (20 + r) * W + x;
    kind[i] = 1;
    edges.fill(-1, i * 4, i * 4 + 4);
    face.set([1, r, 3], i * 3);
  }
  if (ramp) {
    // Two lanes east along rows 10–11, x 18..23, from level 0 (x 17) to level 1 (x 24), as wilds.carveRamp.
    const n = 6;
    for (const y of [10, 11])
      for (let k = 1; k <= n; k++) {
        const i = y * W + 17 + k;
        kind[i] = 2;
        const lo = Math.trunc((256 * (k - 1)) / n);
        const hi = Math.trunc((256 * k) / n);
        edges.set([y === 10 ? -1 : Math.trunc((lo + hi) / 2), hi, y === 11 ? -1 : Math.trunc((lo + hi) / 2), lo], i * 4);
        flags[i] = 2;
      }
  }
  const certificate = { components: ramp ? 2 : 3, strandedComponents: ramp ? 1 : 2, strandedTiles: ramp ? 9 : 9 + 24 * 24, walkableTiles: N - 9, heldExits: 0, heldExitsKept: 0, anchors: 1, anchorsReached: 1 };
  return { kind: b64(kind), top: b64(top), edges: b64(edges), face: b64(face), flags: b64(flags), ramps: ramp ? 1 : 0, rejectedOptionalFloorTiles: 0, certificate, stranded: null, solveMs: 1 };
}

function wire(): WalkWire {
  const ground = new Uint8Array(N);
  const prop = new Uint8Array(N);
  const water = new Uint8Array(N);
  const biome = new Uint8Array(N);
  const region = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % W;
    ground[i] = x >= 24 ? 2 : 0;
    biome[i] = x >= 24 ? 1 : 0;
    region[i] = x >= 30 ? 1 : 0;
  }
  prop[5 * W + 3] = 1; // an oak in the open
  prop[6 * W + 8] = 3; // a fern: doesn't block
  prop[19 * W + 5] = 1; // on the lip above the face: left out
  water[2 * W + 10] = 1;
  return {
    recipe: WALK_RECIPE,
    seed: 'map',
    epoch: 't:1:2',
    x0: -48,
    y0: -24,
    w: W,
    h: H,
    chunks: [-2, -1, 2, 1],
    tops: b64(new Uint8Array(N)),
    grounds: ['meadow', 'wq-ivory', 'tops-moor', 'no-such-ground'],
    ground: b64(ground),
    propKinds: ['oak', 'pine', 'fern'],
    prop: b64(prop),
    water: b64(water),
    biomes: ['hearthwick-woods@1', 'tops@1'],
    biome: b64(biome),
    regions: ['r:-1:-1', 'r:0:-1'],
    region: b64(region),
    strategies: { region: strategy(true), chunk: strategy(false) },
    anchors: [{ name: 'home', x: 2, y: 2 }, { name: 'tangle', x: 10, y: 6 }],
    spots: [{ name: 'home', x: 2, y: 2 }],
    timingsMs: {},
    note: ''
  };
}

const data = decodeWalk(wire());
const area = (s: Strategy) => buildWalkArea(data, s, { skyTiles: 6 });
const walker = (tx: number, ty: number): Walker => ({ x: tx * TILE_PX + 8, y: ty * TILE_PX + 10, layer: SURFACE, hw: 5, fh: 4 });

test('the answer decodes, and a wrong one is refused', () => {
  assert.equal(data.strategies.region.edges[0], 0);
  assert.throws(() => decodeWalk({ ...wire(), recipe: 'terrain-walk@0' }));
  assert.throws(() => decodeWalk({ ...wire(), ground: b64(new Uint8Array(N - 1)) }));
  const noChunk = wire() as Partial<WalkWire>;
  delete (noChunk.strategies as Partial<WalkWire['strategies']>).chunk;
  assert.throws(() => decodeWalk(noChunk as WalkWire));
});

test('edges, faces and grounds are the server’s', () => {
  const a = area('region');
  const l = a.stack.layers[SURFACE]!;
  assert.equal(a.name, 'walk');
  // Flat: every edge at the level; the rim between the chunks shuts the way east.
  assert.deepEqual([...l.edge.subarray((3 * W + 2) * 4, (3 * W + 2) * 4 + 4)], [0, 0, 0, 0]);
  assert.equal(step(a.stack, SURFACE, 23, 3, E), -1, 'the rim shuts');
  // The face: closed, its top, row and rows.
  const f = 21 * W + 5;
  assert.equal(l.kind[f], KIND.face);
  assert.ok(Number.isNaN(l.edge[f * 4]!));
  assert.deepEqual([l.faceTop[f], l.faceRow[f], l.faceRows[f]], [1, 1, 3]);
  // The ramp's edges in 1/256 level, exactly.
  const r = 10 * W + 20;
  assert.equal(l.kind[r], KIND.slope);
  assert.equal(l.edge[r * 4 + 1], Math.trunc((256 * 3) / 6) / 256);
  assert.ok(Number.isNaN(l.edge[r * 4]!), 'the outer side of a lane is shut');
  // Grounds: the biomes' own, and an unknown one as meadow.
  assert.equal(l.ground[0], G.meadow);
  assert.equal(l.ground[30], G['tops-moor']);
  // Water shuts its tile.
  assert.equal(l.kind[2 * W + 10], KIND.water);
});

test('cover blocks (but ferns), never on a cliff’s lip', () => {
  const a = area('region');
  const l = a.stack.layers[SURFACE]!;
  assert.equal(l.kind[5 * W + 3], KIND.prop);
  assert.equal(l.kind[6 * W + 8], KIND.flat);
  assert.deepEqual(a.props.map((p) => [p.kind, p.tx, p.ty, p.blocks]), [['oak', 3, 5, true], ['fern', 8, 6, false]]);
});

test('the region plan’s ramp climbs smoothly; per-chunk repair leaves the east chunk cut off', () => {
  const a = area('region');
  const path = findPath(a.stack, a.spawn, { layer: SURFACE, tx: 30, ty: 10 });
  assert.ok(path, 'home reaches the east chunk up the ramp');
  const w = walker(17, 10);
  const zs: number[] = [];
  for (let i = 0; i < 60; i++) {
    move(a.stack, w, 2, 0);
    zs.push(zAt(a.stack, w));
  }
  assert.ok(Math.abs(zs.at(-1)! - 1) < 0.01, `up to level 1, got ${zs.at(-1)}`);
  for (let i = 1; i < zs.length; i++) assert.ok(zs[i]! >= zs[i - 1]! - 1e-6, 'never dips on the way up');
  const c = area('chunk');
  assert.equal(findPath(c.stack, c.spawn, { layer: SURFACE, tx: 30, ty: 10 }), null);
  assert.equal(c.generated!.stranded[10 * W + 30], 1);
  assert.equal(a.generated!.stranded[10 * W + 30], 0);
  assert.equal(c.generated!.summary.chunk.strandedTiles, 9 + 576);
  assert.equal(c.generated!.strategy, 'chunk');
});

test('switching strategy keeps where you stand, or finds the nearest floor that reaches home', () => {
  const c = area('chunk');
  assert.deepEqual(resumeAt(c, 3, 3), { layer: SURFACE, tx: 3, ty: 3 });
  // A ramp tile in the region plan is plain level-1 floor under per-chunk repair: still floor, kept.
  assert.deepEqual(resumeAt(c, 20, 10), { layer: SURFACE, tx: 20, ty: 10 });
  // On the face: the nearest floor home reaches (the lip above is level 1 and cut off from home).
  const home = reachFrom(c.stack, c.spawn);
  const at = resumeAt(c, 5, 21);
  assert.equal(home[at.ty * W + at.tx], 1);
  assert.equal(Math.max(Math.abs(at.tx - 5), Math.abs(at.ty - 21)), 2, `nearest: ${at.tx},${at.ty}`);
  assert.ok(!(at.tx >= 4 && at.tx <= 6 && at.ty >= 16 && at.ty <= 19), "not the lip, which is nearer as the crow flies but cut off");
});

test('the HUD reads the biome, region and world chunk where you stand', () => {
  const a = area('region');
  assert.deepEqual(walkHere(a, 2, 2), { biome: 'hearthwick-woods@1', region: 'r:-1:-1', chunk: [-2, -1], world: [-46, -22], stranded: false });
  assert.deepEqual(walkHere(a, 40, 3)?.chunk, [-1, -1]);
  assert.equal(walkHere(a, 40, 3)?.biome, 'tops@1');
  assert.equal(walkHere(a, -1, 0), null);
});

test('the window is fetched once a page; a server without the lab says so', async () => {
  let asked = 0;
  const ok = (async () => {
    asked++;
    return new Response(JSON.stringify(wire()), { status: 200 });
  }) as typeof fetch;
  const a = await loadWalk('fixture', ok);
  const b = await loadWalk('fixture', ok);
  assert.equal(asked, 1);
  assert.equal(a, b);
  const missing = (async () => new Response('', { status: 404 })) as typeof fetch;
  await assert.rejects(loadWalk('elsewhere', missing), /no world lab/);
  // A failure isn't kept: asking again tries again.
  await assert.rejects(loadWalk('elsewhere', missing), /no world lab/);
});
