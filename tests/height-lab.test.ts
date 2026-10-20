import test from 'node:test';
import assert from 'node:assert/strict';
import { CAVE, SURFACE, buildLabArea, routeLegs, LAB_W } from '../src/game/height-lab/area.ts';
import { E, KIND, N, S, TILE_PX, findPath, move, step, zAt, sample, type Walker } from '../src/game/height-lab/levels.ts';

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
