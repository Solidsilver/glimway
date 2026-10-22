import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AREA_OPTIONS, routeLegs } from '../src/game/height-lab/area.ts';
import { cutBands, cutBandsSteps, paintPart, paintPartSteps, type BandPixels } from '../src/game/height-lab/slopes-paint.ts';
import { KIND, N, ROWS_PER_LEVEL, SURFACE, TILE_PX, findPath, fits, move, standTile, step, zAt, type Node, type Walker } from '../src/game/height-lab/levels.ts';
import {
  GULLY,
  MAX_LEVEL,
  MAX_WALK_SLOPE,
  OUTCROP,
  PASS_X,
  Q,
  SPIRE,
  buildField,
  buildSlopes,
  coastRow,
  fieldEdges,
  groundKind,
  liftColumn,
  MAX_WALK_Q,
  display,
  nearestWalkable,
  steepest,
  reach,
  regionOf,
  styleLook,
  walkableKind
} from '../src/game/height-lab/slopes.ts';

/**
 * The slopes round's area (src/game/height-lab/slopes.ts): its field, the
 * collision map every style walks, and the lifted view the ¾ lift draws.
 */

const field = buildField();
const flat = buildSlopes(DEFAULT_AREA_OPTIONS, styleLook('shade'));
const lifted = buildSlopes(DEFAULT_AREA_OPTIONS, styleLook('lift'));
const { w, h } = field;
const spot = (name: string) => flat.slopes!.spots.find((s) => s.name === name)!;
const node = (area: typeof flat, name: string): Node => nearestWalkable(area.stack, spot(name).tx, spot(name).ty);

test('heights are 1/256 level, run 0–15, and are continuous but across authored cliffs', () => {
  let max = 0;
  for (const z of field.corner) {
    assert.equal(Math.round(z * Q), z * Q, `${z} is at 1/256`);
    assert.ok(z >= 0 && z <= MAX_LEVEL, `${z} in 0–15`);
    max = Math.max(max, z);
  }
  assert.ok(max >= 14, `tall: ${max}`);
  // Neighbours share corners, unless they are different authored pieces (a cliff on purpose).
  let breaks = 0;
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++) {
      const i = ty * w + tx;
      for (const [dx, dy, a, b, c, d] of [[1, 0, 1, 0, 2, 3], [0, 1, 3, 0, 2, 1]] as const) {
        const x = tx + dx;
        const y = ty + dy;
        if (x >= w || y >= h) continue;
        const j = y * w + x;
        // Shared corners: east neighbour's nw = my ne, sw = my se; south neighbour's nw = my sw, ne = my se.
        const same = field.corner[i * 4 + a] === field.corner[j * 4 + b] && field.corner[i * 4 + c] === field.corner[j * 4 + d];
        if (same) continue;
        breaks++;
        // The plateau patch is pieces by level.
        const piece = (px: number, py: number) => (regionOf(px, py) === 'plateau' ? `plateau-${field.corner[(py * w + px) * 4]}` : regionOf(px, py));
        assert.notEqual(piece(tx, ty), piece(x, y), `a break inside one piece at ${tx},${ty} → ${x},${y}`);
      }
    }
  assert.ok(breaks > 100, 'there are cliffs');
});

