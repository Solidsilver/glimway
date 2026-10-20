import test from 'node:test';
import assert from 'node:assert/strict';
import { CAVE, DEFAULT_AREA_OPTIONS, SURFACE, areaLighting, buildLabArea, routeLegs, LAB_W } from '../src/game/height-lab/area.ts';
import { DEEP, MOUNTAIN_W, asciiLayer, buildMountain } from '../src/game/height-lab/mountain.ts';
import { HERO_LIGHT, caveLevels, caveView, type HeroLight } from '../src/game/height-lab/light.ts';
import { Lighting, sightLine } from '../src/game/height-lab/lighting.ts';
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

const mtn = buildMountain(DEFAULT_AREA_OPTIONS);

// ---------------------------------------------------------------- round 2–3: light, fog, the mountain and its deep cave

const px = (tx: number, ty: number) => ({ x: tx * TILE_PX + 8, y: ty * TILE_PX + 8 });
const lit = areaLighting(area);
const heroAt = (l: Lighting, kind: HeroLight, p: { x: number; y: number }) => {
  l.add({ id: 'hero', x: p.x, y: p.y, layer: CAVE, z: 0, ...HERO_LIGHT[kind], moving: true });
};

test('cave light belongs to the world: the same at a point wherever the hero stands', () => {
  // Where the hero might be: on the arch, a tile in, halfway, in the chamber.
  const heroes = [px(30, 39), px(30, 37), px(30, 33), px(33, 24)];
  const points: { x: number; y: number }[] = [];
  for (let ty = 14; ty < 42; ty += 3) for (let tx = 20; tx < 56; tx += 3) points.push(px(tx, ty));
  const l = areaLighting(area);
  for (const p of points) {
    const seen = new Set<number>();
    for (const h of heroes)
      for (const kind of ['lantern', 'wide', 'dim'] as const) {
        // Away from the hero's own light, only the world's light counts.
        if (Math.hypot(p.x - h.x, p.y - h.y) < HERO_LIGHT[kind].radius + 1) continue;
        heroAt(l, kind, h);
        seen.add(Math.round(l.level(CAVE, p.x, p.y) * 1e6));
      }
    assert.ok(seen.size <= 1, `one light at ${p.x},${p.y}, got ${[...seen]}`);
  }
});

test('daylight spills into the mouth and fades along the tunnel; the cave beyond is dark', () => {
  const at = (tx: number, ty: number) => lit.level(CAVE, px(tx, ty).x, px(tx, ty).y);
  // The shoulder's mouth: arch rows 38–39, the tunnel north from there.
  assert.ok(at(30, 39) > 0.9, `the arch is in daylight (${at(30, 39)})`);
  assert.ok(at(30, 37) > 0.5, `a tile in, still bright (${at(30, 37)})`);
  assert.ok(at(30, 37) > at(30, 35) && at(30, 35) > at(30, 33), 'fading as it goes in');
  assert.ok(at(46, 20) < 0.15, `the far tunnel is dark (${at(46, 20)})`);
  // The crossfade is the view coming in over a few steps, not a dimmer.
  for (const tiles of [1, 3]) {
    assert.equal(caveView(0, tiles), 0);
    assert.equal(caveView(tiles, tiles), 1);
    assert.equal(caveView(tiles * 5, tiles), 1, 'and stays in, however deep');
  }
  assert.ok(caveView(1, 3) > 0 && caveView(1, 3) < 1, 'a tile in, the view is part way');
});

