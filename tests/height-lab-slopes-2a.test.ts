import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AREA_OPTIONS, G } from '../src/game/height-lab/area.ts';
import { KIND, ROWS_PER_LEVEL, SURFACE, TILE_PX, newLayer, type Stack, type Walker } from '../src/game/height-lab/levels.ts';
import { SLOPE_KEYS, SLOPE_PRESETS, SLOPE_RESET, migrateLook, slopePresetOf, slopesLook, styleOf, styleSettings, type SlopeLook } from '../src/game/height-lab/look.ts';
import { chunkKey, paintField } from '../src/game/height-lab/slopes-paint.ts';
import {
  KNOLL,
  MAX_WALK_SLOPE,
  ROCKY,
  UPHILL_CAP,
  buildField,
  buildSlopes,
  display,
  fieldEdges,
  fieldZ,
  liftColumn,
  liftPad,
  mapPoint,
  nearestWalkable,
  reach,
  spanAt,
  slopeWalk,
  uphillFactor,
  walkableKind,
  type Field,
  type SlopesLook
} from '../src/game/height-lab/slopes.ts';

/**
 * Slopes lab round 2a (src/game/height-lab/slopes.ts, look.ts): the uphill
 * slowdown, the presets and saved settings, the lift strengths, and that
 * every combination of drawing settings walks the same field.
 */

const T = TILE_PX;
const field = buildField();

/** Every combination of the drawing settings. */
const LOOKS: SlopesLook[] = [];
for (const facing of ['off', 'restrained', 'current'] as const)
  for (const contours of ['off', 'sparse', 'current'] as const)
    for (const terraces of [false, true])
      for (const lift of [0, 24, 48] as const) LOOKS.push({ facing, contours, terraces, lift });

/** A small area whose height is z(x, y) (levels, x and y in tiles), all walkable: a field and a stack walking it. */
function plane(z: (x: number, y: number) => number, n = 40): { f: Field; stack: Stack } {
  const f: Field = { w: n, h: n, corner: new Float32Array(n * n * 4), kind: new Uint8Array(n * n).fill(KIND.slope), ground: new Uint8Array(n * n), slope: new Float32Array(n * n) };
  const surface = newLayer('surface', n, n);
  for (let ty = 0; ty < n; ty++)
    for (let tx = 0; tx < n; tx++) {
      const i = ty * n + tx;
      f.corner.set([z(tx, ty), z(tx + 1, ty), z(tx + 1, ty + 1), z(tx, ty + 1)], i * 4);
      surface.kind[i] = KIND.slope;
      surface.edge.set(fieldEdges(f, i), i * 4);
    }
  return { f, stack: { w: n, h: n, layers: [surface, newLayer('cave', n, n)], portals: new Map() } };
}

const walker = (x: number, y: number): Walker => ({ x, y, layer: SURFACE, hw: 5, fh: 4 });

/** Walk (ux, uy) for px, a frame of dt at a time: the field seconds it takes. */
function run(f: Field, stack: Stack, w: Walker, ux: number, uy: number, px: number, dt = 1 / 60, gentle = true): number {
  let t = 0;
  let walked = 0;
  while (walked < px - 1e-9 && t < 60) {
    const x0 = w.x;
    const y0 = w.y;
    const r = slopeWalk(stack, f, w, ux, uy, 110, dt, gentle, px - walked);
    t += r.used;
    walked += Math.hypot(w.x - x0, w.y - y0);
    if (Math.hypot(w.x - x0, w.y - y0) < r.px * 0.5) throw new Error('blocked');
  }
  return t;
}

