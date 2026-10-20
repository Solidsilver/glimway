/**
 * The world map's renderer (docs/design/world-map.md 4): bounded canvas and
 * caches, rasters only for detailed chunks in view or on new input, nothing
 * read while panning, summaries that never show unwalked land, and labels
 * fitted to what's on screen. The last test is the plan's performance
 * fixture: a sparse map of thousands of chunks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  return { window: { minCx: -4, minCy: -8, maxCx: 4, maxCy: 0 }, chunks: [], glimpse: [], ways: [], places: [], hero: null, words: { you: 'You', gate: 'Commons gate' }, ...o };
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
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() { calls.strokeRect++; },
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

test('chunks past the border are never drawn; a summary shows only walked land', () => {
  const r = new MapRenderer(make);
  images.length = 0;
  const walked = [chunk(-1, -2, TERRAIN.water_a), chunk(2, -6)];
  r.setInput(input({ chunks: [...walked, chunk(4097, -2)], glimpse: [{ cx: 5, cy: -3, land: 'meadow', river: false }] }), 'w:a');
  const frame = r.frame()!;
  // Far out: the overview.
  const { ctx } = recorder();
  const view = { ...showAll(VP, frame), scale: 0.2 };
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
  r.setInput(input({ chunks: [...walked, chunk(3, -6)] }), 'w:a');
  r.draw(recorder().ctx, view, VP, 1);
  assert.equal(r.stats.overviews, before + 1);
  assert.equal(r.stats.summaries, 3, 'chunk summaries are kept while their ground holds: only the new one is made');
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
      window: { minCx: -4, minCy: -90, maxCx: 4, maxCy: 0 },
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
  const big = input({ window: frontier, chunks, ways, places });

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
  if (process.env.MAP_PERF === '1') {
    const budget = Number(process.env.MAP_RENDER_P95_BUDGET_MS) || 16;
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/map-render-performance.json', JSON.stringify({ budgetP95Ms: budget, report }, null, 2));
    for (const m of [drag, over, zoom]) assert.ok(m.p95 < budget, `${m.name}: ${JSON.stringify(m)}; budget=${budget} ms`);
  }
  console.log(`map perf ${JSON.stringify(report)}`);
});

/**
 * Every pixel of land the renderer paints, in canvas pixels: chunk rasters,
 * the overview's opaque pixels, and flat chunk colours. Parchment, the grid,
 * the frontier and the marks aren't land.
 */
function landPainter() {
  const notLand = new Set([MAP_COLOURS.parchment, MAP_COLOURS.grid, MAP_COLOURS.way, MAP_COLOURS.found, MAP_COLOURS.landmark].map((c) => `rgb(${c[0]},${c[1]},${c[2]})`));
  const paints: { x: number; y: number; w: number; h: number }[] = [];
  let fill = '';
  const ctx = {
    setTransform() {},
    clearRect() {},
    strokeRect() {},
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect(x: number, y: number, w: number, h: number) {
      if (fill.startsWith('rgb(') && !notLand.has(fill)) paints.push({ x, y, w, h });
    },
    drawImage(img: { rgba: Uint8ClampedArray; w: number; h: number }, ...a: number[]) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 4 ? [0, 0, img.w, img.h, ...a] : a;
      for (let py = sy!; py < sy! + sh!; py++)
        for (let px = sx!; px < sx! + sw!; px++) {
          if (img.rgba[(py * img.w + px) * 4 + 3] !== 255) continue;
          paints.push({ x: dx! + ((px - sx!) * dw!) / sw!, y: dy! + ((py - sy!) * dh!) / sh!, w: dw! / sw!, h: dh! / sh! });
        }
    },
    set fillStyle(v: string) {
      fill = v;
    },
    get fillStyle() {
      return fill;
    },
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    imageSmoothingEnabled: false,
  };
  return { ctx: ctx as never, paints };
}

/** Assert every land paint lies inside a walked chunk on screen (a pixel's slack for rounding). */
function onlyWalked(paints: { x: number; y: number; w: number; h: number }[], walked: MapChunk[], v: { cx: number; cy: number; scale: number }, label: string): void {
  const ox = Math.round(VP.w / 2 - v.scale * v.cx);
  const oy = Math.round(VP.h / 2 - v.scale * v.cy);
  const rects = walked.map((c) => ({ x0: Math.round(ox + c.cx * S * v.scale), y0: Math.round(oy + c.cy * S * v.scale), x1: Math.round(ox + (c.cx + 1) * S * v.scale), y1: Math.round(oy + (c.cy + 1) * S * v.scale) }));
  for (const p of paints) {
    const ok = rects.some((r) => p.x >= r.x0 - 1 && p.y >= r.y0 - 1 && p.x + p.w <= r.x1 + 1 && p.y + p.h <= r.y1 + 1);
    assert.ok(ok, `${label}: land painted at ${JSON.stringify(p)}, outside every walked chunk`);
  }
}

