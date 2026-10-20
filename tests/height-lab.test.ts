import test from 'node:test';
import assert from 'node:assert/strict';
import { CAVE, DEFAULT_AREA_OPTIONS, SURFACE, buildLabArea, routeLegs, LAB_W } from '../src/game/height-lab/area.ts';
import { DEEP, MOUNTAIN_W, asciiLayer, buildMountain } from '../src/game/height-lab/mountain.ts';
import { DARK_MAX, HERO_OUTER, LIGHT_SCALE, caveLevels, caveView, darkAt, shownDark } from '../src/game/height-lab/light.ts';
import { fogFor } from '../src/game/height-lab/look.ts';
import { E, KIND, N, S, TILE_PX, findPath, move, step, zAt, sample, type Layer, type Walker } from '../src/game/height-lab/levels.ts';

/** The height lab's levels (src/game/height-lab): the rules walk the hand-made area as the scene does. */

const area = buildLabArea();
const { stack } = area;
const surface = stack.layers[SURFACE]!;
const cave = stack.layers[CAVE]!;
const at = (_l: typeof surface, tx: number, ty: number) => ty * LAB_W + tx;
const walker = (layer: number, tx: number, ty: number): Walker => ({ x: tx * TILE_PX + 8, y: ty * TILE_PX + 10, layer, hw: 5, fh: 4 });

test('every leg of the remote player’s loop can be walked', () => {
  const legs = routeLegs(area);
  legs.forEach((leg, i) => assert.ok(leg, `leg ${i} from ${JSON.stringify(area.route[i])}`));
  const layers = new Set(legs.flatMap((l) => l!.map((n) => n.layer)));
  assert.deepEqual([...layers].sort(), [SURFACE, CAVE], 'the loop goes underground and back');
});

test('a cliff stops you; the ramp takes you up a level', () => {
  // The plateau's face is rows 37–39: from the valley at row 40, north is shut.
  assert.equal(step(stack, SURFACE, 24, 40, N), -1);
  const w = walker(SURFACE, 24, 40);
  move(stack, w, 0, -40);
  assert.ok(w.y >= 40 * TILE_PX, `stopped at the foot of the face (y ${w.y})`);
  // Up the ramp (cols 16–18): height climbs smoothly from 0 to 1.
  const r = walker(SURFACE, 17, 41);
  const zs: number[] = [];
  for (let i = 0; i < 40; i++) {
    move(stack, r, 0, -2);
    zs.push(zAt(stack, r));
  }
  assert.ok(Math.abs(zs[0]!) < 0.01 && Math.abs(zs.at(-1)! - 1) < 0.01, `0 → 1, got ${zs[0]} → ${zs.at(-1)}`);
  for (let i = 1; i < zs.length; i++) assert.ok(zs[i]! >= zs[i - 1]! - 1e-6, 'never dips on the way up');
  // Off the ramp's side onto the face: shut.
  assert.equal(step(stack, SURFACE, 16, 38, 3), -1);
});

test('the switchback’s legs run side by side without joining', () => {
  assert.notEqual(surface.kind[at(surface, 42, 24)], KIND.face);
  assert.equal(step(stack, SURFACE, 42, 24, N), -1, 'bottom leg to middle leg: shut');
  const path = findPath(stack, { layer: SURFACE, tx: 40, ty: 26 }, { layer: SURFACE, tx: 44, ty: 20 });
  assert.ok(path && path.length >= 20, `the trail winds (${path?.length} tiles)`);
});

test('the cave mouth takes you onto the cave layer and out again', () => {
  const w = walker(SURFACE, 30, 41);
  w.x = 31 * TILE_PX; // between the mouth's two columns
  for (let i = 0; i < 20 && w.layer === SURFACE; i++) move(stack, w, 0, -2);
  assert.equal(w.layer, CAVE);
  assert.ok(sample(cave, cave.sky, w.x, w.y) > 0.8, 'daylight at the arch');
  for (let i = 0; i < 20 && w.layer === CAVE; i++) move(stack, w, 0, 2);
  assert.equal(w.layer, SURFACE);
});

