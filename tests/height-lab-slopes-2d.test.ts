import test from 'node:test';
import assert from 'node:assert/strict';
import { SUN_ELEVATION, shadowOpacity, sunAt } from '../src/game/terrain/sun.ts';
import { GROUND_ASPECT, MAX_REACH, buildShadowLayer, castProxy, casterProxy, overShadow, shadeMultiply, shadowDarkness, shadowRay, type Caster } from '../src/game/terrain/sun-shadow.ts';
import type { SunMap } from '../src/game/terrain/sun-map.ts';
import { migrateLook } from '../src/game/height-lab/look.ts';

const hours = (h: number) => (h - 6) / 12;
const azimuth = (t: number) => { const d = sunAt(t).direction; return Math.atan2(d[1], d[0]); };
const elevation = (t: number) => Math.asin(sunAt(t).direction[2]);

/** Synthetic masks: w×h RGBA with `pad` empty rows under the art. */
function mask(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) px[(y * w + x) * 4 + 3] = 255;
  return px;
}
const ART: Record<'tree' | 'rock' | 'body', { w: number; h: number; px: Uint8ClampedArray }> = {
  // An oak: trunk rows 14–27 under a crown; four rows of padding.
  tree: { w: 24, h: 32, px: mask(24, 32, (x, y) => ((x - 12) / 10) ** 2 + ((y - 11) / 9.5) ** 2 <= 1 || (y > 14 && y < 28 && x > 10 && x < 14)) },
  // A boulder: a wide low oval, its bottom two rows above the frame edge.
  rock: { w: 20, h: 16, px: mask(20, 16, (x, y) => ((x - 10) / 8) ** 2 + ((y - 8) / 6) ** 2 <= 1) },
  body: { w: 14, h: 20, px: mask(14, 20, (x, y) => x > 3 && x < 11 && y > 2 && y < 20) },
};
const proxy = (kind: keyof typeof ART) => casterProxy(kind, ART[kind].px, ART[kind].w, ART[kind].h);
const FOOT = [200, 300] as const;
const at = (c: ReturnType<typeof castProxy>, wx: number, wy: number) => {
  const ix = Math.floor(wx) - c.x0, iy = Math.floor(wy) - c.y0;
  return ix < 0 || iy < 0 || ix >= c.w || iy >= c.h ? { dir: 0, contact: 0 } : { dir: c.dir[iy * c.w + ix]!, contact: c.contact[iy * c.w + ix]! };
};

test('2d azimuth turns at a bounded, steady rate: no swing at noon', () => {
  const rates: number[] = [];
  for (let i = 0; i < 240; i++) {
    let d = azimuth((i + 1) / 240) - azimuth(i / 240);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    assert.ok(d < 0, 'monotonic: east → north → west');
    rates.push(Math.abs(d) * 240);
  }
  // π a day is 15° an hour; every sample within 1% of it.
  for (const r of rates) assert.ok(Math.abs(r - Math.PI) < 0.03 * Math.PI, `rate ${r}`);
  // The owner's noon steps 11.3 → 12.5 h turn about 18°, as much as 9 → 10.2 h.
  const turn = (a: number, b: number) => Math.abs(azimuth(hours(b)) - azimuth(hours(a))) * 180 / Math.PI;
  assert.ok(Math.abs(turn(11.3, 12.5) - turn(9, 10.2)) < 0.5);
  assert.ok(turn(11.3, 12.5) < 20);
  // Still rises east, north at noon, sets west.
  assert.ok(sunAt(0).direction[0] > 0.9 && sunAt(1).direction[0] < -0.9);
  assert.ok(sunAt(0.5).direction[1] < -0.3);
});

test('2d elevation sets length: short at noon, long at dawn and dusk; never at the zenith', () => {
  for (let i = 0; i <= 100; i++) assert.ok(elevation(i / 100) <= SUN_ELEVATION.max + 1e-9 && elevation(i / 100) >= SUN_ELEVATION.min - 1e-9);
  const len = (h: number) => Math.hypot(...shadowRay(0, 0, sunAt(hours(h)).direction));
  assert.ok(len(12) < 0.5, `noon ${len(12)}`);
  assert.ok(len(9.6) > len(10.6) && len(10.6) > len(11.6) && len(11.6) > len(12) - 1e-9);
  assert.ok(len(16.8) > 3 * len(12) && len(7.2) > 3 * len(12));
  assert.ok(len(6) <= MAX_REACH + 1e-9 && len(18) <= MAX_REACH + 1e-9, 'dawn is capped');
  // Noon length barely changes over the owner's midday steps.
  assert.ok(len(12.5) - len(11.6) < 0.05);
});