test('uphill slowdown: full speed on the flat, downhill and across the slope; at most 12% slower straight up the walking limit', () => {
  const { f } = plane((x) => 0.2 * x);
  const at = (ux: number, uy: number) => uphillFactor(f, 20 * T, 20 * T, ux, uy).k;
  assert.equal(at(-1, 0), 1, 'downhill');
  assert.equal(at(0, 1), 1, 'across');
  assert.equal(at(0, -1), 1, 'across, the other way');
  assert.equal(uphillFactor(plane(() => 2).f, 20 * T, 20 * T, 1, 0).k, 1, 'the flat');
  // Up 0.2 a tile: t = 0.8, smoothstep 0.896.
  assert.ok(Math.abs(at(1, 0) - (1 - UPHILL_CAP * 0.896)) < 1e-6, `up 0.2: ${at(1, 0)}`);
  const limit = plane((x) => MAX_WALK_SLOPE * x).f;
  assert.ok(Math.abs(uphillFactor(limit, 20 * T, 20 * T, 1, 0).k - (1 - UPHILL_CAP)) < 1e-9, 'straight up the limit: the cap');
  // Gentle hills barely slow: up 0.05 a tile is under 1.5% slower.
  assert.ok(uphillFactor(plane((x) => 0.05 * x).f, 20 * T, 20 * T, 1, 0).k > 0.985);
  // Half uphill (45° across a 0.2 slope): between.
  const k45 = at(Math.SQRT1_2, Math.SQRT1_2);
  assert.ok(k45 > at(1, 0) && k45 < 1, `45° across: ${k45}`);
});

test('uphill slowdown: turning the hill and the walker together changes nothing (8 directions)', () => {
  const g = 0.2;
  const ks: number[] = [];
  const times: number[] = [];
  for (let a = 0; a < 8; a++) {
    const th = (a * Math.PI) / 4;
    const [cx, cy] = [Math.cos(th), Math.sin(th)];
    const { f, stack } = plane((x, y) => 5 + g * (cx * (x - 20) + cy * (y - 20)));
    // Straight up, and 60° off uphill.
    ks.push(uphillFactor(f, 20 * T, 20 * T, cx, cy).k);
    const off = th + Math.PI / 3;
    ks.push(uphillFactor(f, 20 * T, 20 * T, Math.cos(off), Math.sin(off)).k);
    times.push(run(f, stack, walker(20 * T, 20 * T), cx, cy, 6 * T));
  }
  for (let i = 0; i < ks.length; i += 2) {
    assert.ok(Math.abs(ks[i]! - ks[0]!) < 1e-6, `up, direction ${i / 2}: ${ks[i]} vs ${ks[0]}`);
    assert.ok(Math.abs(ks[i + 1]! - ks[1]!) < 1e-6, `60° off, direction ${i / 2}`);
  }
  for (const t of times) assert.ok(Math.abs(t - times[0]!) < 1e-6, `run times: ${times.map((x) => x.toFixed(4)).join(', ')}`);
  // And the time is the slowed one: 6 tiles at 110 px/s × k.
  assert.ok(Math.abs(times[0]! - (6 * T) / (110 * ks[0]!)) < 1e-3);
});

test('uphill slowdown: on the knoll, up from north, south, east and west takes the same time; down and across are full speed', () => {
  const area = buildSlopes(DEFAULT_AREA_OPTIONS);
  const f = area.slopes!.field;
  const cx = KNOLL.x * T;
  const cy = KNOLL.y * T;
  const ups: number[] = [];
  const downs: number[] = [];
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    // From 5.5 tiles out to 2 tiles out (the even flank), toward the top; and back down.
    const w = walker(cx + dx * 5.5 * T, cy + dy * 5.5 * T + 2);
    ups.push(run(f, area.stack, w, -dx, -dy, 3.5 * T));
    downs.push(run(f, area.stack, w, dx, dy, 3.5 * T));
  }
  const full = (3.5 * T) / 110;
  // Within 2%: the valley under the knoll has its own gentle roll (a few hundredths of a level a tile).
  for (const t of ups) assert.ok(Math.abs(t - ups[0]!) / ups[0]! < 0.02, `uphill runs: ${ups.map((t) => t.toFixed(3)).join(', ')}`);
  assert.ok(ups[0]! > full * 1.08 && ups[0]! < full * 1.13, `uphill ${ups[0]} vs full speed ${full}`);
  for (const t of downs) assert.ok(Math.abs(t - full) < 1e-6, `downhill runs: ${downs.join(', ')}`);
  // Across: round the knoll's east side, northward (the slope rises west there; going north only gets lower).
  const across = run(f, area.stack, walker(cx + 5 * T, cy + 2), 0, -1, 2 * T);
  assert.ok(Math.abs(across - (2 * T) / 110) / ((2 * T) / 110) < 0.003, `across: ${across}`);
});