test('the walking limit: a tile walks only if the bilinear gradient at all four corners is within it (integers, no roots)', () => {
  assert.equal(MAX_WALK_SLOPE, 0.25);
  assert.equal(MAX_WALK_Q, 64);
  let steep = 0;
  let crag = 0;
  const q = (z: number) => Math.round(z * Q);
  for (let i = 0; i < w * h; i++) {
    const k = field.kind[i]!;
    const [nw, ne, se, sw] = [0, 1, 2, 3].map((c) => q(field.corner[i * 4 + c]!)) as [number, number, number, number];
    // At each corner, its own row and column of the patch: gx² + gy² ≤ 64².
    const corners = [[ne - nw, sw - nw], [ne - nw, se - ne], [se - sw, se - ne], [se - sw, sw - nw]];
    const ok = corners.every(([gx, gy]) => gx! * gx! + gy! * gy! <= 64 * 64);
    assert.equal(steepest(field.corner, i * 4) <= 64 * 64, ok);
    if (walkableKind(k)) assert.ok(ok, `tile ${i % w},${Math.floor(i / w)} walkable with a corner past the limit`);
    if (!ok) assert.ok(k === KIND.steep || k === KIND.crag || regionOf(i % w, Math.floor(i / w)) !== 'land', `tile ${i % w},${Math.floor(i / w)} past the limit is ${k}`);
    if (k === KIND.steep) steep++;
    if (k === KIND.crag) crag++;
  }
  // The review's examples: walkable by the centre's gradient, past the limit at a corner.
  for (const [x, y] of [[106, 6], [84, 28]] as const) assert.ok(!walkableKind(field.kind[y * w + x]!), `${x},${y} is past the limit at a corner`);
  assert.ok(steep > 1000 && crag > 100, `steep ${steep}, crag ${crag}`);
  const l = flat.stack.layers[SURFACE]!;
  for (let i = 0; i < w * h; i++) if (l.kind[i] === KIND.steep || l.kind[i] === KIND.crag) for (let d = 0; d < 4; d++) assert.ok(Number.isNaN(l.edge[i * 4 + d]!));
  assert.equal(groundKind(KIND.flat), 'slope');
  assert.equal(groundKind(KIND.slope), 'slope');
  assert.equal(groundKind(KIND.steep), 'steep');
  assert.equal(groundKind(KIND.crag), 'crag');
  assert.equal(groundKind(KIND.face), 'cliff');
});

test('the rolling hills are walkable anywhere: no cliffs, nothing too steep', () => {
  for (let ty = 70; ty <= 96; ty++)
    for (let tx = 4; tx <= 50; tx++) {
      const i = ty * w + tx;
      assert.ok(walkableKind(field.kind[i]!) || field.kind[i] === KIND.prop, `hills tile ${tx},${ty} kind ${field.kind[i]}`);
    }
  const path = findPath(flat.stack, node(flat, 'spawn'), node(flat, 'hills'), 200000);
  assert.ok(path, 'spawn to the hills');
});

test('every style walks the same collision map (the lift only draws)', () => {
  const a = flat.stack.layers[SURFACE]!;
  const b = lifted.stack.layers[SURFACE]!;
  assert.equal(b.w, a.w);
  assert.equal(b.h, a.h);
  assert.deepEqual([...b.kind], [...a.kind]);
  for (let i = 0; i < a.edge.length; i++) assert.ok(Object.is(a.edge[i], b.edge[i]) || a.edge[i] === b.edge[i], `edge ${i}`);
  assert.deepEqual(lifted.spawn, flat.spawn);
  assert.ok(lifted.slopes!.view.h > lifted.stack.h, 'the lift draws a taller view');
});