test('the chamber lies under the plateau and the shoulder, and has a second way out', () => {
  assert.equal(cave.kind[at(cave, 32, 24)], KIND.flat);
  assert.equal(surface.kind[at(surface, 32, 24)], KIND.flat, 'plateau above');
  assert.equal(area.top[at(surface, 32, 24)], 1);
  assert.equal(area.top[at(surface, 38, 19)], 2, 'shoulder above the chamber’s north-east');
  assert.equal(cave.kind[at(cave, 38, 19)], KIND.flat);
  assert.ok(cave.sky[at(cave, 32, 24)]! === 0 && cave.seen[at(cave, 32, 24)] === 0, 'dark, and unseen from outside');
  // Out through the second mouth onto the plateau, never past the first.
  const out = findPath(stack, { layer: CAVE, tx: 32, ty: 24 }, { layer: SURFACE, tx: 52, ty: 27 })!;
  assert.ok(out);
  assert.ok(!out.some((n) => n.layer === SURFACE && n.ty >= 40), 'not via the valley');
  assert.equal(step(stack, CAVE, 52, 24, S), SURFACE);
  assert.equal(step(stack, CAVE, 50, 20, E), CAVE, 'the climbing tunnel meets its flat end');
});

// ---------------------------------------------------------------- round 2: light, fog, the mountain and its deep cave

const px = (tx: number, ty: number) => ({ x: tx * TILE_PX + 8, y: ty * TILE_PX + 8 });

test('cave light belongs to the world: the same at a point wherever the hero stands', () => {
  // Where the hero might be: on the arch, a tile in, halfway, in the chamber.
  const heroes = [px(30, 39), px(30, 37), px(30, 33), px(33, 24)];
  const points: { x: number; y: number }[] = [];
  for (let ty = 14; ty < 42; ty += 3) for (let tx = 20; tx < 56; tx += 3) points.push(px(tx, ty));
  for (const p of points) {
    const seen = new Set<number>();
    for (const h of heroes) {
      // Away from the hero's own light, only the world's light counts.
      if (Math.hypot(p.x - h.x, p.y - h.y) < HERO_OUTER * LIGHT_SCALE.wide + 1) continue;
      for (const light of ['lantern', 'wide', 'dim'] as const) seen.add(Math.round(shownDark(area.dark, p.x, p.y, h, light, 1) * 1e6));
    }
    assert.ok(seen.size <= 1, `one dark at ${p.x},${p.y}, got ${[...seen]}`);
  }
});

test('just inside the mouth, the cave beyond is already dark; daylight lies at the mouth', () => {
  // The owner's screenshot: a tile in, daylight still high. The cave's view is in.
  const walked = sample(cave, area.walk, px(30, 37).x, px(30, 37).y);
  const view = caveView(walked, 1);
  assert.equal(view, 1, `a tile in, the cave's view is in (walked ${walked})`);
  assert.ok(sample(cave, cave.sky, px(30, 37).x, px(30, 37).y) > 0.6, 'daylight is still strong there');
  const hero = px(30, 37);
  assert.ok(shownDark(area.dark, px(32, 24).x, px(32, 24).y, hero, 'lantern', view) > 0.85, 'the chamber is dark');
  assert.ok(shownDark(area.dark, px(46, 20).x, px(46, 20).y, hero, 'lantern', view) > 0.85, 'the far tunnel is dark');
  assert.ok(darkAt(area.dark, px(31, 39).x, px(31, 39).y) < 0.3, 'the arch is lit by day');
  assert.ok(darkAt(area.dark, px(30, 44).x, px(30, 44).y) < 0.05, 'the valley outside is open air');
  // The hero's own light clears the dark round them.
  assert.ok(shownDark(area.dark, px(33, 24).x, px(33, 24).y, px(33, 24), 'lantern', 1) < 0.05);
});

test('crystals light the rock round them; the crossfade is the view, not a dimmer', () => {
  const g = area.glows[0]!;
  const near = darkAt(area.dark, px(g.tx, g.ty).x, px(g.tx, g.ty).y);
  assert.ok(near < 0.5, `a crystal's own tile is lit (dark ${near})`);
  assert.ok(darkAt(area.dark, px(g.tx + 2, g.ty).x, px(g.tx + 2, g.ty).y) < darkAt(area.dark, px(g.tx + 6, g.ty).x, px(g.tx + 6, g.ty).y), 'brighter nearer');
  for (const tiles of [1, 3]) {
    assert.equal(caveView(0, tiles), 0);
    assert.equal(caveView(tiles, tiles), 1);
    assert.equal(caveView(tiles * 5, tiles), 1, 'and stays in, however deep');
  }
});