test('uphill slowdown: a diagonal is as fast as straight, and the time does not depend on the frame rate', () => {
  const { f, stack } = plane(() => 1);
  for (const [ux, uy] of [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2]] as const) {
    const w = walker(20 * T, 20 * T);
    const r = slopeWalk(stack, f, w, ux, uy, 110, 0.1, true);
    assert.ok(Math.abs(Math.hypot(w.x - 20 * T, w.y - 20 * T) - 11) < 1e-6, `(${ux}, ${uy}) walks 11 px in 0.1 s`);
    assert.equal(r.at.k, 1);
  }
  const hill = plane((x, y) => 2 + 0.15 * Math.sin(x / 3) * 3 + 0.1 * y);
  const times = [1 / 20, 1 / 30, 1 / 60, 1 / 144].map((dt) => run(hill.f, hill.stack, walker(5 * T, 30 * T), 0.6, -0.8, 14 * T, dt));
  for (const t of times) assert.ok(Math.abs(t - times[2]!) / times[2]! < 0.003, `frame rates: ${times.map((t) => t.toFixed(4)).join(', ')}`);
});

test('every drawing setting walks the same field: the same collision map, spawn, reach and uphill times', () => {
  const base = buildSlopes(DEFAULT_AREA_OPTIONS, LOOKS[0]);
  const l0 = base.stack.layers[SURFACE]!;
  const reach0 = reach(base.stack, base.spawn);
  const spawn = base.spawn;
  const timeOn = (area: typeof base) => {
    const w = walker(KNOLL.x * T, (KNOLL.y + 5.5) * T + 2);
    return run(area.slopes!.field, area.stack, w, 0, -1, 3.5 * T);
  };
  const t0 = timeOn(base);
  for (const look of LOOKS) {
    const a = buildSlopes(DEFAULT_AREA_OPTIONS, look);
    const l = a.stack.layers[SURFACE]!;
    const name = JSON.stringify(look);
    assert.deepEqual(l.kind, l0.kind, `${name}: kinds`);
    assert.deepEqual(l.edge, l0.edge, `${name}: edges`);
    assert.deepEqual(a.spawn, spawn, `${name}: spawn`);
    assert.deepEqual(a.route, base.route, `${name}: Wren's loop`);
    assert.deepEqual(reach(a.stack, a.spawn), reach0, `${name}: what's reachable`);
    assert.equal(timeOn(a), t0, `${name}: the same uphill run takes the same field time`);
    assert.equal(a.slopes!.lift, look.lift > 0);
  }
});

test('lift strengths: everything lifts k rows a level (24 px: 1.5, 48 px: 3), cliffs open into k rows of face a level', () => {
  for (const lift of [24, 48] as const) {
    const a = buildSlopes(DEFAULT_AREA_OPTIONS, { facing: 'restrained', contours: 'off', terraces: false, lift });
    const info = a.slopes!;
    const k = lift / T;
    assert.equal(info.k, k);
    assert.equal(info.pad, liftPad(info.field, k));
    assert.equal(info.view.h, info.field.h + info.pad, 'the view: field height plus the margin');
    // Someone at height z is drawn 16 k z px north (plus the margin).
    const d = display(info, 70 * T + 8, 96 * T + 10, 1.5);
    assert.ok(Math.abs(d.y - (96 * T + 10 - lift * 1.5 + info.pad * T)) < 1e-9);
    // The outcrop's cliff: k rows of face a level.
    const col = liftColumn(info.field, 103, 0.5, info.pad, k);
    const face = col.find((s) => s.face && s.ty === 96)!;
    assert.ok(Math.abs(face.s1 - face.s0 - (face.zS - face.zBot) * k) < 0.05, `${lift}: face rows`);
    // The view's faces are as tall as that, no taller (a cliff is opened once, not also by its footprint).
    let most = 0;
    for (let i = 0; i < info.view.w * info.view.h; i++) if (info.view.kind[i] === KIND.face) most = Math.max(most, info.view.faceRows[i]!);
    assert.ok(most <= Math.ceil(15 * k) + 1, `${lift}: tallest face ${most} rows`);
    // Where a tile's middle is drawn (display), the lifted column there shows that tile's ground, unless something
    // nearer and higher hides it. (Pixel columns, as painted: the view's tile grid samples one field tile a row and
    // can skip one squashed under a row.)
    let shown = 0;
    let checked = 0;
    for (let ty = 0; ty < info.field.h; ty += 3)
      for (let tx = 0; tx < info.field.w; tx += 3) {
        const j = ty * info.field.w + tx;
        if (!walkableKind(a.stack.layers[SURFACE]!.kind[j]!)) continue;
        const z = fieldZ(info.field, tx, ty, 0.5, 0.5);
        const d = display(info, tx * T + 8, ty * T + 8, z);
        if (d.hidden) continue;
        checked++;
        const sp = spanAt(liftColumn(info.field, tx, 0.5, info.pad, k), d.y / T - 0.02);
        if (sp && !sp.face && sp.ty === ty) shown++;
      }
    assert.ok(shown / checked > 0.99, `${lift}: ${shown}/${checked} walkable tiles drawn on their own ground`);
    // mapPoint: the view row the tile's middle is drawn in.
    const m = mapPoint(info, 70, 96);
    assert.equal(m.ty, Math.round(96 + info.pad - k * fieldZ(info.field, 70, 96, 0.5, 0.5)));
  }
});