for (const [name, area] of [['flat', flat], ['lifted', lifted]] as const) {
  test(`${name} map: the pass is walkable end to end, through the saddle`, () => {
    const path = findPath(area.stack, node(area, 'pass-foot'), node(area, 'pass-north'), 400000);
    assert.ok(path, 'over the pass');
    // It crosses the ridge near the pass's column, not round the range's end.
    for (const n of path!) {
      const f = n;
      if (f.ty > 22 && f.ty < 40) assert.ok(Math.abs(f.tx - PASS_X) < 12, `crossing at ${f.tx},${f.ty}`);
    }
    // The way round the east end reaches the far side too (the long way).
    assert.ok(findPath(area.stack, node(area, 'spawn'), node(area, 'around-east'), 400000), 'round the east end');
  });

  test(`${name} map: the spire is unreachable`, () => {
    const from = reach(area.stack, area.spawn);
    const l = area.stack.layers[SURFACE]!;
    let top = 0;
    for (let i = 0; i < l.w * l.h; i++) {
      const j = flat.slopes!.source[i]!;
      if (j < 0) continue;
      const tx = j % w;
      const ty = Math.floor(j / w);
      if (Math.hypot(tx + 0.5 - SPIRE.x, ty + 0.5 - SPIRE.y) > SPIRE.r) continue;
      if (!walkableKind(l.kind[i]!)) continue;
      top++;
      assert.equal(from[i], 0, `spire top ${tx},${ty} reached`);
    }
    assert.ok(top > 0, 'its top is ground you could stand on');
  });

  test(`${name} map: the sea cliff has one way down, the gully`, () => {
    const l = area.stack.layers[SURFACE]!;
    const isSea = (i: number) => {
      const j = flat.slopes!.source[i]!;
      return j >= 0 && regionOf(j % w, Math.floor(j / w)) === 'sea';
    };
    let ways = 0;
    for (let i = 0; i < l.w * l.h; i++) {
      if (isSea(i)) continue;
      const tx = i % l.w;
      const ty = Math.floor(i / l.w);
      if (ty + 1 >= l.h || !isSea(i + l.w)) continue;
      if (step(area.stack, SURFACE, tx, ty, 2) < 0) continue;
      ways++;
      assert.ok(tx >= GULLY.x0 && tx <= GULLY.x1, `down to the sea at column ${tx}`);
    }
    assert.ok(ways > 0, 'the gully reaches the sea');
    assert.ok(findPath(area.stack, node(area, 'spawn'), node(area, 'sea'), 400000), 'spawn to the sand flats');
  });
}

test('the too-steep band stops you walking straight up the range', () => {
  const s = node(flat, 'steep-band');
  const wk: Walker = { x: s.tx * TILE_PX + 8, y: s.ty * TILE_PX + 12, layer: SURFACE, hw: 5, fh: 4 };
  move(flat.stack, wk, 0, -60 * TILE_PX);
  const ty = Math.floor(wk.y / TILE_PX);
  const above = field.kind[(ty - 1) * w + s.tx]!;
  assert.ok(ty > 30, `stopped south of the ridge (row ${ty})`);
  assert.ok(above === KIND.steep || above === KIND.crag || above === KIND.prop, `by steep ground (kind ${above})`);
});

test('the outcrop: up its gentle side, a cliff on the other with faces by the local rule', () => {
  const up = findPath(flat.stack, node(flat, 'outcrop-slope'), node(flat, 'outcrop-top'), 100000);
  assert.ok(up, 'onto the outcrop from the north');
  const zs = up!.map((n) => flat.slopes!.z[n.ty * w + n.tx]!);
  assert.ok(zs.at(-1)! > zs[0]! + 2, `climbs ${zs[0]} → ${zs.at(-1)}`);
  // From below the cliff, north is shut.
  const below = node(flat, 'outcrop-cliff');
  const l = flat.stack.layers[SURFACE]!;
  const x = 103;
  const hi = fieldEdges(field, OUTCROP.y1 * w + x)[2];
  const lo = fieldEdges(field, (OUTCROP.y1 + 1) * w + x)[0];
  const rows = Math.round((hi - lo) * ROWS_PER_LEVEL);
  assert.ok(rows >= 8, `a tall face (${rows} rows)`);
  for (let r = 1; r <= rows; r++) {
    const i = (OUTCROP.y1 + r) * w + x;
    assert.equal(l.kind[i], KIND.face, `row ${OUTCROP.y1 + r}`);
    assert.equal(l.faceRows[i], rows);
    assert.equal(l.faceRow[i], r - 1);
  }
  assert.equal(l.kind[(OUTCROP.y1 + rows + 1) * w + x] === KIND.face, false, 'and no more');
  assert.equal(step(flat.stack, SURFACE, x, OUTCROP.y1 + rows + 1, N), -1, 'shut from below');
  assert.ok(below.ty > OUTCROP.y1 + rows);
});

