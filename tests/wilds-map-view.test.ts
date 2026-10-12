import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_FLOOR_SCALE,
  MAP_MAX_SCALE,
  MAP_ZOOM_STEP,
  WheelZoom,
  centreOn,
  clampScale,
  clampView,
  fitScale,
  openingScale,
  panBy,
  pinchView,
  pinchWheelScale,
  resizeView,
  scaleRange,
  showAll,
  snapView,
  tileToScreen,
  toScreen,
  toWorld,
  visibleTiles,
  zoomAbout,
  zoomPercent,
  zoomSteps,
  type TileRect,
} from '../src/lib/wilds/map-view.ts';
import { loadWilds } from '../src/lib/wilds/data.ts';

const VP = { w: 1200, h: 800 };
/** The wilds' chunk size in tiles (24 in content/wilds.json); openingScale takes it as a parameter. */
const CHUNK = loadWilds().chunkSize;
/** A wide frame west and north of the origin (negative tiles throughout). */
const FRAME: TileRect = { minTx: -480, minTy: -360, maxTx: 71, maxTy: 23 };
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('screen and world round trip at negative coordinates', () => {
  const view = { cx: -317.25, cy: -120.5, scale: 5.3 };
  for (const [x, y] of [[-400.75, -300.1], [0, 0], [12.5, -1]] as const) {
    const s = toScreen(view, VP, x, y);
    const w = toWorld(view, VP, s.x, s.y);
    close(w.x, x);
    close(w.y, y);
  }
  // The view's centre is the viewport's middle; a tile's centre is half a tile in.
  assert.deepEqual(toScreen(view, VP, view.cx, view.cy), { x: 600, y: 400 });
  const t = tileToScreen({ cx: -10, cy: -10, scale: 4 }, VP, -10, -10);
  assert.deepEqual(t, { x: 602, y: 402 });
});

test('the zoom limits: out to min(0.5, fit), in to 32, and four steps double', () => {
  const fit = fitScale(VP, FRAME);
  close(fit, Math.min((1200 - 32) / 552, (800 - 32) / 384));
  assert.deepEqual(scaleRange(VP, FRAME), { min: 0.5, max: MAP_MAX_SCALE });
  // A huge frame: fit is the furthest out.
  const huge = { minTx: -20000, minTy: -20000, maxTx: 20000, maxTy: 20000 };
  assert.ok(scaleRange(VP, huge).min < 0.05);
  close(scaleRange(VP, huge).min, fitScale(VP, huge));
  // A tiny frame: fit is capped at MAP_MAX_SCALE, and you can still go out to 0.5.
  const tiny = { minTx: 0, minTy: 0, maxTx: 3, maxTy: 3 };
  assert.equal(fitScale(VP, tiny), MAP_MAX_SCALE);
  assert.equal(scaleRange(VP, tiny).min, 0.5);
  assert.equal(clampScale(100, VP, FRAME), MAP_MAX_SCALE);
  assert.equal(clampScale(0.01, VP, FRAME), 0.5);
  // Four steps in from 100% is 200%; four out is 50%.
  const v = { cx: -100, cy: -100, scale: MAP_FLOOR_SCALE };
  close(zoomSteps(v, VP, FRAME, 4).scale, 8);
  close(zoomSteps(v, VP, FRAME, -4).scale, 2);
  close(zoomSteps(v, VP, FRAME, 1).scale, 4 * MAP_ZOOM_STEP);
  assert.equal(zoomPercent(4, 4), 100);
  assert.equal(zoomPercent(8, 4), 200);
});

test('the opening scale: two chunks on the viewport’s shorter side, clamped', () => {
  // Desktop 1700×920: the 920 px side shows two chunks (48 tiles) at 19.2 px a tile.
  close(openingScale({ w: 1700, h: 920 }, CHUNK), 920 / (2 * CHUNK));
  // A phone, 390×700 portrait: the 390 px side, 8.1 px a tile.
  close(openingScale({ w: 390, h: 700 }, CHUNK), 390 / (2 * CHUNK));
  // Huge 2560×1400: the 1400 px side is 29.2 px a tile for two chunks — just under MAP_MAX_SCALE,
  // which is where the clamp starts (past a 1536 px shorter side: 2560×1600 clamps to MAP_MAX_SCALE).
  close(openingScale({ w: 2560, h: 1400 }, CHUNK), 1400 / (2 * CHUNK));
  assert.equal(openingScale({ w: 2560, h: 1600 }, CHUNK), MAP_MAX_SCALE);
  // The floor: a tiny window never opens as a blur.
  assert.equal(openingScale({ w: 480, h: 160 }, CHUNK), MAP_FLOOR_SCALE);
  // The readout is 100% at the opening scale of the current viewport, 200% one octave in.
  for (const vp of [{ w: 1700, h: 920 }, { w: 390, h: 700 }, { w: 2560, h: 1400 }]) {
    const opening = openingScale(vp, CHUNK);
    assert.equal(zoomPercent(opening, opening), 100);
    assert.equal(zoomPercent(2 * opening, opening), 200);
  }
});