test('lift strengths: a weaker lift hides no more walkable ground than the full one', () => {
  const hidden = (lift: 24 | 48) => {
    const a = buildSlopes(DEFAULT_AREA_OPTIONS, { facing: 'off', contours: 'off', terraces: false, lift });
    const info = a.slopes!;
    let n = 0;
    for (let ty = 0; ty < info.field.h; ty += 2)
      for (let tx = 0; tx < info.field.w; tx += 2) {
        if (!walkableKind(a.stack.layers[SURFACE]!.kind[ty * info.field.w + tx]!)) continue;
        if (display(info, tx * T + 8, ty * T + 8, fieldZ(info.field, tx, ty, 0.5, 0.5)).hidden) n++;
      }
    return n;
  };
  const moderate = hidden(24);
  const full = hidden(48);
  assert.ok(moderate <= full, `hidden walkable tiles: moderate ${moderate}, full ${full}`);
  assert.ok(full > 0, 'behind the plateau patch, the full lift hides some');
});

test('presets: the five, as documented; a preset is recognised; reset is the Shading baseline with gentle slowdown', () => {
  assert.deepEqual(Object.values(SLOPE_PRESETS).map((p) => p.name), ['Shading baseline', 'Sparse contours', 'Small terraces', 'Moderate lift', 'Full lift reference']);
  const b = SLOPE_PRESETS.baseline.look;
  assert.deepEqual(b, { slopeFacing: 'restrained', slopeContours: 'off', slopeTerraces: false, slopeLift: 0 });
  assert.deepEqual(SLOPE_PRESETS.sparse.look, { ...b, slopeContours: 'sparse' });
  assert.deepEqual(SLOPE_PRESETS.terraces.look, { ...b, slopeTerraces: true });
  assert.deepEqual(SLOPE_PRESETS.moderate.look, { ...b, slopeLift: 24 });
  assert.deepEqual(SLOPE_PRESETS.full.look, { slopeFacing: 'current', slopeContours: 'off', slopeTerraces: false, slopeLift: 48 });
  for (const [name, p] of Object.entries(SLOPE_PRESETS)) assert.equal(slopePresetOf(p.look), name);
  assert.equal(slopePresetOf({ ...b, slopeContours: 'current' }), null);
  assert.equal(SLOPE_RESET.slopeUphill, 'gentle');
  assert.equal(slopePresetOf(SLOPE_RESET as SlopeLook), 'baseline');
  // Presets change only the drawing.
  for (const p of Object.values(SLOPE_PRESETS)) assert.deepEqual(Object.keys(p.look).sort(), [...SLOPE_KEYS].sort());
  // Round 1's styles as settings, and back.
  for (const st of ['shade', 'contours', 'terraces', 'lift'] as const) assert.equal(styleOf(styleSettings(st, b)), st);
  assert.equal(styleSettings('lift', b).slopeLift, 48);
});

