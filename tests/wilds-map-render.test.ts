/**
 * The world map's renderer (docs/design/world-map.md 4): bounded canvas and
 * caches, rasters only for detailed chunks in view or on new input, nothing
 * read while panning, summaries that never show unwalked land, and labels
 * fitted to what's on screen. The last test is the plan's performance
 * fixture: a sparse map of thousands of chunks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN } from '../src/lib/tile.ts';
import { MAP_COLOURS, mapMarks, type MapChunk, type MapInput } from '../src/lib/wilds/map-model.ts';
import { DETAIL_SLOTS, MAP_RASTER_CACHE, MapRenderer, OVERVIEW_MAX_PX, backingSize } from '../src/ui/map-renderer.ts';
import { centreOn, panBy, showAll, tileToScreen, zoomSteps, type MapViewport } from '../src/lib/wilds/map-view.ts';

const S = 24;

function chunk(cx: number, cy: number, ground: number = TERRAIN.grass_c, rev?: string): MapChunk {
  const g = Array.from({ length: S }, () => Array.from({ length: S }, () => ground));
  const solid = Array.from({ length: S }, () => Array.from({ length: S }, () => false));
  return { cx, cy, ground: g, solid, ...(rev ? { rev } : {}) };
}

function input(o: Partial<MapInput> = {}): MapInput {
  return { frontier: { minCx: -4, minCy: -8, maxCx: 4, maxCy: 0 }, chunks: [], glimpse: [], ways: [], places: [], hero: null, words: { you: 'You', gate: 'Commons gate' }, ...o };
}

/** A canvas context that only counts and remembers what it was asked. */
function recorder() {
  const calls = { drawImage: 0, fillRect: 0, strokeRect: 0, clearRect: 0, images: [] as unknown[], smoothing: [] as boolean[] };
  let smoothing = true;
  const ctx = {
    setTransform() {},
    clearRect() {
      calls.clearRect++;
    },
    fillRect() {
      calls.fillRect++;
    },
    strokeRect() {
      calls.strokeRect++;
    },
    setLineDash() {},
    drawImage(img: unknown) {
      calls.drawImage++;
      calls.images.push(img);
      calls.smoothing.push(smoothing);
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    get imageSmoothingEnabled() {
      return smoothing;
    },
    set imageSmoothingEnabled(v: boolean) {
      smoothing = v;
    },
  };
  return { ctx: ctx as never, calls };
}

/** Images as plain records: their pixels and size. */
const images: { rgba: Uint8ClampedArray; w: number; h: number }[] = [];
const make = (rgba: Uint8ClampedArray, w: number, h: number) => {
  const img = { rgba, w, h };
  images.push(img);
  return img as never;
};

const VP: MapViewport = { w: 1200, h: 800 };

test('the canvas is the viewport’s size at most 2× the device pixels, however big the world', () => {
  assert.deepEqual(backingSize(VP, 1), { w: 1200, h: 800, r: 1 });
  assert.deepEqual(backingSize(VP, 2), { w: 2400, h: 1600, r: 2 });
  assert.deepEqual(backingSize(VP, 3), { w: 2400, h: 1600, r: 2 }, 'capped at 2×');
  assert.deepEqual(backingSize({ w: 360, h: 640 }, 0), { w: 360, h: 640, r: 1 });
});

test('close in, only the walked chunks in view are rastered, once each, and panning reuses them', () => {
  const r = new MapRenderer(make);
  r.setInput(input({ chunks: [chunk(0, -1), chunk(1, -1), chunk(-4, -8), chunk(4, 0)] }), 'w:wick');
  const { ctx, calls } = recorder();
  const v = centreOn(12, -12, 8, VP, r.frame()!);
  assert.equal(r.draw(ctx, v, VP, 1).level, 'detail');
  assert.equal(r.stats.rasters, 2, 'the two chunks near the view, not the far ones');
  assert.equal(calls.drawImage, 2);
  // Pan a little: nothing new to raster.
  r.draw(recorder().ctx, panBy(v, VP, r.frame()!, 30, 10), VP, 1);
  assert.equal(r.stats.rasters, 2);
  // The same input again (a redraw): rasters kept.
  r.setInput(input({ chunks: [chunk(0, -1), chunk(1, -1), chunk(-4, -8), chunk(4, 0)] }), 'w:wick');
  r.draw(recorder().ctx, v, VP, 1);
  assert.equal(r.stats.rasters, 2, 'an unchanged chunk keeps its raster (same ground, same revision)');
  // A path laid in one chunk: only that one is drawn again.
  const laid = chunk(1, -1);
  (laid.ground[3] as number[])[3] = TERRAIN.stone_a;
  r.setInput(input({ chunks: [chunk(0, -1), laid, chunk(-4, -8), chunk(4, 0)] }), 'w:wick');
  r.draw(recorder().ctx, v, VP, 1);
  assert.equal(r.stats.rasters, 3);
  // Another wick: everything forgotten.
  r.setInput(input({ chunks: [chunk(0, -1)] }), 'w:wick-2');
  assert.equal(r.cached, 0);
});

test('chunks outside the frontier are never drawn; a summary shows only walked land', () => {
  const r = new MapRenderer(make);
  images.length = 0;
  const walked = [chunk(-1, -2, TERRAIN.water_a), chunk(2, -6)];
  r.setInput(input({ chunks: [...walked, chunk(9, -2)], glimpse: [{ cx: 5, cy: -3, land: 'meadow', river: false }] }), 'w:a');
  const frame = r.frame()!;
  // Far out: the overview.
  const { ctx } = recorder();
  const view = { ...showAll(VP, frame), scale: 0.5 };
  assert.equal(r.draw(ctx, view, VP, 1).level, 'overview');
  const o = images.at(-1)!;
  // Six pixels a chunk; only the two walked chunks' pixels are filled.
  let filled = 0;
  for (let i = 3; i < o.rgba.length; i += 4) if (o.rgba[i]) filled++;
  assert.equal(filled, 2 * 36);
  // The overview isn't rebuilt per drag.
  const before = r.stats.overviews;
  for (let i = 0; i < 10; i++) r.draw(recorder().ctx, panBy(view, VP, frame, i * 7, i * 3), VP, 1);
  assert.equal(r.stats.overviews, before);
  // …only when the input changes.
  r.setInput(input({ chunks: walked }), 'w:a');
  r.draw(recorder().ctx, view, VP, 1);
  assert.equal(r.stats.overviews, before + 1);
  assert.equal(r.stats.summaries, 2, 'chunk summaries are kept while their ground holds');
});

test('the marks: ways and places drawn over the land, you not baked in', () => {
  const marks = mapMarks(
    input({
      ways: [{ id: 'w', name: "Tansy's way", a: 'x', b: 'y', path: [{ x: 3, y: -30 }, { x: 4, y: -30 }] }],
      places: [{ id: 'place:0:-1', kind: 'camp-glade', tx: 10, ty: -40, seen: true, foundBy: 'Tansy' }],
      hero: { tx: 1, ty: -2 },
    }),
  );
  assert.deepEqual(marks.wayTiles, [{ x: 3, y: -30 }, { x: 4, y: -30 }]);
  assert.deepEqual(marks.places, [{ tx: 10, ty: -40, found: true }]);
  assert.equal(marks.labels.some((l) => l.kind === 'you'), false, 'you are on your own layer');
  assert.deepEqual(marks.labels.find((l) => l.kind === 'way'), { kind: 'way', text: "Tansy's way", x: 4, y: -30 });
  assert.ok(MAP_COLOURS.way);
});

test('labels come back as you zoom in, and one off screen never pushes out one on screen', () => {
  const r = new MapRenderer(make);
  r.setInput(
    input({
      places: [
        { id: 'a', kind: 'camp-glade', tx: 10, ty: -40, seen: true, foundBy: null },
        { id: 'b', kind: 'outcrop', tx: 18, ty: -40, seen: true, foundBy: null },
      ],
    }),
    'w:a',
  );
  const frame = r.frame()!;
  const at = (scale: number) => r.labels(centreOn(14, -40, scale, VP, frame), VP, null).filter((l) => l.kind === 'place').length;
  assert.equal(at(2), 1, 'eight tiles apart at 2 px a tile: one name');
  assert.equal(at(16), 2, 'close in: both');
  // A high-ranking label far off screen (a way) doesn't hide the places in view.
  r.setInput(
    input({
      ways: [{ id: 'w', name: 'A long way off', a: 'x', b: 'y', path: [{ x: 10, y: -2000 }] }],
      places: [{ id: 'a', kind: 'camp-glade', tx: 10, ty: -40, seen: true, foundBy: null }],
      frontier: { minCx: -4, minCy: -90, maxCx: 4, maxCy: 0 },
    }),
    'w:a',
  );
  const v = centreOn(10, -40, 4, VP, r.frame()!);
  const shown = r.labels(v, VP, { x: 10.5, y: -39, text: 'You' });
  assert.ok(shown.some((l) => l.kind === 'place') && shown.some((l) => l.kind === 'you'));
  assert.equal(shown.some((l) => l.kind === 'way'), false, 'the way is far off screen');
  // Screen positions: the place's tile centre.
  const place = shown.find((l) => l.kind === 'place')!;
  assert.deepEqual({ x: place.x, y: place.y }, tileToScreen(v, VP, 10, -40));
});

test('performance fixture: thousands of sparse chunks, negative and far apart', () => {
  // 3000 walked chunks scattered over a 1000×1000-chunk frontier (24 000 tiles a side), with gaps.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const frontier = { minCx: -700, minCy: -900, maxCx: 299, maxCy: 99 };
  const chunks: MapChunk[] = [];
  const taken = new Set<string>();
  while (chunks.length < 3000) {
    // Clusters (walks) and strays.
    const cx = Math.floor(frontier.minCx + rand() * 1000);
    const cy = Math.floor(frontier.minCy + rand() * 1000);
    for (let i = 0; i < 6 && chunks.length < 3000; i++) {
      const k = `${cx + i},${cy}`;
      if (taken.has(k)) continue;
      taken.add(k);
      chunks.push(chunk(cx + i, cy, i % 2 ? TERRAIN.grass_c : TERRAIN.grass_b, `e:${k}`));
    }
  }
  const ways = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, name: `Way ${i}`, a: 'a', b: 'b', path: Array.from({ length: 60 }, (_, j) => ({ x: -5000 + i * 300 + j, y: -8000 + i * 200 })) }));
  const places = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, kind: 'camp-glade', tx: -16000 + i * 50, ty: -20000 + i * 40, seen: true, foundBy: i % 3 ? null : 'Tansy' }));
  const big = input({ frontier, chunks, ways, places });

  const r = new MapRenderer(make);
  let t = performance.now();
  r.setInput(big, 'w:wick');
  const setInputMs = performance.now() - t;
  const frame = r.frame()!;
  const time = (name: string, frames: (i: number) => Parameters<MapRenderer['draw']>[1]) => {
    const { ctx } = recorder();
    const ms: number[] = [];
    for (let i = 0; i < 120; i++) {
      const v = frames(i);
      const s = performance.now();
      r.draw(ctx, v, VP, 2);
      r.labels(v, VP, { x: v.cx, y: v.cy, text: 'You' });
      ms.push(performance.now() - s);
    }
    ms.sort((a, b) => a - b);
    const out = { name, median: +ms[60]!.toFixed(3), p95: +ms[114]!.toFixed(3), max: +ms[119]!.toFixed(3) };
    return out;
  };
  // Close in on a cluster, dragging across it.
  const c0 = chunks[0]!;
  const close = centreOn(c0.cx * S + 12, c0.cy * S + 12, 4, VP, frame);
  const drag = time('drag at 4 px/tile', (i) => panBy(close, VP, frame, -i * 9, -i * 4));
  // Fitted to the whole frontier and dragging there.
  const all = showAll(VP, frame);
  t = performance.now();
  r.draw(recorder().ctx, all, VP, 2);
  const firstOverviewMs = performance.now() - t;
  const over = time('drag at overview', (i) => panBy(all, VP, frame, i * 3, i * 2));
  // Zooming out from close to the overview and back (wheel steps about the middle).
  const zoom = time('zoom steps', (i) => zoomSteps(close, VP, frame, -Math.abs((i % 40) - 20)));

  // Bounded: the canvas, the chunk rasters, the overview.
  assert.ok(r.cached <= MAP_RASTER_CACHE, `cache ${r.cached}`);
  assert.ok(r.stats.rasters <= DETAIL_SLOTS * 4, `rasters ${r.stats.rasters}`);
  const overview = images.filter((i) => i.w > S || i.h > S).at(-1)!;
  assert.ok(overview.w <= OVERVIEW_MAX_PX && overview.h <= OVERVIEW_MAX_PX, `overview ${overview.w}×${overview.h}`);
  assert.equal(r.stats.overviews, 1, 'one overview for all the dragging and zooming');
  const bytes = backingSize(VP, 2);
  // Interaction frames (JS work only; the browser's own raster time isn't in a unit test).
  for (const m of [drag, over, zoom]) assert.ok(m.p95 < 16, `${m.name}: ${JSON.stringify(m)}`);
  const report = {
    chunks: chunks.length,
    setInputMs: +setInputMs.toFixed(2),
    firstOverviewMs: +firstOverviewMs.toFixed(2),
    canvasBytes: bytes.w * bytes.h * 4,
    cachedRasters: r.cached,
    rastersBuilt: r.stats.rasters,
    overview: `${overview.w}×${overview.h}`,
    frames: [drag, over, zoom],
  };
  console.log(`map perf ${JSON.stringify(report)}`);
});
