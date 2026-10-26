import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AREA_OPTIONS } from '../src/game/height-lab/area.ts';
import { HIDE_ABOVE, buildSlopes, coverRects, coveredPixels, display, fieldZ, styleLook, type SlopesInfo } from '../src/game/height-lab/slopes.ts';
import { EDGE_CAP, EDGE_DEFAULT, EDGE_MARGIN, EDGE_MAX_WIDTH, chunkEdges, combineShade, edgeAmounts, edgeBand, viewHeights, type EdgeSettings } from '../src/game/terrain/edges.ts';
import { EDGE_LOOK, edgeSettings, migrateLook } from '../src/game/height-lab/look.ts';

const flat = buildSlopes(DEFAULT_AREA_OPTIONS, styleLook('shade')).slopes!;
const lifted = buildSlopes(DEFAULT_AREA_OPTIONS, styleLook('lift')).slopes!;
const moderate = buildSlopes(DEFAULT_AREA_OPTIONS, { ...styleLook('lift'), lift: 24 }).slopes!;
const T = 16;

/** Edge amounts over a small window (world px). */
function window(info: SlopesInfo, x: number, y: number, w: number, h: number, s: EdgeSettings = EDGE_DEFAULT) {
  return { ...chunkEdges(info, x, y, w, h, s), x, y, w, h };
}
const count = (a: Float32Array) => a.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);

// ---------------------------------------------------------------- edges

test('2e edges: the stepped plateau’s whole-level steps get bands and rims in every look', () => {
  for (const [name, info] of [['flat', flat], ['lift 48', lifted], ['lift 24', moderate]] as const) {
    const e = window(info, 120 * T, Math.round((64 + (info.lift ? info.pad - info.k * 4 : 0)) * T), 24 * T, 48 * T);
    assert.ok(e.edges > 200, `${name}: edges ${e.edges}`);
    assert.ok(count(e.dark) > 500, `${name}: band px`);
    assert.ok(count(e.rim) > 100, `${name}: rim px`);
  }
});

test('2e edges: gentle hills and the knoll get none at the default threshold', () => {
  for (const info of [flat, lifted]) {
    const hills = window(info, 16 * T, Math.round((76 + (info.lift ? info.pad - info.k * 2 : 0)) * T), 30 * T, 20 * T);
    assert.equal(hills.edges, 0);
    const knoll = window(flat, 78 * T, 83 * T, 16 * T, 16 * T);
    assert.equal(knoll.edges, 0);
  }
});

test('2e edges, flat: the band lies on the low side, behind the higher lip (north of level 4)', () => {
  // Ring c (level 4) starts at row 76; row 75 is level 3, its low side to the north.
  const x = 133 * T + 8;
  const e = window(flat, x - 8, 70 * T, 16, 12 * T);
  const at = (a: Float32Array, wy: number) => a[(wy - 70 * T) * 16 + 8]!;
  assert.ok(at(e.dark, 76 * T - 1) > 0, 'just north of the edge');
  assert.ok(at(e.dark, 76 * T - 2) > 0, 'two px north');
  assert.equal(at(e.dark, 76 * T), 0, 'not on the high side');
  assert.ok(at(e.rim, 76 * T) > 0, 'the rim is on the high lip');
  assert.equal(at(e.dark, 76 * T - 12), 0, 'the band stops');
});

test('2e edges, lift: the band shows on screen behind the lip, where the low ground is drawn', () => {
  const x = 133 * T + 8;
  const h = viewHeights(lifted, x, 0, 1, lifted.view.h * T);
  // Find where ring c's north lip is drawn: the first row of level-4 ground below level-3 ground.
  let lip = -1;
  for (let y = 1; y < h.z.length; y++) if (Math.abs(h.z[y]! - 4) < 0.01 && Math.abs(h.z[y - 1]! - 3) < 0.05 && !h.face[y]) { lip = y; break; }
  assert.ok(lip > 0);
  const e = window(lifted, x - 8, lip - 12, 16, 24);
  assert.ok(e.dark[11 * 16 + 8]! > 0, 'the low ground just above the lip on screen is banded');
  assert.equal(e.dark[12 * 16 + 8]!, 0);
  assert.ok(e.rim[12 * 16 + 8]! > 0);
});

test('2e edges: scaling widens and darkens bigger drops; unscaled every drop is the same', () => {
  const on = { ...EDGE_DEFAULT, scale: true };
  const off = { ...EDGE_DEFAULT, scale: false };
  assert.ok(edgeBand(3, on).width > edgeBand(1, on).width);
  assert.ok(edgeBand(3, on).k > edgeBand(1, on).k);
  assert.deepEqual(edgeBand(3, off), edgeBand(1, off));
  assert.ok(edgeBand(100, on).width <= EDGE_MAX_WIDTH * 2.5 && EDGE_MARGIN > EDGE_MAX_WIDTH * 2.5);
});

test('2e edges: a threshold above the step turns the plateau off; strength 0 is off', () => {
  const box = [120 * T, 64 * T, 24 * T, 48 * T] as const;
  assert.equal(window(flat, ...box, { ...EDGE_DEFAULT, threshold: 1.5 }).edges, 0);
  assert.equal(count(window(flat, ...box, { ...EDGE_DEFAULT, strength: 0 }).dark), 0);
});