test('2d each caster type anchors its shadow at its real footprint', () => {
  for (const kind of ['tree', 'rock', 'body'] as const) {
    const p = proxy(kind), art = ART[kind];
    // The footprint centre sits on the sprite's own pixels: under it, not beside or below it.
    const sx = art.w / 2 + p.foot.x, sy = art.h + p.foot.y;
    assert.equal(art.px[(Math.floor(sy) * art.w + Math.floor(sx)) * 4 + 3], 255, `${kind} footprint inside its sprite`);
    for (const t of [0.15, 0.3, 0.5, 0.7, 0.9]) {
      const c = castProxy(p, FOOT[0], FOOT[1], shadowRay(0, 0, sunAt(t).direction));
      const cx = FOOT[0] + p.foot.x, cy = FOOT[1] + p.foot.y;
      assert.equal(at(c, cx, cy).contact, 1, `${kind} contact at ${t}`);
      assert.equal(at(c, cx, cy).dir, 1, `${kind} directional shadow leaves the footprint at ${t}`);
    }
  }
  // Rocks stand back on their disc; trunks and feet one pixel up from the visible bottom.
  assert.ok(proxy('rock').foot.y < -2);
  assert.equal(proxy('tree').foot.y, -5);
  assert.equal(proxy('body').foot.y, -1);
});

test('2d a tree casts a trunk line out to a crown blob that separates as the sun drops', () => {
  const p = proxy('tree');
  const gap = (t: number) => {
    const v = shadowRay(0, 0, sunAt(t).direction), c = castProxy(p, FOOT[0], FOOT[1], v);
    // Walk the ray from the foot: shadow width across it, per step.
    const len = Math.hypot(v[0], v[1]), ux = v[0] / len, uy = v[1] / len;
    const widths: number[] = [];
    for (let d = 0; d < p.height * len + 12; d += 1) {
      let wid = 0;
      for (let s = -14; s <= 14; s += 0.5) if (at(c, FOOT[0] + p.foot.x + ux * d - uy * s, FOOT[1] + p.foot.y + uy * d + ux * s).dir) wid += 0.5;
      widths.push(wid);
    }
    return { widths, max: Math.max(...widths), neck: Math.min(...widths.slice(2, widths.indexOf(Math.max(...widths)))) };
  };
  const evening = gap(0.9), noon = gap(0.5);
  assert.ok(evening.neck <= 5, `a thin trunk line (${evening.neck})`);
  assert.ok(evening.max > 2.5 * evening.neck, `a wide crown blob (${evening.max})`);
  assert.ok(evening.widths.indexOf(evening.max) > 3 * Math.max(1, noon.widths.indexOf(noon.max)), 'the crown moves out as the sun drops');
});

test('2d contact shadow is always present, faint in terrain shade; the directional part fades there', () => {
  for (const strength of [0.5, 1, 2]) {
    const sun = shadowDarkness(1, 1, 1, 1, strength), shade = shadowDarkness(1, 1, 0, 1, strength), pixelShade = shadowDarkness(1, 1, 1, 0, strength);
    assert.ok(shade > 0.05 && shade < sun * 0.6, 'contact remains, faint');
    assert.equal(pixelShade, shade, 'shade under the pixel or the foot is the same');
    assert.equal(shadowDarkness(1, 0, 0, 1, strength), 0, 'no directional shadow in shade');
    assert.ok(Math.abs(shadowDarkness(1, 0, 1, 1, strength) - shadowOpacity(1, strength)) < 1e-9);
  }
  assert.equal(shadowDarkness(1, 1, 1, 1, 1, 0), 0, 'night has none');
  // Contact is there at every hour, for every caster.
  for (const kind of ['tree', 'rock', 'body'] as const) for (let t = 0; t <= 1; t += 0.125) {
    const c = castProxy(proxy(kind), FOOT[0], FOOT[1], shadowRay(0, 0, sunAt(t).direction));
    assert.ok(c.contact.some(Boolean), `${kind} at ${t}`);
  }
});

test('2d shadows never double-darken: terrain shade, overlapping casters, and walkers over still shadows', () => {
  const p = proxy('tree'), v = shadowRay(0, 0, sunAt(0.8).direction);
  const map = (visible: number): SunMap => {
    const w = 60, h = 60;
    return { x: 0, y: 0, w, h, px: new Uint8ClampedArray(w * h * 4).fill(255), visibility: new Float32Array(w * h).fill(visible) };
  };
  const one: Caster = { x: 200, y: 200, proxy: p, flip: false, v, visible: 1 };
  const drain = <T,>(g: Generator<void, T>) => { for (;;) { const r = g.next(); if (r.done) return r.value; } };
  const lit = drain(buildShadowLayer(map(1), 120, 120, 200, 200, [one], 1, 1)).dark;
  const shaded = drain(buildShadowLayer(map(0), 120, 120, 200, 200, [one], 1, 1)).dark;
  const twice = drain(buildShadowLayer(map(1), 120, 120, 200, 200, [one, { ...one }], 1, 1)).dark;
  const full = shadowOpacity(1, 1) * 1.15 + 1e-6;
  assert.ok(Math.max(...lit) <= full && Math.max(...lit) > 0.4);
  // On terrain-shaded ground only the faint contact remains.
  assert.ok(Math.max(...shaded) < 0.25 && shaded.some(d => d > 0));
  assert.ok(shaded.filter(d => d > 0).length < lit.filter(d => d > 0).length / 4);
  // Two overlapping casters are no darker than one.
  assert.deepEqual(twice, lit);
  // A walker's shadow adds only what the still one lacks.
  for (const [under, over] of [[0.4, 0.3], [0.4, 0.4], [0.2, 0.46], [0, 0.46]] as const) {
    const total = 1 - (1 - under) * (1 - overShadow(under, over));
    assert.ok(Math.abs(total - Math.max(under, over)) < 1e-9);
  }
  // Pixel-art tones: two (body and contact) plus the dithered rim, never a smooth ramp.
  assert.ok(new Set([...lit].filter(d => d > 0).map(d => d.toFixed(4))).size <= 2);
  assert.ok(shadeMultiply(0.5)[2] > shadeMultiply(0.5)[0], 'shadows keep cool fill');
});

