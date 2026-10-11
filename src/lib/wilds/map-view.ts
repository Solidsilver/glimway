/**
 * The world map's view (docs/design/world-map.md 3): where it looks and how
 * close. A centre in world tiles (continuous: tile tx covers tx..tx+1) and a
 * scale in CSS pixels a tile. One tile is 16 game pixels in the world and one
 * pixel of the old Journal picture; here it is `scale` CSS px.
 *
 * Pure: no DOM, no Phaser. src/ui/WorldMap.svelte keeps one of these and
 * src/ui/map-renderer.ts draws through it; labels, marks and hit tests all
 * use the same transform.
 */

/** The map viewport's size in CSS px. */
export interface MapViewport {
  w: number;
  h: number;
}

/** The displayed frame, inclusive, in world tiles. */
export interface TileRect {
  minTx: number;
  minTy: number;
  maxTx: number;
  maxTy: number;
}

export interface MapView {
  /** The world point at the viewport's centre, in tiles. */
  cx: number;
  cy: number;
  /** CSS px a tile. */
  scale: number;
}

/** The closest the map goes (CSS px a tile). */
export const MAP_MAX_SCALE = 16;
/** The opening scale, shown as 100% (owner's decision: open close up on you). */
export const MAP_DEFAULT_SCALE = 4;
/** The furthest out a big map may go before "fit" takes over (CSS px a tile). */
export const MAP_MIN_SCALE = 0.5;
/** One zoom step (buttons, keys, a wheel notch): four steps double or halve. */
export const MAP_ZOOM_STEP = 2 ** (1 / 4);
/** Room kept round the frame when it is fitted (CSS px, both sides together). */
export const MAP_FIT_MARGIN = 32;
/** A key press pans this far (CSS px); Shift pans further. */
export const MAP_PAN_PX = 48;
export const MAP_PAN_FAR_PX = 144;

/** The frame's size in tiles. */
const span = (f: TileRect) => ({ w: f.maxTx - f.minTx + 1, h: f.maxTy - f.minTy + 1 });

/** The scale that shows the whole frame, with a margin (never closer than the most). */
export function fitScale(vp: MapViewport, frame: TileRect): number {
  const { w, h } = span(frame);
  const uw = Math.max(1, vp.w - MAP_FIT_MARGIN);
  const uh = Math.max(1, vp.h - MAP_FIT_MARGIN);
  return Math.min(MAP_MAX_SCALE, uw / Math.max(1, w), uh / Math.max(1, h));
}

/** The scales allowed: out to `min(0.5, fit)`, in to 16. */
export function scaleRange(vp: MapViewport, frame: TileRect): { min: number; max: number } {
  return { min: Math.min(MAP_MIN_SCALE, fitScale(vp, frame)), max: MAP_MAX_SCALE };
}

export function clampScale(scale: number, vp: MapViewport, frame: TileRect): number {
  const r = scaleRange(vp, frame);
  if (!Number.isFinite(scale)) return MAP_DEFAULT_SCALE;
  return Math.min(r.max, Math.max(r.min, scale));
}

/**
 * Keep the frame in view. Per axis: the centre stays between the frame's
 * first and last tile centres (half a viewport of parchment past an edge at
 * most, so a player on the edge can still be centred); where the scaled
 * frame is smaller than the viewport, it sits at the frame's middle.
 */
export function clampView(view: MapView, vp: MapViewport, frame: TileRect): MapView {
  const scale = clampScale(view.scale, vp, frame);
  const axis = (c: number, lo: number, hi: number, px: number) => {
    if ((hi - lo + 1) * scale <= px) return (lo + hi + 1) / 2;
    return Math.min(hi + 0.5, Math.max(lo + 0.5, Number.isFinite(c) ? c : (lo + hi + 1) / 2));
  };
  return { scale, cx: axis(view.cx, frame.minTx, frame.maxTx, vp.w), cy: axis(view.cy, frame.minTy, frame.maxTy, vp.h) };
}

/** A world point (tiles) on screen (CSS px from the viewport's top-left). */
export function toScreen(view: MapView, vp: MapViewport, x: number, y: number): { x: number; y: number } {
  return { x: vp.w / 2 + view.scale * (x - view.cx), y: vp.h / 2 + view.scale * (y - view.cy) };
}

/** A tile's centre on screen. */
export function tileToScreen(view: MapView, vp: MapViewport, tx: number, ty: number): { x: number; y: number } {
  return toScreen(view, vp, tx + 0.5, ty + 0.5);
}

/** The world point (tiles) under a screen point. */
export function toWorld(view: MapView, vp: MapViewport, sx: number, sy: number): { x: number; y: number } {
  return { x: view.cx + (sx - vp.w / 2) / view.scale, y: view.cy + (sy - vp.h / 2) / view.scale };
}

/** Centred on a world point at this scale (clamped). */
export function centreOn(x: number, y: number, scale: number, vp: MapViewport, frame: TileRect): MapView {
  return clampView({ cx: x, cy: y, scale }, vp, frame);
}