test('fog is the same for a level above as for a level below, and clear on your own', () => {
  for (const s of ['light', 'medium', 'strong'] as const) {
    assert.equal(fogFor(0, s), 0);
    assert.equal(fogFor(0.25, s), 0);
    let last = 0;
    for (let dz = 0.5; dz <= 5; dz += 0.5) {
      assert.equal(fogFor(dz, s), fogFor(-dz, s), `${s} ±${dz}`);
      assert.ok(fogFor(dz, s) >= last);
      last = fogFor(dz, s);
    }
    assert.ok(fogFor(1, s) > 0, `${s}: a level away is in some fog`);
  }
  assert.ok(fogFor(2, 'strong') > fogFor(2, 'light'));
});

const mtn = buildMountain(DEFAULT_AREA_OPTIONS);
const ms = mtn.stack;
const mSurface = ms.layers[SURFACE]!;
const mCave = ms.layers[CAVE]!;
const mLevels = caveLevels(mCave);
const node = (layer: number, t: { tx: number; ty: number }) => ({ layer, tx: t.tx, ty: t.ty });
const cloneLayer = (l: Layer): Layer => ({ ...l, edge: l.edge.slice() });

test('the mountain: every leg of Wren’s loop walks, up to a summit four levels and more above the valley', () => {
  const legs = routeLegs(mtn);
  legs.forEach((leg, i) => assert.ok(leg, `leg ${i} from ${JSON.stringify(mtn.route[i])}\n${asciiLayer(mSurface, mtn.top)}`));
  assert.equal(mtn.top[28 * MOUNTAIN_W + 38], 5, 'the summit is level 5');
  assert.equal(mtn.top[80 * MOUNTAIN_W + 30], 0, 'the valley is level 0');
  const up = findPath(ms, mtn.spawn, { layer: SURFACE, tx: 38, ty: 28 })!;
  const w = walker(SURFACE, mtn.spawn.tx, mtn.spawn.ty);
  let top = 0;
  for (const n of up) {
    w.x = n.tx * TILE_PX + 8;
    w.y = n.ty * TILE_PX + 10;
    top = Math.max(top, zAt(ms, w));
  }
  assert.ok(Math.abs(top - 5) < 0.01, `the trail reaches level 5 (${top})`);
});

test('the far side is reached only over the saddle', () => {
  const over = findPath(ms, mtn.spawn, { layer: SURFACE, tx: 58, ty: 6 })!;
  assert.ok(over, 'there is a way');
  assert.ok(over.some((n) => n.layer === SURFACE && n.tx >= 59 && n.tx <= 71 && n.ty === 30), 'through the saddle');
  assert.ok(!over.some((n) => n.layer === CAVE), 'not underground');
  // Shut the saddle's ramp north: no way at all.
  const shut = { ...ms, portals: ms.portals, layers: [cloneLayer(mSurface), mCave] };
  for (let tx = 64; tx <= 66; tx++) shut.layers[0]!.edge.fill(Number.NaN, (20 * MOUNTAIN_W + tx) * 4, (20 * MOUNTAIN_W + tx) * 4 + 4);
  assert.equal(findPath(shut, mtn.spawn, { layer: SURFACE, tx: 58, ty: 6 }), null);
});