test('every south drop makes ROWS_PER_LEVEL rows of face a level (flat map)', () => {
  const l = flat.stack.layers[SURFACE]!;
  let faces = 0;
  for (let tx = 0; tx < w; tx++)
    for (let ty = 0; ty < h - 1; ty++) {
      const hi = fieldEdges(field, ty * w + tx)[2];
      const lo = fieldEdges(field, (ty + 1) * w + tx)[0];
      if (hi - lo <= 0.05) continue;
      faces++;
      const i = (ty + 1) * w + tx;
      assert.equal(l.kind[i], KIND.face, `face below ${tx},${ty}`);
      assert.equal(l.faceRows[i], Math.max(1, Math.round((hi - lo) * ROWS_PER_LEVEL)));
    }
  assert.ok(faces > 150, `${faces} cliff columns`);
});

test('the lifted map: a cliff opens into 3 rows of face a level, ground rises north 3 rows a level', () => {
  const pad = lifted.slopes!.pad;
  // The outcrop's face, in its column.
  const col = liftColumn(field, 103, 0.5, pad, ROWS_PER_LEVEL);
  const face = col.find((s) => s.face && s.ty === OUTCROP.y1)!;
  assert.ok(face, 'the outcrop face shows');
  assert.ok(Math.abs(face.s1 - face.s0 - (face.zS - face.zBot) * ROWS_PER_LEVEL) < 0.05, 'its rows: 3 a level');
  // The sea at the bottom, unmoved; the ridge lifted far up.
  const sea = col.find((s) => !s.face && s.ty === h - 1)!;
  assert.equal(sea.sS, h + pad);
  // Every view tile showing field ground shows that tile's kind.
  const v = lifted.slopes!.view;
  for (let i = 0; i < v.w * v.h; i++) {
    const j = lifted.slopes!.source[i]!;
    if (j >= 0) assert.equal(v.kind[i], lifted.slopes!.field.kind[j]);
  }
});

test('Wren’s loop over the pass walks in both maps', () => {
  for (const area of [flat, lifted]) routeLegs(area).forEach((leg, i) => assert.ok(leg, `leg ${i}`));
});

test('the gully and the sea line are where the notes say', () => {
  for (let tx = 0; tx < w; tx++) assert.equal(regionOf(tx, coastRow(tx) + 1), 'sea');
  assert.equal(regionOf(GULLY.x0, GULLY.y0 + 2), 'gully');
  assert.ok(zAt(flat.stack, { x: spot('spawn').tx * TILE_PX + 8, y: spot('spawn').ty * TILE_PX + 12, layer: SURFACE, hw: 5, fh: 4 }) < 2, 'spawn is low');
});

// ---------------------------------------------------------------- the review's findings 1 and 2

const T = TILE_PX;
const heroAt = (tx: number, ty: number): Walker => ({ x: tx * T + 8, y: ty * T + 12, layer: SURFACE, hw: 5, fh: 4 });

/** Walk a path tile by tile with real moves (as the remote player does), stopping if stuck. True when it gets to the end. */
function walkPath(stack: typeof flat.stack, wk: Walker, path: Node[]): boolean {
  for (const n of path.slice(1)) {
    const gx = n.tx * T + 8;
    const gy = n.ty * T + 10;
    for (let i = 0; ; i++) {
      const vx = gx - wk.x;
      const vy = gy - wk.y;
      const d = Math.hypot(vx, vy);
      if (d < 1.5) break;
      if (i > 80) return false;
      const s = Math.min(d, 2);
      move(stack, wk, (vx / d) * s, (vy / d) * s);
    }
  }
  return true;
}

/** A style switch, as the scene does it: the same field px in the other style's area (every style walks the field). */
function switchStyle(wk: Walker): Walker {
  return { ...wk };
}

