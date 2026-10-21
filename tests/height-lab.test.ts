import test from 'node:test';
import assert from 'node:assert/strict';
import { CAVE, DEFAULT_AREA_OPTIONS, SURFACE, areaLighting, buildLabArea, routeLegs, LAB_W } from '../src/game/height-lab/area.ts';
import { DEEP, MOUNTAIN_W, asciiLayer, buildMountain } from '../src/game/height-lab/mountain.ts';
import { HERO_LIGHT, caveLevels, caveView, sunnyFaceRock, wayIn, type HeroLight } from '../src/game/height-lab/light.ts';
import { Lighting, caveTint, clearLitScratch, depthDark, litPixels, pixelSpans, sightLine } from '../src/game/height-lab/lighting.ts';
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
  // The cave's own rock is never sunny, except where it lies behind a cliff face round an arch.
  for (const a of [area, mtn]) {
    const c = a.stack.layers[CAVE]!;
    const sf = a.stack.layers[SURFACE]!;
    for (let i = 0; i < a.stack.w * a.stack.h; i++) {
      if (c.kind[i] !== KIND.rock || sf.kind[i] === KIND.face || sf.kind[i] === KIND.mouth) continue;
      assert.ok(a.ambient[i * 3]! <= 0.06 + c.sky[i]!, `${a.name}: rock at ${i % a.stack.w},${Math.floor(i / a.stack.w)} is cave rock`);
    }
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
  for (const i of seen) assert.ok(mLevels[i]! >= -3 && mLevels[i]! <= -2, `the branch is between -3 and -2 (${mLevels[i]})`);
  assert.ok([...seen].some((i) => mLevels[i] === -3) && [...seen].some((i) => mLevels[i] === -2), 'both its floors');
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

test('cave levels are smooth along every ramp: no step at a whole level, for the floor or the light', () => {
  // Ramp E (4 levels over 14 tiles) and ramp A, tile by tile down, and within a tile.
  for (const [tx, y0, y1] of [[40, 51, 64], [56, 62, 66]] as const) {
    let last = Number.NaN;
    for (let ty = y0 - 1; ty <= y1 + 1; ty++) {
      const z = mLevels[ty * MOUNTAIN_W + tx]!;
      if (!Number.isNaN(last)) assert.ok(Math.abs(z - last) <= 0.31, `ramp at ${tx}: ${last} to ${z} at row ${ty}`);
      last = z;
    }
  }
  // The hero's light walking down ramp E: the light a tile ahead changes evenly, with no jump at a half level.
  const l = areaLighting(mtn);
  const w = walker(CAVE, 40, 52);
  l.add({ id: 'hero', x: w.x, y: w.y - 10, layer: CAVE, z: zAt(ms, w), ...HERO_LIGHT.lantern, moving: true });
  let prev = Number.NaN;
  let worst = 0;
  for (let y = 52 * TILE_PX; y <= 63 * TILE_PX; y += 1) {
    w.y = y;
    l.move('hero', w.x, w.y - 10, CAVE, zAt(ms, w));
    const v = l.level(CAVE, w.x + 0.5 * TILE_PX, w.y + 2 * TILE_PX);
    if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(v - prev));
    prev = v;
  }
  // (Its height rounded, as before, a step there jumped by 0.7.)
  assert.ok(worst < 0.05, `a pixel's walk changes the light ahead by at most ${worst}`);
});