test('the deep cave winds down floor by floor, from the mouth to the cavern', () => {
  const legs = DEEP.legs;
  for (const l of legs) assert.equal(mLevels[l.ty * MOUNTAIN_W + l.tx], l.z, `floor at ${l.tx},${l.ty}`);
  // The way down from the east mouth (with the west one shut: it's the short way up from the cavern).
  const eastOnly = { ...ms, portals: new Map([...ms.portals].filter(([k]) => Math.abs(((k >> 2) % MOUNTAIN_W) - DEEP.mouthOut.x0) > 2)) };
  const way = findPath(eastOnly, { layer: SURFACE, tx: DEEP.mouthIn.x0, ty: 75 }, node(CAVE, legs.at(-1)!))!;
  assert.ok(way, 'the way down');
  const inside = way.filter((n) => n.layer === CAVE);
  assert.ok(inside[0]!.tx >= DEEP.mouthIn.x0 && inside[0]!.tx <= DEEP.mouthIn.x1, 'in by the east mouth');
  for (const l of legs) assert.ok(inside.some((n) => n.tx === l.tx && n.ty >= l.ty - 3 && n.ty <= l.ty + 3) || inside.some((n) => n.ty === l.ty && Math.abs(n.tx - l.tx) <= 3), `passes ${l.tx},${l.ty}`);
  // Never back up: each floor at or below the last.
  let last = 1;
  for (const n of inside) {
    const z = mLevels[n.ty * MOUNTAIN_W + n.tx]!;
    assert.ok(z <= last, `down only (${n.tx},${n.ty} at ${z} after ${last})`);
    last = z;
  }
  assert.equal(last, -4);
});

test('the deep cave’s legs join only where they should', () => {
  // The ledge overlooks the cavern: no step down the drop, the way round is the long ramp.
  assert.equal(step(ms, CAVE, DEEP.ledge.tx, DEEP.ledge.ty, S), -1, 'the drop is shut');
  assert.equal(mCave.kind[(DEEP.ledge.ty + 1) * MOUNTAIN_W + DEEP.ledge.tx], KIND.face);
  const round = findPath(ms, node(CAVE, DEEP.ledge), node(CAVE, DEEP.below))!;
  assert.ok(round && round.length > 20, `round by the ramp (${round?.length})`);
  // The branch east is a dead end: past col 76 there's no mouth, only -2 and -3.
  const seen = new Set<number>();
  const queue = [DEEP.pocket.ty * MOUNTAIN_W + DEEP.pocket.tx];
  seen.add(queue[0]!);
  let joins = 0;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    const tx = i % MOUNTAIN_W;
    const ty = Math.floor(i / MOUNTAIN_W);
    for (let d = 0; d < 4; d++) {
      const to = step(ms, CAVE, tx, ty, d as 0 | 1 | 2 | 3);
      if (to < 0) continue;
      assert.equal(to, CAVE, 'no way out of the branch to the surface');
      const nx = tx + [0, 1, 0, -1][d]!;
      const ny = ty + [-1, 0, 1, 0][d]!;
      if (nx <= 76) {
        joins++;
        continue;
      }
      const j = ny * MOUNTAIN_W + nx;
      if (seen.has(j)) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  assert.equal(joins, 2, 'the branch meets the main way once, two tiles wide');
  assert.deepEqual([...new Set([...seen].map((i) => mLevels[i]!))].sort((a, b) => a - b), [-3, -2]);
  // The other way out: from the cavern, up to the west mouth, never past the east one.
  const out = findPath(ms, node(CAVE, DEEP.legs.at(-1)!), { layer: SURFACE, tx: DEEP.mouthOut.x0, ty: 78 })!;
  assert.ok(out);
  assert.ok(!out.some((n) => n.tx >= DEEP.mouthIn.x0 && n.tx <= DEEP.mouthIn.x1 && n.ty >= 60), 'not by the east mouth');
  // Walking it: the walker comes out on the surface.
  const wk = walker(CAVE, DEEP.mouthOut.x0, 66);
  for (let i = 0; i < 80 && wk.layer === CAVE; i++) move(ms, wk, 0, 2);
  assert.equal(wk.layer, SURFACE);
});

test('deeper floors are dark from far off; crystals light the cavern', () => {
  const cavern = px(42, 44);
  assert.ok(darkAt(mtn.dark, px(36, 39).x, px(36, 39).y) < 0.4, 'a crystal in the cavern lights it');
  assert.ok(darkAt(mtn.dark, px(75, 34).x, px(75, 34).y) > 0.9, 'the corridor between crystals is dark');
  assert.ok(darkAt(mtn.dark, cavern.x, cavern.y) < DARK_MAX);
  assert.ok(mCave.sky[DEEP.legs[0]!.ty * MOUNTAIN_W + DEEP.legs[0]!.tx]! > 0, 'daylight in the first tunnel');
  assert.equal(mCave.sky[DEEP.legs.at(-1)!.ty * MOUNTAIN_W + DEEP.legs.at(-1)!.tx], 0, 'none in the cavern');
});