test('finding 1: field (5,14), reached in shading, then switched to the lift: still there, can leave, walks back to spawn', () => {
  const at = heroAt(5, 14);
  assert.ok(findPath(flat.stack, flat.spawn, { layer: SURFACE, tx: 5, ty: 14 }, 400000), 'reached in shading');
  const wk = switchStyle(at);
  assert.deepEqual(standTile(wk), [5, 14], 'the switch never moves the hero');
  // It can leave its tile with real moves.
  let left = 0;
  for (const [dx, dy] of [[16, 0], [-16, 0], [0, 16], [0, -16]] as const) {
    const w2 = { ...wk };
    move(lifted.stack, w2, dx, dy);
    if (standTile(w2)[0] !== 5 || standTile(w2)[1] !== 14) left++;
  }
  assert.ok(left >= 1, 'a way out of its tile');
  const back = findPath(lifted.stack, { layer: SURFACE, tx: 5, ty: 14 }, lifted.spawn, 400000);
  assert.ok(back, 'a route back to spawn in the lift');
  assert.ok(walkPath(lifted.stack, wk, back!), 'walked back with real moves');
  assert.deepEqual(standTile(wk), [lifted.spawn.tx, lifted.spawn.ty]);
});

test('finding 1: what the lift draws at view (58,54) is ground nobody can stand on; the nearest standing ground, switched to shading, walks back to spawn', () => {
  const v = lifted.slopes!.view;
  const j = lifted.slopes!.source[54 * v.w + 58]!;
  assert.ok(j >= 0, 'field ground is drawn there');
  const fx = j % w;
  const fy = Math.floor(j / w);
  assert.ok(!walkableKind(flat.stack.layers[SURFACE]!.kind[j]!), `field (${fx},${fy}) under it is closed, in every style`);
  // The hero walks the field in the lift too, so the nearest place they could be is reachable ground.
  const home = reach(lifted.stack, lifted.spawn);
  let best: [number, number] | null = null;
  for (let r = 1; r < 20 && !best; r++)
    for (let y = fy - r; y <= fy + r && !best; y++)
      for (let x = fx - r; x <= fx + r && !best; x++) if (x >= 0 && y >= 0 && x < w && y < h && home[y * w + x]) best = [x, y];
  assert.ok(best, 'standing ground near it');
  const wk = switchStyle(heroAt(best![0], best![1]));
  assert.deepEqual(standTile(wk), best);
  const back = findPath(flat.stack, { layer: SURFACE, tx: best![0], ty: best![1] }, flat.spawn, 400000);
  assert.ok(back, 'a route back to spawn in shading');
  assert.ok(walkPath(flat.stack, wk, back!), 'walked back with real moves');
});

test('finding 2: in the lift, the ground drawn where the hero is drawn is the ground they stand on (inside tiles, every 4 px)', () => {
  const info = lifted.slopes!;
  const home = reach(lifted.stack, lifted.spawn);
  let checked = 0;
  let hidden = 0;
  // The range's south side, the pass and the crags under the east peaks: where the old lift let you onto crag.
  for (let ty = 20; ty < 70; ty++)
    for (let tx = 56; tx < 112; tx++) {
      if (!home[ty * w + tx]) continue;
      for (let oy = 2; oy < T; oy += 4)
        for (let ox = 1; ox < T; ox += 4) {
          const wk: Walker = { x: tx * T + ox, y: ty * T + oy + 2, layer: SURFACE, hw: 5, fh: 4 };
          if (fits(lifted.stack, wk, wk.x, wk.y) < 0) continue;
          const z = zAt(lifted.stack, wk);
          assert.ok(!Number.isNaN(z));
          const d = display(info, wk.x, wk.y - wk.fh / 2, z);
          checked++;
          if (d.hidden) {
            hidden++;
            continue;
          }
          // Drawn: the lifted column there shows ground within HIDE_ABOVE of theirs, and that ground is walkable field.
          const col = liftColumn(field, Math.floor(wk.x / T), wk.x / T - Math.floor(wk.x / T), info.pad, info.k);
          const sp = col.find((c) => d.y / T - 0.02 >= c.s0 && d.y / T - 0.02 < c.s1)!;
          assert.ok(sp && !sp.face, `ground drawn at ${wk.x},${wk.y}`);
          const zs = sp.zN + (sp.zS - sp.zN) * Math.max(0, Math.min(1, (d.y / T - 0.02 - sp.sN) / (sp.sS - sp.sN)));
          assert.ok(Math.abs(zs - z) < 0.3, `at ${wk.x},${wk.y}: stands at ${z.toFixed(2)}, drawn on ${zs.toFixed(2)}`);
          assert.ok(walkableKind(field.kind[sp.ty * w + Math.floor(wk.x / T)]!) || field.kind[sp.ty * w + Math.floor(wk.x / T)] === KIND.prop || Math.abs(sp.ty - Math.floor((wk.y - 2) / T)) <= 1, `drawn on field row ${sp.ty}`);
        }
    }
  assert.ok(checked > 5000, `${checked} positions`);
  assert.ok(hidden / checked < 0.05, `hidden at ${hidden} of ${checked}`);
});