test('depth darkens other levels, never tints them, and leaves your own clear', () => {
  const l = areaLighting(mtn);
  // From the ledge (-2), the cavern below (-4), lit by its crystals.
  const ledge = px(DEEP.ledge.tx, DEEP.ledge.ty);
  const cavern = px(36, 39);
  const texel = (p: { x: number; y: number }, z: number, cap: number) => {
    const rect = { x0: Math.floor(p.x / l.res), y0: Math.floor(p.y / l.res), w: 1, h: 1 };
    const out = new Uint8ClampedArray(4);
    l.fill(rect, out, [{ layer: CAVE, weight: 1 }], { depth: { layer: CAVE, z, cap, weight: 1 } });
    return [out[0]!, out[1]!, out[2]!];
  };
  const clear = texel(cavern, -4, 0.6);
  const dark = texel(cavern, -2, 0.6);
  assert.ok(Math.max(...dark) < Math.max(...clear) * 0.45, `two levels off is darker (${dark} vs ${clear})`);
  // Neutral: every channel by the same factor (to rounding).
  const k = dark.map((c, i) => c / clear[i]!);
  assert.ok(Math.max(...k) - Math.min(...k) < 0.03, `no tint (${k})`);
  assert.deepEqual(texel(ledge, -2, 0.6), texel(ledge, -2, 0), 'your own level is clear');
  assert.equal(depthDark(1, 0.6), depthDark(-1, 0.6));
  assert.ok(depthDark(0.5, 0.6) > 0 && depthDark(0.5, 0.6) < depthDark(1, 0.6) && depthDark(1, 0.6) < depthDark(2, 0.6));
  assert.ok(Math.abs(depthDark(3, 0.6) - 0.6) < 1e-9, 'the cap, two levels off and more');
});

test('a mouth\'s arch shows the cave\'s light from outside; the valley stays in daylight', () => {
  const l = areaLighting(mtn);
  const m = mtn.mouths[0]!;
  const rect = { x0: (m.x0 * TILE_PX) / l.res - 8, y0: (m.lintel * TILE_PX) / l.res, w: 24, h: 24 };
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  l.fill(rect, out, [{ layer: CAVE, weight: 0 }, { layer: SURFACE, weight: 1 }], { portal: { layer: CAVE, mask: mtn.arches } });
  const texelAt = (wx: number, wy: number) => out[((Math.floor(wy / l.res) - rect.y0) * rect.w + Math.floor(wx / l.res) - rect.x0) * 4]!;
  // The arch's top row, a tile from the daylight's start: the cave's light, not daylight.
  const inArch = { x: m.x0 * TILE_PX + 8, y: m.arch[0] * TILE_PX + 6 };
  assert.ok(Math.abs(texelAt(inArch.x, inArch.y) - l.at(CAVE, (Math.floor(inArch.x / l.res) + 0.5) * l.res, (Math.floor(inArch.y / l.res) + 0.5) * l.res)[0] * 255) <= 1, 'the cave\'s light in the arch');
  assert.ok(texelAt(inArch.x, inArch.y) < 250, 'darker than daylight in there');
  // The face beside the arch and the valley in front: daylight.
  assert.equal(texelAt((m.x0 - 1) * TILE_PX + 4, m.arch[0] * TILE_PX + 8), 255);
  assert.equal(texelAt(m.x0 * TILE_PX + 8, (m.arch[1] + 2) * TILE_PX + 8), 255);
});

test('the rock south of a tunnel that runs behind a cliff\'s top is the tunnel\'s wall, not sunny', () => {
  for (let tx = 41; tx <= 50; tx++)
    for (let ty = 22; ty <= 24; ty++) {
      const i = ty * LAB_W + tx;
      if (cave.kind[i] !== KIND.rock) continue;
      assert.ok(!sunnyFaceRock(stack, area.air, i), `${tx},${ty} is the east tunnel's wall`);
    }
  // Round the arches it still is: the face you see out of a mouth.
  for (const a of [area, mtn])
    for (const m of a.mouths) {
      const i = m.arch[0] * a.stack.w + m.x0 - 1;
      if (a.stack.layers[CAVE]!.kind[i] === KIND.rock) assert.ok(sunnyFaceRock(a.stack, a.air, i), `${a.name}: beside the arch at ${m.x0}`);
    }
});