test('saved settings migrate: round 1’s style and shading become the settings that draw the same; anything unknown is the default', () => {
  const d = migrateLook(null);
  assert.equal(slopePresetOf(d), 'baseline');
  assert.equal(d.slopeUphill, 'gentle');
  const old = (slopeStyle: string, slopeShade: boolean) => slopesLook(migrateLook({ area: 'slopes', fog: 'sky', slopeStyle, slopeShade }));
  assert.deepEqual(old('shade', false), { facing: 'current', contours: 'off', terraces: false, lift: 0 }, 'shading by facing was always shaded');
  assert.deepEqual(old('contours', true), { facing: 'current', contours: 'current', terraces: false, lift: 0 });
  assert.deepEqual(old('contours', false), { facing: 'off', contours: 'current', terraces: false, lift: 0 });
  assert.deepEqual(old('terraces', false), { facing: 'off', contours: 'off', terraces: true, lift: 0 });
  assert.deepEqual(old('lift', true), { facing: 'current', contours: 'off', terraces: false, lift: 48 });
  // The rest of an old save kept.
  const m = migrateLook({ area: 'slopes', fog: 'sky', darkness: 0.3, slopeStyle: 'lift', slopeShade: true });
  assert.equal(m.area, 'slopes');
  assert.equal(m.fog, 'sky');
  assert.equal(m.darkness, 0.3);
  assert.ok(!('slopeStyle' in m) && !('slopeShade' in m), 'the old keys go');
  // Bad values: defaults, field by field.
  const bad = migrateLook({ area: 'moon', fog: 3, darkness: 7, crossfade: Number.NaN, slopeLift: 30, slopeFacing: 'loud', slopeTerraces: 'yes', slopeUphill: 'gentle', zoom: false });
  assert.equal(bad.area, d.area);
  assert.equal(bad.fog, d.fog);
  assert.equal(bad.darkness, d.darkness);
  assert.equal(bad.crossfade, d.crossfade);
  assert.equal(bad.slopeLift, d.slopeLift);
  assert.equal(bad.slopeFacing, d.slopeFacing);
  assert.equal(bad.slopeTerraces, d.slopeTerraces);
  assert.equal(bad.zoom, false, 'good values kept');
  // New settings win over old keys if both are there.
  assert.equal(migrateLook({ slopeStyle: 'lift', slopeLift: 24 }).slopeLift, 24);
  assert.deepEqual(migrateLook('garbage'), d);
  assert.deepEqual(migrateLook([1, 2]), d);
});

test('the paint cache tells every drawing setting apart', () => {
  const keys = new Set(LOOKS.map((look) => chunkKey({ slopes: { look } } as Parameters<typeof chunkKey>[0], 2, 3)));
  assert.equal(keys.size, LOOKS.length);
});

test('restrained facing shade shifts the palette: no darker than 0.7 or brighter than 1.2 of unshaded, and grass stays green', () => {
  const at = (facing: SlopesLook['facing']) => {
    const a = buildSlopes(DEFAULT_AREA_OPTIONS, { facing, contours: 'off', terraces: false, lift: 0 });
    // The knoll and the valley round it, and the pass's lower slopes.
    return [paintField(a, (KNOLL.x - 9) * T, (KNOLL.y - 9) * T, 18 * T, 18 * T).px, paintField(a, 60 * T, 50 * T, 24 * T, 20 * T).px];
  };
  const off = at('off');
  const on = at('restrained');
  const cur = at('current');
  let lo = Infinity;
  let hi = 0;
  let curLo = Infinity;
  let green = 0;
  let greenKept = 0;
  for (let p = 0; p < off.length; p++)
    for (let i = 0; i < off[p]!.length; i += 4) {
      const lum = (px: Uint8ClampedArray) => 0.3 * px[i]! + 0.59 * px[i + 1]! + 0.11 * px[i + 2]!;
      const r = lum(on[p]!) / Math.max(1, lum(off[p]!));
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
      curLo = Math.min(curLo, lum(cur[p]!) / Math.max(1, lum(off[p]!)));
      if (off[p]![i + 1]! > off[p]![i]! + 8 && off[p]![i + 1]! > off[p]![i + 2]! + 8) {
        green++;
        if (on[p]![i + 1]! > on[p]![i]! && on[p]![i + 1]! > on[p]![i + 2]!) greenKept++;
      }
    }
  assert.ok(lo >= 0.69, `darkest ${lo.toFixed(3)}`);
  assert.ok(hi <= 1.2, `brightest ${hi.toFixed(3)}`);
  assert.ok(curLo < lo, `current goes darker (${curLo.toFixed(3)})`);
  assert.ok(green > 1000 && greenKept / green > 0.995, `green kept: ${greenKept}/${green}`);
});