test('finding 2: moves along tile boundaries never step onto steep, crag or cliff ground, in any style', () => {
  const home = reach(flat.stack, flat.spawn);
  const closed = (k: number) => k === KIND.steep || k === KIND.crag || k === KIND.face || k === KIND.prop;
  let moves = 0;
  for (const area of [flat, lifted]) {
    const l = area.stack.layers[SURFACE]!;
    for (let ty = 20; ty < 120; ty += 3)
      for (let tx = 4; tx < 140; tx += 3) {
        if (!home[ty * w + tx]) continue;
        // On the tile's west and north boundaries (and a hair either side), walking each way.
        for (const [x, y] of [[tx * T + 5, ty * T + 9], [tx * T + 11, ty * T + 9], [tx * T + 8, ty * T + 4], [tx * T + 8, ty * T + 16]] as const)
          for (const [dx, dy] of [[0, -40], [0, 40], [-40, 0], [40, 0]] as const) {
            const wk: Walker = { x, y, layer: SURFACE, hw: 5, fh: 4 };
            if (fits(area.stack, wk, x, y) < 0) continue;
            move(area.stack, wk, dx, dy);
            moves++;
            // Every tile under the foot box is open ground.
            for (const [px, py] of [[wk.x - wk.hw, wk.y - wk.fh], [wk.x + wk.hw - 0.01, wk.y - wk.fh], [wk.x - wk.hw, wk.y - 0.01], [wk.x + wk.hw - 0.01, wk.y - 0.01]] as const) {
              const k = l.kind[Math.floor(py / T) * w + Math.floor(px / T)]!;
              assert.ok(!closed(k), `foot on kind ${k} at ${px.toFixed(1)},${py.toFixed(1)} after moving ${dx},${dy} from ${x},${y}`);
            }
          }
      }
  }
  assert.ok(moves > 2000, `${moves} moves`);
});

// ---------------------------------------------------------------- finding 4: painting in steps

test('finding 4: a chunk paints in small steps that add up to painting it in one go', () => {
  for (const area of [flat, lifted]) {
    const part = { x0: 48, y0: 24, x1: 71, y1: 47 };
    const whole = paintPart(area, part);
    const it = paintPartSteps(area, part);
    const times: number[] = [];
    let r: IteratorResult<void, { px: Uint8ClampedArray; z: Float32Array }>;
    for (let t0 = performance.now(); !(r = it.next()).done; t0 = performance.now()) times.push(performance.now() - t0);
    assert.ok(times.length >= 12, `${times.length} steps`);
    assert.deepEqual(r.value.px, whole.px);
    const bands = cutBands(part, whole.px, whole.z);
    const stepped: BandPixels[] = [];
    const cut = cutBandsSteps(part, whole.px, whole.z);
    let c: IteratorResult<void, BandPixels[]>;
    while (!(c = cut.next()).done);
    stepped.push(...c.value);
    assert.deepEqual(stepped.map((b) => [b.band, b.x, b.y, b.w, b.h]), bands.map((b) => [b.band, b.x, b.y, b.w, b.h]));
    const sorted = [...times].sort((a, b) => a - b);
    console.log(`${area.slopes!.look.lift ? "lift" : "flat"}: ${times.length} steps, median ${sorted[sorted.length >> 1]!.toFixed(1)} ms, max ${sorted.at(-1)!.toFixed(1)} ms`);
  }
});