test('the way in: the cave never shows brighter mid-way than once in (the corners lit, then dark)', () => {
  const l = areaLighting(mtn);
  // A dark stretch of tunnel a few tiles in from the east mouth, past daylight's reach.
  const rect = { x0: (54 * TILE_PX) / l.res, y0: (60 * TILE_PX) / l.res, w: 24, h: 24 };
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  const own = new Uint8ClampedArray(rect.w * rect.h * 4);
  l.fill(rect, own, [{ layer: CAVE, weight: 1 }]);
  // Round 4's blend, uncapped: the material at alpha a under a light a of the cave's and 1 − a of daylight.
  const a = 0.5;
  l.fill(rect, out, [{ layer: CAVE, weight: a }, { layer: SURFACE, weight: 1 - a }]);
  let worst = 0;
  for (let i = 0; i < rect.w * rect.h; i++) worst = Math.max(worst, (a * out[i * 4]! - own[i * 4]!) / 255);
  assert.ok(worst > 0.2, `round 4 lit the dark mid-way (${worst})`);
  // Capped: the material (alpha a, times how much the image covers) never more than its own light; on the
  // rock's fading rim (cover under a half) at most an eighth of what round 4 showed past it.
  const uncapped = out.slice();
  l.fill(rect, out, [{ layer: CAVE, weight: a }, { layer: SURFACE, weight: 1 - a }], { cap: { layer: CAVE, alpha: a } });
  const tw = l.tw;
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const i = y * rect.w + x;
      const cover = mtn.cover[(rect.y0 + y) * tw + rect.x0 + x]!;
      for (let c = 0; c < 3; c++) {
        const past = cover * (a * out[i * 4 + c]! - own[i * 4 + c]!);
        const before = cover * Math.max(0, a * uncapped[i * 4 + c]! - own[i * 4 + c]!);
        assert.ok(past <= (cover >= 0.5 ? 1 : before / 8 + 1), `texel ${x},${y} (cover ${cover}): ${past} past its own`);
      }
    }
  assert.ok(l.stats.uncapped > 0.2, 'the cap saw what it stopped');
});

test('the ways in start outside, end in the cave, and only go one way', () => {
  for (const way of ['blend', 'eased', 'stages', 'iris'] as const)
    for (const tiles of [1, 3]) {
      let last = { light: 0, alpha: 0 };
      assert.deepEqual(wayIn(0, tiles, way), { light: 0, alpha: 0 }, `${way}: outside at the arch`);
      for (let w = 0; w <= 8; w += 0.1) {
        const s = wayIn(w, tiles, way);
        assert.ok(s.light >= last.light - 1e-9 && s.alpha >= last.alpha - 1e-9, `${way} ${tiles} at ${w}`);
        if (way === 'stages') assert.ok(s.alpha <= s.light + 1e-9, 'stages: the floors never ahead of the light');
        last = s;
      }
      assert.deepEqual(wayIn(8, tiles, way), { light: 1, alpha: 1 }, `${way}: in`);
    }
});

test('the iris: the cave\'s light inside its circle, daylight well outside', () => {
  const l = areaLighting(mtn);
  const rect = { x0: (50 * TILE_PX) / l.res, y0: (60 * TILE_PX) / l.res, w: 48, h: 40 };
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  const own = new Uint8ClampedArray(rect.w * rect.h * 4);
  l.fill(rect, own, [{ layer: CAVE, weight: 1 }]);
  const iris = { layer: CAVE, x: 57 * TILE_PX, y: 70 * TILE_PX, r: 4 * TILE_PX, soft: 2 * TILE_PX };
  l.fill(rect, out, [{ layer: CAVE, weight: 0.3 }, { layer: SURFACE, weight: 0.7 }], { iris });
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const d = Math.hypot((rect.x0 + x + 0.5) * l.res - iris.x, (rect.y0 + y + 0.5) * l.res - iris.y);
      const i = (y * rect.w + x) * 4;
      if (d <= iris.r) assert.equal(out[i], own[i], 'inside: the cave\'s own');
      if (d >= iris.r + iris.soft) assert.equal(out[i], 255, 'outside: daylight');
    }
});

