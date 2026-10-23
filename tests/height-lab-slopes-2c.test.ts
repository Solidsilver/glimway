import test from 'node:test';
import assert from 'node:assert/strict';
import { AMBIENT, NIGHT, clockSun, lightTint, shadowOpacity, silhouetteTransform, sunAt, sunFacing, sunShadow, surfaceLight, type SunDirection } from '../src/game/height-lab/sun.ts';
import { SUN_REACH, buildSunMap, sampleSunMap, terrainVisibility } from '../src/game/height-lab/sun-map.ts';
import { buildSlopes, uphillFactor, type Field } from '../src/game/height-lab/slopes.ts';
import { DEFAULT_AREA_OPTIONS } from '../src/game/height-lab/area.ts';
import { migrateLook, slopesLook } from '../src/game/height-lab/look.ts';
import { chunkKey, paintPart } from '../src/game/height-lab/slopes-paint.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const drain = <T>(it: Generator<void, T>): T => { for (;;) { const r = it.next(); if (r.done) return r.value; } };
function field(w: number, h: number, height: (x: number, y: number) => number): Field {
  const f: Field = { w, h, corner: new Float32Array(w * h * 4), ground: new Uint8Array(w * h), kind: new Uint8Array(w * h), slope: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f.corner.fill(height(x, y), (y * w + x) * 4, (y * w + x + 1) * 4);
  return f;
}

test('2c linear speed responds to the uphill component, saturates, and migrates old saved caps', () => {
  const f = field(4, 4, () => 0);
  for (let i = 0; i < 16; i++) f.corner.set([0, 0.1, 0.1, 0], i * 4);
  near(uphillFactor(f, 24, 24, 1, 0, .8, .2).k, .68);
  near(uphillFactor(f, 24, 24, -1, 0, .8, .2).k, 1.08);
  near(uphillFactor(f, 24, 24, 0, 1, .8, .2).k, 1);
  const migrated = migrateLook({ slopeUphill: 40, sunStrength: 1, slopeDownhill: 0 });
  assert.equal(migrated.slopeUphill, 40); assert.equal(migrated.slopeDownhill, 0);
  assert.equal(migrated.sunTime, .5); assert.equal(migrated.sunClock, false);
  assert.equal(migrateLook({ slopeUphill: 80, sunStrength: 2 }).slopeUphill, 80);
  assert.equal(migrateLook({ sunStrength: 2 }).sunStrength, 2);
  for (const v of [NaN, Infinity, -1, 1.1]) assert.equal(migrateLook({ sunTime: v }).sunTime, .5);
});

test('2c Lambert is the bilinear surface normal, with cool ambient even in full terrain shadow', () => {
  near(sunFacing(0, 0, [0, 0, 1]), 1);
  near(sunFacing(1 / 3, 0, [1, 0, 0]), -Math.SQRT1_2);
  near(sunFacing(-1 / 3, 0, [1, 0, 0]), Math.SQRT1_2);
  const sun = sunAt(.5);
  for (const l of [-1, 0, .2, 1]) {
    surfaceLight(l, 0, sun).forEach((c, i) => near(c, AMBIENT[i]!));
    surfaceLight(l, 1, sun, 2).forEach((c, i) => assert.ok(c >= AMBIENT[i]! && c <= 1));
  }
  assert.deepEqual(surfaceLight(1, 1, sunAt(.5, 0), 2), NIGHT);
  assert.equal(lightTint([1, 1, 1], 0xabcdef), 0xabcdef);
});

test('2c a wall shadows only its far side, rotates with azimuth, lengthens at low elevation, and reads across chunk seams', () => {
  const f = field(100, 40, x => x === 48 ? 2 : 0);
  const east: SunDirection = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const west: SunDirection = [-Math.SQRT1_2, 0, Math.SQRT1_2];
  const visible = (x: number, sun: SunDirection) => terrainVisibility(f, x * 16, 20 * 16, 0, sun);
  assert.equal(visible(46, east), 0); assert.equal(visible(51, east), 1);
  assert.equal(visible(46, west), 1); assert.equal(visible(51, west), 0);
  assert.equal(visible(35, east), 1); assert.equal(visible(35, [0.98, 0, 0.2]), 0);
  const north = field(40, 40, (_x, y) => y === 20 ? 2 : 0);
  assert.equal(terrainVisibility(north, 16 * 20, 16 * 22, 0, [0, -0.7, 0.7]), 0);
  assert.equal(terrainVisibility(north, 16 * 20, 16 * 18, 0, [0, -0.7, 0.7]), 1);
  assert.equal(SUN_REACH, 64);
});

test('2c silhouette affine transform anchors the feet and sends its top away from the sun, longer at low elevation', () => {
  for (const t of [.1, .5, .9]) {
    const sun = sunAt(t), ray = sunShadow(0, 0, 20, sun.direction);
    assert.ok(ray.dx * sun.direction[0] + ray.dy * sun.direction[1] < 0);
    const m = silhouetteTransform(12, 20, ray.dx, ray.dy);
    near(m.a * 6 + m.c * 20 + m.e, 0); near(m.b * 6 + m.d * 20 + m.f, 0);
    near(m.a * 6 + m.e, ray.dx); near(m.b * 6 + m.f, ray.dy + 1.5);
  }
  assert.ok(sunShadow(0, 0, 20, sunAt(.1).direction).length > sunShadow(0, 0, 20, sunAt(.5).direction).length * 3);
  near(shadowOpacity(0, 1), 0); near(shadowOpacity(.5, 1), shadowOpacity(1, 1) / 2);
  near(shadowOpacity(1, 1, 0), 0); assert.ok(shadowOpacity(1, 1) > .32);
});

test('2c the tilted arc rises east, remains north at noon, sets west; game clock wraps through dim night', () => {
  const dawn = sunAt(0), noon = sunAt(.5), dusk = sunAt(1);
  assert.ok(dawn.direction[0] > .99); assert.ok(dusk.direction[0] < -.99);
  assert.ok(noon.direction[1] < -.1); assert.ok(noon.direction[2] > .9);
  near(noon.direction[0], 0); near(dawn.direction[2], dusk.direction[2]);
  assert.ok(dawn.color[2] < noon.color[2]); assert.ok(dusk.color[1] < noon.color[1]);
  near(clockSun(12 * 3600).time, .5); near(clockSun(0).daylight, 0);
  near(clockSun(-86400 + 12 * 3600).time, .5);
  assert.deepEqual(clockSun(6 * 3600), dawn); assert.deepEqual(clockSun(18 * 3600), dusk);
});

test('2c recomputing light preserves exact albedo and its cache key; shared chunk samples agree', () => {
  const area = buildSlopes(DEFAULT_AREA_OPTIONS, slopesLook(migrateLook({ area: 'slopes' })));
  const part = { x0: 69, y0: 46, x1: 74, y1: 49 };
  const before = paintPart(area, part), saved = before.px.slice(), key = chunkKey(area, 3, 2);
  const morning = drain(buildSunMap(area.slopes!, 69 * 16, 46 * 16, 96, 64, sunAt(.1), 1));
  const evening = drain(buildSunMap(area.slopes!, 69 * 16, 46 * 16, 96, 64, sunAt(.9), 1));
  assert.notDeepEqual(morning.px, evening.px);
  assert.deepEqual(before.px, saved); assert.deepEqual(paintPart(area, part).px, saved);
  assert.equal(chunkKey(area, 3, 2), key);
  const next = drain(buildSunMap(area.slopes!, 75 * 16, 46 * 16, 32, 64, sunAt(.1), 1));
  assert.deepEqual(sampleSunMap(morning, 75 * 16, 47 * 16), sampleSunMap(next, 75 * 16, 47 * 16));
});