test('2e edges: two hard tones, the outer one dithered on a world checkerboard', () => {
  // A synthetic cliff: 2 levels to the east of x = 10.
  const w = 20, h = 4, m = 0;
  const z = new Float32Array(w * h).map((_, i) => (i % w >= 10 ? 2 : 0));
  const e = edgeAmounts({ z, face: new Uint8Array(w * h) }, 0, 0, w, h, m, { ...EDGE_DEFAULT, width: 4, scale: false });
  const row = [...e.dark.slice(0, w)];
  assert.ok(row[9]! > 0 && row[8]! === row[9], 'inner tone, two px');
  assert.ok(row.slice(4, 8).some((v) => v === 0) && row.slice(4, 8).some((v) => v > 0 && v < row[9]!), 'outer tone, dithered');
  assert.equal(new Set(row.filter((v) => v > 0)).size, 2);
  assert.ok(e.rim[10]! > 0 && e.rim[11] === 0);
});

test('2e edges: bands never double-darken past the cap over cast shadows; weaker in terrain shade', () => {
  for (const cast of [1, 0.8, 0.6, 0.5]) for (const edge of [0.2, 0.55]) {
    const v = combineShade(cast, edge, 1);
    assert.ok(v >= Math.min(cast, 1 - edge) * EDGE_CAP - 1e-9);
    assert.ok(v <= Math.min(cast, 1 - edge) + 1e-9);
  }
  assert.ok(combineShade(1, 0.5, 0) > combineShade(1, 0.5, 1));
});

test('2e edges: the look keeps edge settings and defaults', () => {
  assert.deepEqual(edgeSettings(EDGE_LOOK), EDGE_DEFAULT);
  const l = migrateLook({ edgeShade: 0.3, edgeWidth: 5, edgeScale: false, edgeThreshold: 1, edgeRim: false });
  assert.deepEqual(edgeSettings(l), { strength: 0.3, width: 5, scale: false, threshold: 1, rim: false });
  assert.deepEqual(edgeSettings(migrateLook({ edgeShade: 3, edgeWidth: 0 })), EDGE_DEFAULT);
});

// ---------------------------------------------------------------- partial see-through

/** The hero's covered rows (from the top) standing at field tile (tx, ty), a 14 × 20 px sprite. */
function coveredRows(info: SlopesInfo, tx: number, ty: number): { rows: boolean[]; hidden: boolean } {
  const x = tx * T + 8;
  const y = ty * T + 10;
  const z = fieldZ(info.field, tx, ty, 0.5, 10 / 16);
  const d = display(info, x, y, z);
  const top = Math.floor(d.y + 2 - 20);
  const m = coveredPixels(info, y, z, x - 7, top, 14, 20);
  return { rows: [...Array(20)].map((_, r) => m.slice(r * 14, r * 14 + 14).some((v) => v > 0)), hidden: d.hidden };
}

test('2e see-through: with the legs behind the plateau rim only the bottom rows are covered', () => {
  const legs = coveredRows(lifted, 132, 65);
  const n = legs.rows.filter(Boolean).length;
  assert.ok(n >= 4 && n <= 14, `rows covered ${n}`);
  // Covered rows are the bottom ones, contiguous.
  assert.deepEqual(legs.rows, legs.rows.map((_, r) => r >= 20 - n));
  assert.equal(legs.hidden, true);
  // A step further behind: fully covered.
  assert.equal(coveredRows(lifted, 132, 66).rows.every(Boolean), true);
});

test('2e see-through: it works at 24 px a level too, and never without the lift', () => {
  const partial = coveredRows(moderate, 132, 66).rows.filter(Boolean).length;
  assert.ok(partial > 0 && partial < 20);
  assert.equal(coveredRows(moderate, 132, 67).rows.filter(Boolean).length >= 18, true);
  assert.equal(coveredRows(flat, 132, 66).rows.some(Boolean), false);
});

test('2e see-through: open slopes, the ramp and cliff tops never cover the hero', () => {
  for (const [tx, ty] of [[104, 55], [104, 86], [132, 108], [132, 98], [132, 90], [130, 93], [26, 81], [86, 96], [103, 95]] as const) {
    const r = coveredRows(lifted, tx, ty);
    if (r.hidden) continue;
    assert.equal(r.rows.some(Boolean), false, `${tx},${ty}`);
  }
});

test('2e see-through: covered pixels merge into few rectangles', () => {
  const mask = new Uint8Array(6 * 4);
  for (let x = 0; x < 6; x++) for (let y = 2; y < 4; y++) mask[y * 6 + x] = 1;
  mask[1 * 6 + 3] = 1;
  const rects = coverRects(mask, 10, 20, 6, 4);
  assert.equal(rects.reduce((n, r) => n + r.w * r.h, 0), 13);
  assert.ok(rects.length <= 3);
  assert.deepEqual(rects[0], { x: 10, y: 22, w: 3, h: 2 });
});

test('2e see-through: the rule agrees with display at the feet', () => {
  assert.ok(HIDE_ABOVE > 0);
  for (const [tx, ty] of [[132, 65], [132, 66], [100, 82]] as const) assert.equal(coveredRows(lifted, tx, ty).rows[19], true);
});