test('the cave\'s edge is soft: whole on its floors, fading through the rock, no tile-sized steps', () => {
  for (const a of [area, mtn]) {
    const c = a.stack.layers[CAVE]!;
    const per = TILE_PX / 4;
    const tw = c.w * per;
    let worst = 0;
    const solidFloor = (kind: number) => kind === KIND.flat || kind === KIND.slope || kind === KIND.water || kind === KIND.face;
    for (let y = 0; y < c.h * per; y++)
      for (let x = 0; x < tw; x++) {
        const k = c.kind[Math.floor(y / per) * c.w + Math.floor(x / per)];
        if (k === KIND.flat || k === KIND.slope) assert.equal(a.cover[y * tw + x], 1, `${a.name}: floor covered`);
        // Check rock boundaries in both directions, including zero. Walkable floors
        // and the portal keep their opaque material edge; their silhouettes are intentional.
        for (const j of [x + 1 < tw ? y * tw + x + 1 : -1, y + 1 < c.h * per ? (y + 1) * tw + x : -1])
          if (j >= 0 && !solidFloor(k!) && !solidFloor(c.kind[Math.floor(j / tw / per) * c.w + Math.floor((j % tw) / per)]!)) worst = Math.max(worst, Math.abs(a.cover[y * tw + x]! - a.cover[j]!));
      }
    assert.ok(worst < 0.3, `${a.name}: steepest step between texels ${worst}`);
  }
});

test('the crossfade lights the floors as the light image would: each pixel times the bilinear light', () => {
  // A 3×3-texel light (4 px a texel) over an 8×8 grey image at world 4,4.
  const light = new Uint8ClampedArray(3 * 3 * 4);
  for (let i = 0; i < 9; i++) light.set([i * 25, 255, 0, 255], i * 4);
  const src = new Uint8ClampedArray(8 * 8 * 4).fill(200);
  const out = new Uint8ClampedArray(12 * 12 * 4);
  litPixels(src, 8, 4, 4, light, 3, 3, 0, 0, 4, 0, 0, 12, 12, out);
  assert.equal(out[(0 * 12 + 0) * 4 + 3], 0, 'nothing outside the image');
  // At a texel's middle (world 6, 6: texel 1, 1), exactly that texel.
  const at = (wx: number, wy: number) => (wy * 12 + wx) * 4;
  assert.ok(Math.abs(out[at(5, 5) + 0]! - (200 * 4 * 25) / 255) <= 1 + (200 * 25) / 255, 'red near texel 1,1');
  assert.ok(Math.abs(out[at(6, 6) + 1]! - 200) <= 1, 'green: full light');
  assert.equal(out[at(6, 6) + 2], 0, 'blue: none');
  // Red rises smoothly left to right across the image.
  for (let x = 5; x < 11; x++) assert.ok(out[at(x + 1, 6)]! >= out[at(x, 6)]!, `smooth at ${x}`);
  // With an iris, alpha stays whole inside r, feathers across soft, and is 0 outside r + soft.
  litPixels(src, 8, 4, 4, light, 3, 3, 0, 0, 4, 0, 0, 12, 12, out, { x: 6.5, y: 6.5, r: 1, soft: 3 });
  assert.equal(out[at(6, 6) + 3], 200, 'inside the iris: full alpha');
  assert.ok(out[at(8, 6) + 3]! > 0 && out[at(8, 6) + 3]! < 200, 'in the feather ring: partial alpha');
  assert.equal(out[at(11, 6) + 3], 0, 'past the feather ring: transparent');
});

