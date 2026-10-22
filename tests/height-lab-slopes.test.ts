import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AREA_OPTIONS, routeLegs } from '../src/game/height-lab/area.ts';
import { KIND, N, ROWS_PER_LEVEL, SURFACE, TILE_PX, findPath, move, step, zAt, type Node, type Walker } from '../src/game/height-lab/levels.ts';
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
  mapNode,
  reach,
  regionOf,
  toField,
  walkableKind
} from '../src/game/height-lab/slopes.ts';

/** The slopes round's area (src/game/height-lab/slopes.ts): its field, and the flat and lifted maps built from it. */

const field = buildField();
const flat = buildSlopes(DEFAULT_AREA_OPTIONS, { style: 'shade', shade: true });
const lifted = buildSlopes(DEFAULT_AREA_OPTIONS, { style: 'lift', shade: true });
const { w, h } = field;
const spot = (name: string) => flat.slopes!.spots.find((s) => s.name === name)!;
const node = (area: typeof flat, name: string): Node => mapNode(area.slopes!, area.stack, spot(name).tx, spot(name).ty);

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

test('the walking limit: walkable ground is never steeper, steeper ground is steep or crag, and closed', () => {
  assert.equal(MAX_WALK_SLOPE, 0.25);
  let steep = 0;
  let crag = 0;
  for (let i = 0; i < w * h; i++) {
    const k = field.kind[i]!;
    if (walkableKind(k)) assert.ok(field.slope[i]! <= MAX_WALK_SLOPE + 1e-6, `tile ${i} walkable at ${field.slope[i]}`);
    if (k === KIND.steep) {
      steep++;
      assert.ok(field.slope[i]! > MAX_WALK_SLOPE);
    }
    if (k === KIND.crag) crag++;
  }
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

for (const [name, area] of [['flat', flat], ['lifted', lifted]] as const) {
  test(`${name} map: the pass is walkable end to end, through the saddle`, () => {
    const path = findPath(area.stack, node(area, 'pass-foot'), node(area, 'pass-north'), 400000);
    assert.ok(path, 'over the pass');
    // It crosses the ridge near the pass's column, not round the range's end.
    for (const n of path!) {
      const f = toField(area.slopes!, n.tx, n.ty);
      if (f && f.ty > 22 && f.ty < 40) assert.ok(Math.abs(f.tx - PASS_X) < 12, `crossing at ${f.tx},${f.ty}`);
    }
    // The way round the east end reaches the far side too (the long way).
    assert.ok(findPath(area.stack, node(area, 'spawn'), node(area, 'around-east'), 400000), 'round the east end');
  });

  test(`${name} map: the spire is unreachable`, () => {
    const from = reach(area.stack, area.spawn);
    const l = area.stack.layers[SURFACE]!;
    let top = 0;
    for (let i = 0; i < l.w * l.h; i++) {
      const j = area.slopes!.source[i]!;
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
      const j = area.slopes!.source[i]!;
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
  const col = liftColumn(field, 103, 0.5, pad);
  const face = col.find((s) => s.face && s.ty === OUTCROP.y1)!;
  assert.ok(face, 'the outcrop face shows');
  assert.ok(Math.abs(face.s1 - face.s0 - (face.zS - face.zBot) * ROWS_PER_LEVEL) < 0.05, 'its rows: 3 a level');
  // The sea at the bottom, unmoved; the ridge lifted far up.
  const sea = col.find((s) => !s.face && s.ty === h - 1)!;
  assert.equal(sea.sS, h + pad);
  // Every walkable map tile shows walkable field ground.
  const l = lifted.stack.layers[SURFACE]!;
  for (let i = 0; i < l.w * l.h; i++) if (walkableKind(l.kind[i]!)) assert.ok(walkableKind(field.kind[lifted.slopes!.source[i]!]!));
});

test('Wren’s loop over the pass walks in both maps', () => {
  for (const area of [flat, lifted]) routeLegs(area).forEach((leg, i) => assert.ok(leg, `leg ${i}`));
});

test('the gully and the sea line are where the notes say', () => {
  for (let tx = 0; tx < w; tx++) assert.equal(regionOf(tx, coastRow(tx) + 1), 'sea');
  assert.equal(regionOf(GULLY.x0, GULLY.y0 + 2), 'gully');
  assert.ok(zAt(flat.stack, { x: spot('spawn').tx * TILE_PX + 8, y: spot('spawn').ty * TILE_PX + 12, layer: SURFACE, hw: 5, fh: 4 }) < 2, 'spawn is low');
});
