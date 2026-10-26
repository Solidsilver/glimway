import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AREA_OPTIONS } from '../src/game/height-lab/area.ts';
import { migrateLook, SLOPE_PRESETS, slopesLook } from '../src/game/height-lab/look.ts';
import { KIND, SURFACE, newLayer, type Walker } from '../src/game/height-lab/levels.ts';
import { buildSlopes, fieldEdges, slopeWalk, uphillFactor, type Field } from '../src/game/height-lab/slopes.ts';
import { slopeGait } from '../src/game/terrain/slope-gait.ts';
import { SUN, sunFacing, sunShadow, sunTint } from '../src/game/terrain/sun.ts';
import { chunkKey, paintField } from '../src/game/height-lab/slopes-paint.ts';

function plane(gx: number, gy: number) {
  const n = 20;
  const f: Field = { w: n, h: n, corner: new Float32Array(n * n * 4), kind: new Uint8Array(n * n).fill(KIND.slope), ground: new Uint8Array(n * n), slope: new Float32Array(n * n) };
  const surface = newLayer('surface', n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const z = 4 + gx * (x - 10) + gy * (y - 10);
    const i = y * n + x;
    f.corner.set([z, z + gx, z + gx + gy, z + gy], i * 4);
    surface.kind[i] = KIND.slope;
    surface.edge.set(fieldEdges(f, i), i * 4);
  }
  return { f, stack: { w: n, h: n, layers: [surface, newLayer('cave', n, n)], portals: new Map() } };
}
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('2b sliders migrate Off/Gentle, retain numeric values, and reject invalid settings independently', () => {
  assert.equal(migrateLook({ slopeUphill: 'off' }).slopeUphill, 0);
  assert.equal(migrateLook({ slopeUphill: 'gentle' }).slopeUphill, 12);
  const l = migrateLook({ slopeUphill: 40, slopeDownhill: 20, sunlight: false, slopeGait: false, sunStrength: 0.6 });
  assert.equal(l.slopeUphill, 40); assert.equal(l.slopeDownhill, 20);
  assert.equal(l.sunlight, false); assert.equal(l.slopeGait, false); assert.equal(l.sunStrength, 0.6);
  const d = migrateLook({ slopeUphill: 81, slopeDownhill: -1, sunStrength: NaN });
  assert.equal(d.slopeUphill, 60); assert.equal(d.slopeDownhill, 6); assert.equal(d.sunStrength, 1);
});

test('2b speed is monotonic in each slider, normalized and rotation invariant; across stays unchanged', () => {
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    const ux = Math.cos(a), uy = Math.sin(a);
    const { f } = plane(0.2 * ux, 0.2 * uy);
    let previousUp = 1, previousDown = 1;
    for (let cap = 0; cap <= 80; cap++) {
      const up = uphillFactor(f, 160, 160, ux, uy, cap / 100, 0.2).k;
      assert.ok(up <= previousUp + 1e-6); previousUp = up;
      near(up, 1 - cap / 100 * 0.8);
      near(uphillFactor(f, 160, 160, ux * 5, uy * 5, cap / 100, 0.2).k, up);
      near(uphillFactor(f, 160, 160, -uy, ux, cap / 100, 0.2).k, 1);
    }
    for (let cap = 0; cap <= 20; cap++) {
      const down = uphillFactor(f, 160, 160, -ux, -uy, 0.4, cap / 100).k;
      assert.ok(down >= previousDown - 1e-6); previousDown = down;
      near(down, 1 + cap / 100 * 0.8);
    }
  }
});

test('2b numeric speed caps give the same travel time in every drawing style and with sunlight on/off', () => {
  for (const [up, down] of [[0, 0], [12, 6], [40, 20], [60, 6], [80, 20]]) {
    let reference: number[] | undefined;
    for (const preset of Object.values(SLOPE_PRESETS)) for (const sunlight of [false, true]) {
      const area = buildSlopes(DEFAULT_AREA_OPTIONS, slopesLook({ ...preset.look, sunlight, sunStrength: 0.7 }));
      const times = [];
      for (const dy of [-1, 1]) {
        const w: Walker = { layer: SURFACE, x: 86 * 16, y: 96.5 * 16 + 2, hw: 5, fh: 4 };
        if (dy === 1) w.y -= 56;
        const r = slopeWalk(area.stack, area.slopes!.field, w, 0, dy, 110, 2, up, 56, down);
        near(r.px, 56); times.push(r.used);
      }
      if (reference) times.forEach((t, i) => near(t, reference![i], 1e-10));
      reference ??= times;
    }
  }
});

test('2b gait cadence follows actual speed; lean reverses downhill, has no across component, and scuffs only steep moving feet', () => {
  const up = slopeGait(0.25, 0, 66, 0, 110);
  const down = slopeGait(0.25, 0, -132, 0, 110);
  near(up.cadence, 0.6); near(down.cadence, 1.2);
  near(up.x, 1); assert.ok(up.y < 0); near(down.x, 1); near(down.y, 0);
  assert.ok(up.scuff); assert.ok(down.scuff);
  const across = slopeGait(0.25, 0, 0, 110, 110);
  near(across.x, 0); near(across.y, 0);
  const idle = slopeGait(0.25, 0, 0, 0, 110);
  assert.equal(idle.scuff, false); near(idle.cadence, 0); near(idle.x, 0);
  assert.equal(slopeGait(0.05, 0, 110, 0, 110).scuff, false);
});

test('2b shadows point SE, lengthen away from the sun and shorten toward it, and accept a future sun direction', () => {
  const flat = sunShadow(0, 0, 10);
  const sunny = sunShadow(0.14, 0.14, 10);
  const shaded = sunShadow(-0.14, -0.14, 10);
  for (const r of [flat, sunny, shaded]) { assert.ok(r.dx > 0 && r.dy > 0); near(r.angle, Math.PI / 4); assert.ok(Number.isFinite(r.length)); }
  assert.ok(shaded.length > flat.length && flat.length > sunny.length);
  near(sunShadow(0, 0, 20).length, flat.length * 2);
  near(sunShadow(0, 0, 0).length, 0);
  assert.ok(sunShadow(-2, -2, 10).length < 100);
  assert.ok(sunShadow(0, 0, 10, [0.5, 0, 0.8]).dx < 0);
});

test('sun tint is Lambert plus a bounded cool fill, preserving each sprite base colour', () => {
  near(sunFacing(0, 0), SUN[2]);
  assert.ok(sunFacing(0.14, 0.14) > sunFacing(-0.14, -0.14));
  assert.ok((sunTint(0.14, 0.14) >>> 16) > (sunTint(-0.14, -0.14) >>> 16));
  const tint = sunTint(-0.2, -0.2, 1, 0xaabbcc);
  assert.ok((tint >>> 16) <= 0xaa && ((tint >>> 8) & 255) <= 0xbb && (tint & 255) <= 0xcc);
});

test('sun controls leave ground albedo and cache identity unchanged', () => {
  const make = (sunlight: boolean, sunStrength: number) => buildSlopes(DEFAULT_AREA_OPTIONS, { facing: 'restrained', contours: 'off', terraces: false, lift: 0, sunlight, sunStrength });
  const off = make(false, 1), full = make(true, 2), zero = make(true, 0);
  const px = (a: typeof full) => paintField(a, 81 * 16, 87 * 16, 16, 16).px;
  assert.deepEqual(px(off), px(full)); assert.deepEqual(px(full), px(zero));
  assert.equal(chunkKey(full, 0, 0), chunkKey(zero, 0, 0));
});