test('the wheel and the buttons zoom about a point that stays put', () => {
  const v = { cx: -200, cy: -150, scale: 4 };
  const at = { x: 300, y: 650 };
  const before = toWorld(v, VP, at.x, at.y);
  const z = zoomAbout(v, VP, FRAME, 7, at.x, at.y);
  const after = toScreen(z, VP, before.x, before.y);
  close(after.x, at.x, 1e-6);
  close(after.y, at.y, 1e-6);
  // Steps about the middle keep the centre.
  const mid = zoomSteps(v, VP, FRAME, 3);
  close(mid.cx, v.cx);
  close(mid.cy, v.cy);
});

test('a pinch keeps the world under its midpoint, follows it as it moves, and scales with the spread', () => {
  const start = { view: { cx: -250, cy: -100, scale: 4 }, a: { x: 500, y: 400 }, b: { x: 700, y: 400 } };
  const under = toWorld(start.view, VP, 600, 400);
  // Spread to twice the distance and move the midpoint 40 px right.
  const v = pinchView(start, { x: 440, y: 400 }, { x: 840, y: 400 }, VP, FRAME);
  close(v.scale, 8);
  const now = toScreen(v, VP, under.x, under.y);
  close(now.x, 640, 1e-6);
  close(now.y, 400, 1e-6);
  // Past the limit the scale stops at MAP_MAX_SCALE (no jump when the fingers part further).
  const far = pinchView(start, { x: -1000, y: 400 }, { x: 2200, y: 400 }, VP, FRAME);
  assert.equal(far.scale, MAP_MAX_SCALE);
});

test('the centre is kept between the frame’s first and last tile centres', () => {
  // Far past the west edge: held at the first tile's centre (half a viewport of parchment beyond).
  const west = clampView({ cx: -10_000, cy: -100, scale: 4 }, VP, FRAME);
  assert.equal(west.cx, FRAME.minTx + 0.5);
  const south = clampView({ cx: -100, cy: 10_000, scale: 4 }, VP, FRAME);
  assert.equal(south.cy, FRAME.maxTy + 0.5);
  // A player on the edge can be centred.
  const edge = centreOn(FRAME.maxTx + 0.5, FRAME.minTy + 0.5, 4, VP, FRAME);
  assert.deepEqual([edge.cx, edge.cy], [FRAME.maxTx + 0.5, FRAME.minTy + 0.5]);
  // Dragging can't take the map out of view.
  const dragged = panBy({ cx: -100, cy: -100, scale: 4 }, VP, FRAME, 1e6, 1e6);
  assert.deepEqual([dragged.cx, dragged.cy], [FRAME.minTx + 0.5, FRAME.minTy + 0.5]);
  // Dragging right moves the map right: the centre goes west.
  const p = panBy({ cx: -100, cy: -100, scale: 4 }, VP, FRAME, 40, -20);
  assert.deepEqual([p.cx, p.cy], [-110, -95]);
});

test('a small map sits in the middle on the axis it fits, even over exact player centring', () => {
  const small = { minTx: -60, minTy: -120, maxTx: 59, maxTy: 23 };
  // 120 tiles at 4 px is 480 px: narrower than 1200, so x is fixed at the middle; 144 × 4 = 576 < 800 too.
  const v = centreOn(50, -100, 4, VP, small);
  assert.equal(v.cx, 0);
  assert.equal(v.cy, -48);
  // Close in, the frame is bigger than the viewport and the player can be centred.
  const c = centreOn(50, -100, 16, VP, small);
  assert.deepEqual([c.cx, c.cy], [50, -100]);
  // Show all: fitted, at the middle.
  const all = showAll(VP, small);
  close(all.scale, fitScale(VP, small));
  assert.deepEqual([all.cx, all.cy], [0, -48]);
});