test('the crossfade light pass: no double-darkening over the cave and no halo around a surface light', () => {
  const l = areaLighting(mtn);
  const rect = { x0: (56 * TILE_PX) / l.res, y0: (63 * TILE_PX) / l.res, w: 8, h: 8 };
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  const h = 0.5;
  const a = 0.5;
  l.fill(rect, out, [{ layer: CAVE, weight: h }, { layer: SURFACE, weight: 1 - h }], { over: { layer: CAVE, alpha: a } });
  // Over fully covered cave floor (cover = 1), the crossfade already dims the surface by (1 - a);
  // the light pass underneath supplies (1 - h) / (1 - a) = 1 so the product is (1 - h), not (1 - h)^2.
  assert.equal(out[0], 255, 'surface underneath is not darkened twice where cover is 1 and alpha equals h');
  // In stages phase 1 (h > 0, alpha = 0), the surface over the cave dims to (1 - h) with no underground light on the grass.
  l.add({ id: 'crystal-test', x: 57 * TILE_PX, y: 64 * TILE_PX, layer: CAVE, z: -1, color: 0xffffff, radius: 64, inner: 16, intensity: 1, moving: true });
  l.fill(rect, out, [{ layer: CAVE, weight: 0.6 }, { layer: SURFACE, weight: 0.4 }], { over: { layer: CAVE, alpha: 0 } });
  assert.equal(out[0], Math.round(0.4 * 255), 'stages phase 1: surface dims evenly to 1 - h with no cave light on the grass');
  l.remove('crystal-test');
  // A moving light on the sunny surface clamps at 1 on its own layer before weighting, so it never forms a bright halo as the surface dims.
  l.add({ id: 'friend-test', x: 57 * TILE_PX, y: 64 * TILE_PX, layer: SURFACE, z: 2, color: 0xffffff, radius: 64, inner: 16, intensity: 0.9, moving: true });
  l.fill(rect, out, [{ layer: CAVE, weight: 0.5 }, { layer: SURFACE, weight: 0.5 }], { over: { layer: CAVE, alpha: 0 } });
  assert.equal(out[0], Math.round(0.5 * 255), 'surface moving light does not exceed daylight on its layer');
  l.remove('friend-test');
});


test('every way in preserves surface weight and bounds cave light at every step and coverage', () => {
  const l = new Lighting({ w: 4, h: 4, tile: 16, res: 4, layers: 2 });
  const cover = new Float32Array(16 * 16);
  for (let i = 0; i < cover.length; i++) cover[i] = [0, 0.25, 0.75, 1][i % 4]!;
  l.setCover(CAVE, cover);
  l.setAmbient(CAVE, new Float32Array(4 * 4 * 3).fill(0.08));
  const out = new Uint8ClampedArray(16 * 16 * 4);
  const rect = { x0: 0, y0: 0, w: 16, h: 16 };
  const own = new Uint8ClampedArray(out.length);
  l.fill(rect, own, [{ layer: CAVE, weight: 1 }]);
  const material = new Uint8ClampedArray(16 * 16 * 4).fill(255);
  const pixels = new Uint8ClampedArray(material.length);
  for (const way of ['blend', 'eased', 'stages', 'iris'] as const)
    for (const tiles of [1, 3])
      for (let step = 0; step <= 100; step++) {
        const v = wayIn(step * (tiles + 2) / 100, tiles, way);
        const iris = way === 'iris' && v.light > 0.001 && v.light < 0.999
          ? { layer: CAVE, x: 32, y: 32, r: v.light * 64, soft: 16 } : undefined;
        litPixels(material, 16, 0, 0, own, 16, 16, 0, 0, 4, 0, 0, 16, 16, pixels, iris);
        for (let i = 0; i < pixels.length; i += 4)
          for (let c = 0; c < 3; c++)
            assert.ok(pixels[i + c]! * pixels[i + 3]! / 255 * (iris ? 1 : v.alpha) <= own[c]! + 1, way + ': rendered cave pixels never brighter than inside');
        l.fill(rect, out, [{ layer: CAVE, weight: v.light }, { layer: SURFACE, weight: 1 - v.light }], { over: { layer: CAVE, alpha: v.alpha }, iris });
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
          const cov = cover[y * 16 + x]!;
          const h = iris ? Math.max(0, Math.min(1, (iris.r + iris.soft - Math.hypot((x + 0.5) * 4 - iris.x, (y + 0.5) * 4 - iris.y)) / iris.soft)) : v.light;
          const a = iris ? h : v.alpha;
          const rem = 1 - a * cov;
          const surface = 1 - h;
          const caveUnder = h * (1 - cov) * 0.08;
          const expected = surface + caveUnder;
          assert.ok(Math.abs(rem * out[(y * 16 + x) * 4]! / 255 - expected) < 0.005, way + ': surface is not darkened twice');
          const caveContribution = caveUnder + a * cov * 0.08;
          assert.ok(caveContribution <= 0.08 + 1e-8, way + ': cave material never brighter than inside');
          if (v.alpha === 0 && cov === 1) assert.ok(Math.abs(out[(y * 16 + x) * 4]! / 255 - surface) < 0.005, 'no cave light on hidden floors');
          if (v.light === 0) assert.equal(out[(y * 16 + x) * 4], 255, 'no threshold iris ring');
        }
      }
});