test('sparse contours are fixed to the world: a pixel paints the same whichever part it is painted in', () => {
  const a = buildSlopes(DEFAULT_AREA_OPTIONS, { facing: 'restrained', contours: 'sparse', terraces: false, lift: 0 });
  const x0 = (KNOLL.x - 6) * T;
  const y0 = (KNOLL.y - 6) * T;
  const one = paintField(a, x0, y0, 12 * T, 12 * T).px;
  const two = paintField(a, x0 + 37, y0 + 21, 12 * T, 12 * T).px;
  let differ = 0;
  for (let y = 21; y < 12 * T; y++)
    for (let x = 37; x < 12 * T; x++) {
      const i = (y * 12 * T + x) * 4;
      const j = ((y - 21) * 12 * T + x - 37) * 4;
      if (one[i] !== two[j] || one[i + 1] !== two[j + 1] || one[i + 2] !== two[j + 2]) differ++;
    }
  assert.equal(differ, 0);
  // And they're there: sparse differs from no contours on the knoll, but on few pixels.
  const none = paintField(buildSlopes(DEFAULT_AREA_OPTIONS, { facing: 'restrained', contours: 'off', terraces: false, lift: 0 }), x0, y0, 12 * T, 12 * T).px;
  let marked = 0;
  for (let i = 0; i < one.length; i += 4) if (one[i] !== none[i]) marked++;
  const share = marked / (one.length / 4);
  assert.ok(share > 0.005 && share < 0.08, `sparse marks ${(share * 100).toFixed(1)}% of the knoll`);
});

test('the knoll: 0.2 level a tile all round its flank, walkable; the rocky path: walkable stone beside the scree, reachable', () => {
  const area = buildSlopes(DEFAULT_AREA_OPTIONS);
  for (let ty = KNOLL.y - 6; ty <= KNOLL.y + 5; ty++)
    for (let tx = KNOLL.x - 6; tx <= KNOLL.x + 5; tx++) {
      const r = Math.hypot(tx + 0.5 - KNOLL.x, ty + 0.5 - KNOLL.y);
      if (r < 2.5 || r > 5.5) continue;
      const i = ty * field.w + tx;
      assert.ok(Math.abs(field.slope[i]! - KNOLL.slope) < 0.045, `(${tx},${ty}) slope ${field.slope[i]}`);
      assert.ok(walkableKind(field.kind[i]!) || field.kind[i] === KIND.prop);
    }
  const seen = reach(area.stack, area.spawn);
  let rocky = 0;
  let reached = 0;
  for (let ty = ROCKY.y0; ty <= ROCKY.y1; ty++)
    for (let tx = ROCKY.x0; tx <= ROCKY.x1; tx++) {
      const i = ty * field.w + tx;
      if (field.ground[i] !== G['tops-path']) continue;
      rocky++;
      assert.ok(walkableKind(area.stack.layers[SURFACE]!.kind[i]!), `(${tx},${ty}) walkable`);
      if (seen[i]) reached++;
    }
  assert.ok(rocky >= 20, `${rocky} rocky path tiles`);
  assert.ok(reached / rocky > 0.9, `${reached}/${rocky} reachable from spawn`);
  const p = area.slopes!.spots.find((s) => s.name === 'rocky-path')!;
  const n = nearestWalkable(area.stack, p.tx, p.ty);
  assert.equal(field.ground[n.ty * field.w + n.tx], G['tops-path'], 'the spot stands on it');
  assert.equal(ROWS_PER_LEVEL, 3, 'collision faces: still 3 rows a level whatever the lift');
});