/** The whole frame: fitted and centred. */
export function showAll(vp: MapViewport, frame: TileRect): MapView {
  return clampView({ cx: (frame.minTx + frame.maxTx + 1) / 2, cy: (frame.minTy + frame.maxTy + 1) / 2, scale: fitScale(vp, frame) }, vp, frame);
}

/**
 * A new scale with the world point under (sx, sy) kept there (the wheel,
 * a pinch, the buttons about the viewport's centre), then clamped.
 */
export function zoomAbout(view: MapView, vp: MapViewport, frame: TileRect, scale: number, sx: number, sy: number): MapView {
  const s = clampScale(scale, vp, frame);
  const p = toWorld(view, vp, sx, sy);
  return clampView({ scale: s, cx: p.x - (sx - vp.w / 2) / s, cy: p.y - (sy - vp.h / 2) / s }, vp, frame);
}

/** `steps` zoom steps (positive: closer) about a screen point. */
export function zoomSteps(view: MapView, vp: MapViewport, frame: TileRect, steps: number, sx = vp.w / 2, sy = vp.h / 2): MapView {
  return zoomAbout(view, vp, frame, view.scale * MAP_ZOOM_STEP ** steps, sx, sy);
}

/** Move the sheet by (dx, dy) CSS px: the map follows the pointer. */
export function panBy(view: MapView, vp: MapViewport, frame: TileRect, dx: number, dy: number): MapView {
  return clampView({ ...view, cx: view.cx - dx / view.scale, cy: view.cy - dy / view.scale }, vp, frame);
}

/**
 * Two fingers: the world point under the starting midpoint follows the
 * current midpoint, and the scale follows the fingers' spread (clamped as it
 * goes, so letting go never jumps).
 */
export interface Pinch {
  view: MapView;
  a: { x: number; y: number };
  b: { x: number; y: number };
}

export function pinchView(start: Pinch, a: { x: number; y: number }, b: { x: number; y: number }, vp: MapViewport, frame: TileRect): MapView {
  const d0 = Math.max(1, Math.hypot(start.b.x - start.a.x, start.b.y - start.a.y));
  const d1 = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  const m0 = { x: (start.a.x + start.b.x) / 2, y: (start.a.y + start.b.y) / 2 };
  const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const s = clampScale(start.view.scale * (d1 / d0), vp, frame);
  const p = toWorld(start.view, vp, m0.x, m0.y);
  return clampView({ scale: s, cx: p.x - (m1.x - vp.w / 2) / s, cy: p.y - (m1.y - vp.h / 2) / s }, vp, frame);
}

/**
 * Settle on whole device pixels after a gesture: the world's origin lands on
 * a physical pixel, so tile edges draw crisp. The scale is left alone.
 */
export function snapView(view: MapView, vp: MapViewport, dpr: number): MapView {
  const r = Math.max(1, dpr);
  const snap = (c: number, px: number) => {
    const t = Math.round((px / 2 - view.scale * c) * r) / r;
    return (px / 2 - t) / view.scale;
  };
  return { scale: view.scale, cx: snap(view.cx, vp.w), cy: snap(view.cy, vp.h) };
}

/** The tiles at least partly on screen (inclusive), with `marginPx` CSS px round them. */
export function visibleTiles(view: MapView, vp: MapViewport, marginPx = 0): TileRect {
  const a = toWorld(view, vp, -marginPx, -marginPx);
  const b = toWorld(view, vp, vp.w + marginPx, vp.h + marginPx);
  return { minTx: Math.floor(a.x), minTy: Math.floor(a.y), maxTx: Math.ceil(b.x) - 1, maxTy: Math.ceil(b.y) - 1 };
}

/** Same scale, new viewport size: the world centre stays, then the clamp. */
export function resizeView(view: MapView, vp: MapViewport, frame: TileRect): MapView {
  return clampView(view, vp, frame);
}

/** The scale as the zoom readout shows it: 4 px a tile is 100%. */
export function zoomPercent(scale: number): number {
  return Math.round((scale / MAP_DEFAULT_SCALE) * 100);
}

/** CSS px for one wheel step; line and page deltas are turned into pixels first. */
export const WHEEL_STEP_PX = 100;
const LINE_PX = 100 / 3;

/**
 * The wheel, turned into zoom steps. A mouse notch is about one step; a
 * trackpad's many small deltas add up until they make one, so a tiny event
 * never makes a whole step alone. Wheel up (negative delta) zooms in.
 */
export class WheelZoom {
  private acc = 0;
  private at = -Infinity;

  /** Whole steps for this event (positive: closer), carrying the remainder. */
  steps(deltaY: number, deltaMode: number, pagePx: number, now: number): number {
    if (now - this.at > 400) this.acc = 0;
    this.at = now;
    const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * pagePx : deltaY;
    this.acc -= px;
    const n = Math.trunc(this.acc / WHEEL_STEP_PX);
    this.acc -= n * WHEEL_STEP_PX;
    return n;
  }
}