test('the sunny surface stays lit in the cave’s view: the valley and the cliff round the mouth', () => {
  for (const [a, rows, faces] of [[area, [40, 71], [37, 39]], [mtn, [74, 95], [71, 73]]] as const) {
    const l = areaLighting(a);
    const s = a.stack.layers[SURFACE]!;
    // Near a mouth (as far as a view from inside reaches): fully lit.
    const near = (tx: number, ty: number) => a.mouths.some((m) => Math.abs(tx - m.x0) + Math.abs(ty - (m.arch[1] + 1)) <= 14);
    for (let ty = rows[0]; ty <= rows[1]; ty++)
      for (let tx = 0; tx < a.stack.w; tx++) {
        if (a.stack.layers[CAVE]!.kind[ty * a.stack.w + tx] !== KIND.none || !near(tx, ty)) continue;
        const p = px(tx, ty);
        assert.ok(l.level(CAVE, p.x, p.y) > 0.99, `${a.name}: open valley at ${tx},${ty} is lit (${l.level(CAVE, p.x, p.y)})`);
      }
    // The cliff faces in front of the mouth are in the sun too, away from the cave's own rock.
    let faceTiles = 0;
    for (let ty = faces[0]; ty <= faces[1]; ty++)
      for (let tx = 0; tx < a.stack.w; tx++) {
        const i = ty * a.stack.w + tx;
        const ck = a.stack.layers[CAVE]!.kind[i];
        if (s.kind[i] !== KIND.face || !near(tx, faces[1] + 1) || ck === KIND.flat || ck === KIND.slope) continue;
        // A face is open only if the land at its foot is.
        let j = i;
        while (s.kind[j] === KIND.face) j += a.stack.w;
        if (a.top[j]! > 0) continue;
        faceTiles++;
        const p = px(tx, ty);
        assert.ok(l.level(CAVE, p.x, p.y + 4) > 0.95, `${a.name}: the face at ${tx},${ty} is lit`);
      }
    assert.ok(faceTiles > 10, `${a.name}: faces checked (${faceTiles})`);
  }
  // The plateau beyond the shoulder chamber's rim, far from both mouths, isn't sunny from inside.
  assert.ok(lit.level(CAVE, px(14, 30).x, px(14, 30).y) < 0.05, 'the land over the cave, far from a mouth, is dark from inside');
});

test('the light lines up with the world: a light is brightest at itself, and fill() is at()', () => {
  // A blank world (no ambient, nothing in the way): a dim light, so nothing saturates.
  const blank = new Lighting({ w: 20, h: 20, tile: TILE_PX, res: 4, layers: 1 });
  blank.setAmbient(0, new Float32Array(20 * 20 * 3));
  for (const [x, y] of [[100, 150], [163, 211], [250, 63]] as const) {
    blank.add({ id: 'l', x, y, layer: 0, z: 0, color: 0xffffff, radius: 60, inner: 0, intensity: 0.5, moving: false });
    let best = { v: -1, x: 0, y: 0 };
    for (let dy = -40; dy <= 40; dy++)
      for (let dx = -40; dx <= 40; dx++) {
        const v = blank.level(0, x + dx, y + dy);
        if (v > best.v + 1e-9) best = { v, x: x + dx, y: y + dy };
      }
    assert.ok(Math.hypot(best.x - x, best.y - y) <= blank.res, `a light at ${x},${y}: brightest ${best.x - x},${best.y - y} px off`);
    // Round: the same a radius's half out in each direction.
    const ring = [[30, 0], [-30, 0], [0, 30], [0, -30]].map(([dx, dy]) => blank.level(0, x + dx!, y + dy!));
    assert.ok(Math.max(...ring) - Math.min(...ring) < 0.02, `round (${ring})`);
    blank.remove('l');
  }
  // A texel of the frame's buffer is the light at its middle.
  const l = areaLighting(area);
  heroAt(l, 'lantern', px(30, 33));
  const rect = { x0: 100, y0: 120, w: 40, h: 30 };
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  l.fill(rect, out, [{ layer: CAVE, weight: 1 }]);
  for (const [x, y] of [[0, 0], [17, 9], [39, 29], [21, 14]] as const) {
    const [r, g, b] = l.at(CAVE, (rect.x0 + x + 0.5) * l.res, (rect.y0 + y + 0.5) * l.res);
    const i = (y * rect.w + x) * 4;
    assert.ok(Math.abs(out[i]! - r * 255) <= 1 && Math.abs(out[i + 1]! - g * 255) <= 1 && Math.abs(out[i + 2]! - b * 255) <= 1, `texel ${x},${y}`);
    assert.equal(out[i + 3], 255);
  }
});