test('the overview never paints unwalked chunks as land: a sparse map wider than 1024 chunks, at middle zooms', () => {
  const frontier = { minCx: -4, minCy: -8, maxCx: 2100, maxCy: 0 };
  const walked = [chunk(1, -1, TERRAIN.grass_c, 'a'), chunk(2049, -1, TERRAIN.grass_c, 'b')];
  const r = new MapRenderer(make);
  r.setInput(input({ window: frontier, chunks: walked }), 'w:wide');
  const frame = r.frame()!;
  assert.ok(frame.maxTx - frame.minTx + 1 > 1024 * S, 'the frame is wider than 1024 chunks');
  const levels = new Set<string>();
  for (const scale of [0.04, 0.1, 0.2, 0.24, 0.25, 0.5, 1, 2, 4]) {
    const v = centreOn(S + 12, -12, scale, VP, frame);
    const { ctx, paints } = landPainter();
    levels.add(r.draw(ctx, { ...v, scale }, VP, 1).level);
    assert.ok(paints.length > 0, `land drawn at ${scale}`);
    onlyWalked(paints, walked, { ...v, scale }, `scale ${scale}`);
  }
  assert.ok(levels.has('detail') && levels.has('chunks'), [...levels].join());
});

test('a dense checkerboard of walked chunks in a wide frame: each drawn at its own size, its unwalked neighbours never filled', () => {
  const frontier = { minCx: -4, minCy: -60, maxCx: 2100, maxCy: 0 };
  const walked: MapChunk[] = [];
  for (let cy = -40; cy < 0; cy++) for (let cx = 0; cx < 60; cx++) if ((cx + cy) % 2 === 0) walked.push(chunk(cx, cy, TERRAIN.grass_b, `${cx},${cy}`));
  walked.push(chunk(2049, -1, TERRAIN.grass_c, 'far'));
  const r = new MapRenderer(make);
  r.setInput(input({ window: frontier, chunks: walked }), 'w:dense');
  const frame = r.frame()!;
  const levels = new Set<string>();
  for (const scale of [0.05, 0.2, 0.5, 1]) {
    const v = { cx: 30 * S, cy: -20 * S, scale };
    const { ctx, paints } = landPainter();
    levels.add(r.draw(ctx, v, VP, 1).level);
    onlyWalked(paints, walked, v, `scale ${scale}`);
  }
  assert.ok(levels.has('chunks'), [...levels].join());
  void frame;
});

test('the renderer culls label boxes to the viewport before fitting, yours included', () => {
  const r = new MapRenderer(make);
  r.setInput(input({ places: [{ id: 'a', kind: 'camp-glade', tx: 10, ty: -40, seen: true, foundBy: null }] }), 'w:a');
  const small = { w: 100, h: 100 };
  // You just off the left edge, the place just on screen beside where your label would be.
  const v = { cx: 10.5 + (50 - 20) / 4, cy: -40.5 + (50 - 37) / 4, scale: 4 };
  const at = (sx: number, sy: number) => ({ x: v.cx + (sx - 50) / 4, y: v.cy + (sy - 50) / 4 });
  const shown = r.labels(v, small, { ...at(-30, 10), text: 'You' });
  assert.ok(shown.some((l) => l.kind === 'place'), JSON.stringify(shown));
  assert.equal(shown.some((l) => l.kind === 'you'), false);
});

// Tier layers are independent of terrain and must never extend knowledge.
test('Built shading and dimming hatches stay inside explored chunks; Common has only a dashed extent', async () => {
  const { create } = await import('@bufbuild/protobuf');
  const { ChunkLandStatusSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
  const land = (cx: number, tier: string, dimming = false) => create(ChunkLandStatusSchema, { chunk: { realm: 'wilds', cx, cy: -2 }, tier, dimming, nextTurning: dimming ? 'turns' : tier === 'built' ? 'held' : '' });
  const r = new MapRenderer(make);
  r.setInput(input({ chunks: [chunk(-1,-2),chunk(0,-2)], land: [land(-1,'built',true),land(0,'common'),land(1,'built',true)] }), 'tiers');
  const rec = recorder();
  const ctx = rec.ctx as unknown as import('../src/ui/map-renderer.ts').MapCtx;
  const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
  const dashes: number[][] = [];
  const lines: [number,number][] = [];
  ctx.fillRect = (x,y,w,h) => { fills.push({ style: String(ctx.fillStyle),x,y,w,h }); };
  ctx.setLineDash = (dash) => { dashes.push([...dash]); };
  ctx.moveTo = (x,y) => { if (ctx.strokeStyle === '#9d6325') lines.push([x,y]); };
  ctx.lineTo = (x,y) => { if (ctx.strokeStyle === '#9d6325') lines.push([x,y]); };
  const v={cx:0,cy:-36,scale:4};const vp={w:384,h:240};
  r.draw(ctx,v,vp,1);
  const held = fills.filter((f) => f.style === 'rgba(229,171,72,0.22)');
  assert.equal(held.length,1,'no shading on Common or unknown land');
  assert.deepEqual(held[0],{ style: 'rgba(229,171,72,0.22)',x:96,y:72,w:96,h:96 });
  assert.ok(dashes.some((d) => d[0]===3 && d[1]===4),'Common uses a dashed boundary');
  assert.ok(lines.length>2,'Dimming is hatched');
  assert.ok(lines.every(([x,y]) => x>=96 && x<=192 && y>=72 && y<=168),'hatching never leaves the known chunk');
  fills.length=0;
  r.draw(ctx,v,vp,1,false);
  assert.equal(fills.filter((f) => f.style === 'rgba(229,171,72,0.22)').length,0,'the Lamps toggle hides the layer');
});