test('over remains precise near full opacity and at the fully occluded endpoint', () => {
  const l = new Lighting({ w: 1, h: 1, tile: 16, res: 4, layers: 2 });
  l.setCover(CAVE, new Float32Array(16).fill(1));
  const out = new Uint8ClampedArray(4);
  for (const h of [0, 0.5, 0.99995, 1]) {
    l.fill({ x0: 0, y0: 0, w: 1, h: 1 }, out, [{ layer: CAVE, weight: h }, { layer: SURFACE, weight: 1 - h }], { over: { layer: CAVE, alpha: h } });
    assert.equal(out[0], h === 1 ? 0 : 255);
  }
});

test('portal weighting preserves moving light from the surface when its ambient weight is zero', () => {
  const l = new Lighting({ w: 2, h: 2, tile: 16, res: 4, layers: 2 });
  l.setAmbient(CAVE, new Float32Array(12).fill(0.05));
  l.add({ id: 'surface', layer: SURFACE, x: 8, y: 8, z: 0, color: 0xffffff, radius: 64, inner: 32, intensity: 0.4, moving: true });
  const out = new Uint8ClampedArray(4);
  l.fill({ x0: 3, y0: 3, w: 1, h: 1 }, out, [{ layer: CAVE, weight: 0 }, { layer: SURFACE, weight: 1 }], { portal: { layer: CAVE, mask: new Uint8Array(4).fill(1) } });
  assert.ok(Math.abs(out[0]! / 255 - 0.45) < 0.005, 'b=0, m=1 keeps the cross-layer moving light');
});

test('cave mover tint keeps its own light, base tint and full depth darkness', () => {
  assert.equal(caveTint([0.1, 0.2, 0.4], 0xffffff, 0, 0.6), 0x1a3366);
  assert.equal(caveTint([1, 1, 1], 0x804020, 2, 0.5), 0x402010);
  assert.equal(caveTint([0, 0, 0], 0xffffff, 0, 0.6), 0);
});

test('bounded crossfade matches the full image after viewport changes and scratch release', () => {
  const src = new Uint8ClampedArray(20 * 20 * 4);
  for (let y = 3; y < 18; y++) for (let x = y % 5; x < 11; x++) src.set([120, 180, 220, 200], (y * 20 + x) * 4);
  const light = new Uint8ClampedArray(8 * 8 * 4).fill(150);
  const spans = pixelSpans(src, 20);
  const full = new Uint8ClampedArray(32 * 32 * 4);
  const bounded = new Uint8ClampedArray(full.length).fill(255);
  for (const [rx, ry, w, h] of [[-4, -4, 32, 32], [8, 10, 9, 8], [200, 200, 5, 6], [0, 0, 28, 28]]) {
    clearLitScratch();
    litPixels(src, 20, 4, 4, light, 8, 8, 0, 0, 4, rx!, ry!, 32, 32, full);
    litPixels(src, 20, 4, 4, light, 8, 8, 0, 0, 4, rx!, ry!, 32, 32, bounded, null, { w: w!, h: h!, spans });
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 4; c++) {
      const i = (y * 32 + x) * 4 + c;
      assert.equal(bounded[i], x < w! && y < h! ? full[i] : 0, 'no stale pixels after shrinking or moving');
    }
  }
});