test('the hero’s light lands on the hero; with none, the hero stays readable and the floor dark', () => {
  // A dark spot: the far tunnel.
  const spot = px(46, 20);
  const base = lit.level(CAVE, spot.x, spot.y);
  assert.ok(base < 0.15);
  for (const kind of ['lantern', 'wide', 'dim'] as const) {
    const l = areaLighting(area);
    heroAt(l, kind, spot);
    assert.ok(l.level(CAVE, spot.x, spot.y) > 0.6, `${kind}: lit at the hero (${l.level(CAVE, spot.x, spot.y)})`);
    const r = HERO_LIGHT[kind].radius;
    assert.ok(Math.abs(l.level(CAVE, spot.x, spot.y + r + 2) - lit.level(CAVE, spot.x, spot.y + r + 2)) < 1e-6, `${kind}: gone past its reach`);
  }
  const dim = areaLighting(area);
  heroAt(dim, 'dim', spot);
  assert.ok(dim.level(CAVE, spot.x, spot.y + 24) - lit.level(CAVE, spot.x, spot.y + 24) < 0.02, 'none: the floor a tile and a half off stays dark');
  // It follows the hero.
  const l = areaLighting(area);
  heroAt(l, 'lantern', spot);
  l.move('hero', spot.x - 16, spot.y);
  assert.ok(l.level(CAVE, spot.x - 16, spot.y) > 0.6, 'moved with them');
});

test('rock stops light: a crystal lights only what it can see', () => {
  const mlit = areaLighting(mtn);
  const mc = mtn.stack.layers[CAVE]!;
  for (const [i, g] of mtn.glows.entries()) {
    const id = `crystal-${i}`;
    const src = mlit.get(id)!;
    const reach = Math.ceil(src.radius / TILE_PX);
    const before = new Map<number, number>();
    for (let ty = Math.max(1, g.ty - reach); ty <= Math.min(MOUNTAIN_W - 2, g.ty + reach); ty++)
      for (let tx = Math.max(1, g.tx - reach); tx <= Math.min(MOUNTAIN_W - 2, g.tx + reach); tx++) before.set(ty * MOUNTAIN_W + tx, mlit.level(CAVE, px(tx, ty).x, px(tx, ty).y));
    mlit.remove(id);
    let shadowed = 0;
    for (const [t, v] of before) {
      const tx = t % MOUNTAIN_W;
      const ty = Math.floor(t / MOUNTAIN_W);
      const gain = v - mlit.level(CAVE, px(tx, ty).x, px(tx, ty).y);
      // Two tiles past a wall (so the half-tile penumbra is behind us): no light at all.
      const around = [-1, 0, 1].every((a) => [-1, 0, 1].every((b) => !sightLine(mtn.stops, MOUNTAIN_W, g.tx, g.ty, tx + a, ty + b)));
      if (around) {
        shadowed++;
        assert.ok(gain < 1e-6, `crystal ${g.tx},${g.ty} reaches ${tx},${ty} through rock (${gain})`);
      }
    }
    assert.ok(shadowed > 0, `crystal ${g.tx},${g.ty} has rock round it`);
    mlit.add(src);
    for (const [t, v] of before) assert.ok(Math.abs(mlit.level(CAVE, px(t % MOUNTAIN_W, Math.floor(t / MOUNTAIN_W)).x, px(t % MOUNTAIN_W, Math.floor(t / MOUNTAIN_W)).y) - v) < 1e-5, 'adding it back restores it');
  }
  assert.equal(mc.kind[57 * MOUNTAIN_W + 60], KIND.rock, 'the corridor wall north of the bend crystal');
});

test('two lights overlap: each adds, and the sum is clamped', () => {
  const l = areaLighting(mtn);
  // The cavern: crystals at 42,49 and 49,45 (both on floor -4); between them both reach.
  const mid = px(45, 47);
  const both = l.at(CAVE, mid.x, mid.y);
  l.remove('crystal-5');
  const one = l.at(CAVE, mid.x, mid.y);
  assert.ok(Math.max(...both) > Math.max(...one) + 0.02, `the second adds (${both} vs ${one})`);
  for (const c of both) assert.ok(c <= 1);
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
  const mlit = areaLighting(mtn);
  const at = (p: { x: number; y: number }) => mlit.level(CAVE, p.x, p.y);
  assert.ok(at(px(36, 39)) > 0.6, 'a crystal in the cavern lights it');
  assert.ok(at(px(75, 34)) < 0.1, 'the corridor between crystals is dark');
  assert.ok(at(cavern) > 0.04);
  assert.ok(mCave.sky[DEEP.legs[0]!.ty * MOUNTAIN_W + DEEP.legs[0]!.tx]! > 0, 'daylight in the first tunnel');
  assert.equal(mCave.sky[DEEP.legs.at(-1)!.ty * MOUNTAIN_W + DEEP.legs.at(-1)!.tx], 0, 'none in the cavern');
});