test('a resize keeps the world centre and scale where it can; a frame that grows doesn’t move the view', () => {
  const v = { cx: -300, cy: -200, scale: 6 };
  assert.deepEqual(resizeView(v, { w: 360, h: 600 }, FRAME), v);
  // Shrinking so far that the scale is out of range clamps it.
  const tiny = resizeView({ ...v, scale: 0.5 }, { w: 360, h: 600 }, { minTx: 0, minTy: 0, maxTx: 9, maxTy: 9 });
  assert.equal(tiny.scale, 0.5);
  // More walked land (a new origin): the same world centre, untouched.
  const grown = { ...FRAME, minTx: FRAME.minTx - 240, maxTy: FRAME.maxTy + 48 };
  assert.deepEqual(clampView(v, VP, grown), v);
  // Only a changed clamp range moves it.
  const shrunk = { ...FRAME, minTx: -250 };
  assert.equal(clampView(v, VP, shrunk).cx, -249.5);
});

test('after a gesture the origin lands on a device pixel, the scale untouched', () => {
  const v = { cx: -123.4567, cy: 45.678, scale: 5.37 };
  for (const dpr of [1, 2, 3]) {
    const s = snapView(v, VP, dpr);
    assert.equal(s.scale, v.scale);
    const origin = toScreen(s, VP, 0, 0);
    close(origin.x * dpr, Math.round(origin.x * dpr), 1e-6);
    close(origin.y * dpr, Math.round(origin.y * dpr), 1e-6);
    assert.ok(Math.abs(s.cx - v.cx) * v.scale <= 0.5 / dpr + 1e-9);
  }
});

test('the visible tiles cover the viewport', () => {
  const r = visibleTiles({ cx: -10, cy: -10, scale: 4 }, { w: 400, h: 200 });
  assert.deepEqual(r, { minTx: -60, minTy: -35, maxTx: 39, maxTy: 14 });
  const m = visibleTiles({ cx: -10, cy: -10, scale: 4 }, { w: 400, h: 200 }, 40);
  assert.deepEqual(m, { minTx: -70, minTy: -45, maxTx: 49, maxTy: 24 });
});

test('the wheel: a notch is a step, small trackpad deltas add up, line deltas count as pixels', () => {
  const w = new WheelZoom();
  assert.equal(w.steps(-100, 0, 800, 0), 1, 'wheel up zooms in');
  assert.equal(w.steps(100, 0, 800, 1000), -1);
  let total = 0;
  for (let i = 0; i < 9; i++) total += w.steps(-11, 0, 800, 2000 + i * 16);
  assert.equal(total, 0, 'nine tiny deltas are not a step yet');
  total += w.steps(-11, 0, 800, 2200);
  assert.equal(total, 1, 'the tenth makes one');
  assert.equal(w.steps(3, 1, 800, 5000), -1, 'three lines is a notch');
  // A pause forgets a half-made step.
  w.steps(-60, 0, 800, 6000);
  assert.equal(w.steps(-60, 0, 800, 7000), 0);
});

test('a trackpad pinch (Ctrl/⌘ wheel) zooms continuously, in when the fingers spread, at most double or half an event', () => {
  // Small deltas, small changes: no quarter-octave step.
  const a = pinchWheelScale(4, -3, 0, 800);
  assert.ok(a > 4 && a < 4 * 2 ** 0.25, `${a}`);
  const b = pinchWheelScale(4, 3, 0, 800);
  assert.ok(b < 4 && b > 4 / 2 ** 0.25, `${b}`);
  // In and back out again lands where it began.
  close(pinchWheelScale(pinchWheelScale(4, -7, 0, 800), 7, 0, 800), 4);
  // A big flick is bounded.
  assert.equal(pinchWheelScale(4, -10_000, 0, 800), 8);
  assert.equal(pinchWheelScale(4, 10_000, 0, 800), 2);
  // About the pointer, through the same anchored zoom as the wheel.
  const v = { cx: -200, cy: -150, scale: 4 };
  const under = toWorld(v, VP, 300, 650);
  const z = zoomAbout(v, VP, FRAME, pinchWheelScale(v.scale, -5, 0, 800), 300, 650);
  const now = toScreen(z, VP, under.x, under.y);
  close(now.x, 300, 1e-6);
  close(now.y, 650, 1e-6);
});