test('2d projection is slope-aware: longer on ground falling away from the sun, shorter on ground facing it', () => {
  const sun = sunAt(0.8).direction, flat = Math.hypot(...shadowRay(0, 0, sun));
  // Evening sun is west: ground rising west faces it, ground falling east falls away.
  const away = Math.hypot(...shadowRay(-0.1, 0, sun)), toward = Math.hypot(...shadowRay(0.1, 0, sun));
  assert.ok(away > flat * 1.15 && toward < flat * 0.85, `${toward} < ${flat} < ${away}`);
  // Casts follow: a boulder's shadow is longer on the falling side.
  const p = proxy('rock'), span = (g: number) => castProxy(p, 0, 0, shadowRay(g, 0, sun)).w;
  assert.ok(span(-0.1) > span(0.1));
  // The cap holds on steep ground falling away.
  assert.ok(Math.hypot(...shadowRay(-0.6, 0, sun)) <= MAX_REACH + 1e-9);
});

test('2d proxies are lathed from the art: a pine casts a cone, a body a capsule; mirrored art mirrors', () => {
  const pine = casterProxy('tree', mask(16, 30, (x, y) => (y > 21 && y < 27 && x > 7 && x < 9) || (y > 2 && y <= 22 && Math.abs(x - 8) < (y - 2) * 0.35 + 0.5)), 16, 30);
  const widest = pine.slices.reduce((a, s) => s.r0 > a.r0 ? s : a);
  assert.ok(widest.h0 > 2 && widest.h0 < pine.height / 2, 'cone widest low, above its trunk');
  assert.ok(pine.slices.at(-1)!.r1 < widest.r0 / 2, 'and narrow at the top');
  const body = proxy('body');
  assert.equal(body.slices.length, 1);
  assert.ok(body.contact.ry / body.contact.rx - GROUND_ASPECT < 1e-9);
  const lean = casterProxy('tree', mask(20, 30, (x, y) => (y > 18 && y < 30 && x > 4 && x < 7) || ((x - 12) ** 2 / 36 + (y - 9) ** 2 / 64 <= 1)), 20, 30);
  const v = shadowRay(0, 0, sunAt(0.5).direction);
  const a = castProxy(lean, 100, 100, v), b = castProxy(lean, 100, 100, v, true);
  // Noon's ray runs due south, so the mirrored cast is the mirror image about the foot.
  // (The rim dither is fixed to world pixels, so compare shape, not every rim pixel.)
  let same = 0, n = 0;
  for (let y = a.y0; y < a.y0 + a.h; y++) for (let x = a.x0; x < a.x0 + a.w; x++) if (at(a, x, y).dir) { n++; if (at(b, 199 - x, y).dir) same++; }
  assert.ok(n > 20 && same / n > 0.9, `${same}/${n}`);
  assert.ok(Math.abs(a.x0 + a.w - (200 - b.x0)) <= 1);
});

test('2d saved looks gain sprite shadows: proxy by default, 2c silhouette kept to compare', () => {
  assert.equal(migrateLook({}).spriteShadows, 'proxy');
  assert.equal(migrateLook({ spriteShadows: 'silhouette' }).spriteShadows, 'silhouette');
  assert.equal(migrateLook({ spriteShadows: 'blob' }).spriteShadows, 'proxy');
});

// A rounded shadow must survive rasterisation, where a narrow capsule used
// to turn into a constant-width rectangle under the feet on the noon knoll.
test('2d noon body shadow has a rounded, tapering end on flat and sloping ground', () => {
  const p = proxy('body');
  for (const gy of [0, -0.1, 0.1]) {
    const c = castProxy(p, ...FOOT, shadowRay(0, gy, sunAt(0.5).direction));
    const widths: number[] = [];
    for (let y = Math.floor(FOOT[1] + p.foot.y); y < c.y0 + c.h; y++) {
      let width = 0;
      for (let x = c.x0; x < c.x0 + c.w; x++) width += at(c, x, y).dir;
      if (width) widths.push(width);
    }
    assert.ok(widths.length >= 3, 'visible below the feet');
    assert.ok(widths.at(-1)! <= Math.max(...widths) * 0.8, 'tip rounds off instead of ending as a box');
    assert.ok(widths.filter(w => w < Math.max(...widths)).length >= 2, 'multiple stepped edge rows');
  }
});
