import './helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { toBinary } from '@bufbuild/protobuf';

const { TERRAIN } = await import('../src/lib/tile.ts');
const { fnv1a32 } = await import('../src/lib/hash.ts');
const { decodeChunk } = await import('../src/lib/api/chunks.ts');
const { WorldChunkSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
const { paintGround, paintOf } = await import('../src/game/wilds/ground-paint.ts');
const { groundTable, paintTable } = await import('../src/game/wilds/ground-table.ts');
const { wildsLook } = await import('../src/game/wilds/wilds-looks.ts');
const { terrainOf } = await import('../src/game/wilds/terrain.ts');
const { FIXED_GROUNDS, fixedChunkHash, fixedPaintAt, fixedPaintGrid, fixedPaintId, fixedStyle, isFixedPaintId } = await import('../src/game/wilds/fixed-ground.ts');
const { applyLotHome, fixedPlaceOf, fixedSolidAt, footprint } = await import('../src/game/wilds/fixed.ts');
const { serveFixtureCommons } = await import('./commons-fixture.ts');
const { chunkAt } = await import('./wilds-fixture.ts');
const { lotOrigin } = await import('../src/lib/lots.ts');

type Source = import('../src/game/wilds/ground-paint.ts').GroundSource;

const S = 24;
const PX = S * 16;
const SEED = fnv1a32('world-seed');
const town = serveFixtureCommons();
const lots = footprint('homestead-lots')!;

/**
 * The town's fixture footprint with generated land east of it (the
 * generator's own Whitequiet woods at cx 2), read the way the window's
 * paint source reads the open map.
 */
function townAndWilds(): Source {
  const wild = new Map([1, 2, 3].map((cy) => [cy, terrainOf(decodeChunk(toBinary(WorldChunkSchema, chunkAt('whitequiet-0-4', 2, cy))))]));
  const generated = (tx: number, ty: number) => {
    const cx = Math.floor(tx / S);
    const cy = Math.floor(ty / S);
    const c = cx === 2 ? wild.get(cy) : undefined;
    return c ? { c, lx: tx - cx * S, ly: ty - cy * S } : null;
  };
  const fixed = (tx: number, ty: number) => fixedPlaceOf(Math.floor(tx / S), Math.floor(ty / S)) !== null;
  return {
    ground: (tx, ty) => {
      if (fixed(tx, ty)) return fixedPaintAt(tx, ty);
      const a = generated(tx, ty);
      return a ? a.c.ground[a.ly]![a.lx]! : null;
    },
    solid: (tx, ty) => {
      if (fixed(tx, ty)) return fixedSolidAt(tx, ty);
      const a = generated(tx, ty);
      return !a || a.c.solid[a.ly]![a.lx]!;
    },
  };
}

function paint(x0: number, y0: number, w: number, h: number, src: Source, mark = 'Carting'): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  paintGround(out, x0, y0, w, h, src, wildsLook('outer', mark).ground, SEED, paintTable());
  return out;
}

const px = (img: Uint8ClampedArray, x0: number, y0: number, w: number, wx: number, wy: number) => {
  const i = ((wy - y0) * w + (wx - x0)) * 4;
  return [img[i], img[i + 1], img[i + 2], img[i + 3]];
};

test('every fixed style paints every curated terrain, under ids of its own', () => {
  const generated = new Set(groundTable().map((r) => r[0]));
  const ids = new Set<number>();
  for (const style of Object.keys(FIXED_GROUNDS) as (keyof typeof FIXED_GROUNDS)[])
    for (const id of Object.values(TERRAIN)) {
      const p = fixedPaintId(style, id);
      assert.ok(isFixedPaintId(p), `${style} ${id}`);
      assert.ok(!generated.has(p), 'never a generated TERRAIN id');
      assert.ok(!ids.has(p), 'one id per style and terrain');
      ids.add(p);
      assert.ok(paintTable().some((r) => r[0] === p), `${style} ${id} has a row`);
    }
  const cat = (style: keyof typeof FIXED_GROUNDS, name: keyof typeof TERRAIN) => paintOf(paintTable(), fixedPaintId(style, TERRAIN[name])).cat;
  assert.equal(cat('town', 'grass_a'), 'meadow', 'the town’s grass is the Wilds’ meadow');
  assert.equal(cat('town', 'cobble'), 'cobble');
  assert.equal(cat('town', 'path_a'), 'trodden');
  assert.equal(cat('town', 'tilled'), 'tilled');
  assert.equal(cat('lot-west', 'grass_a'), 'moss', 'west lots: the Tangle’s moss');
  assert.equal(cat('lot-west', 'grass_b'), 'woods');
  assert.equal(cat('lot-east', 'grass_a'), 'meadow', 'east lots: meadow-bright');
  assert.equal(cat('lot-west', 'dirt'), 'trodden', 'the cleared site');
  // The same TERRAIN id still reads as the Wilds’ own ground on generated land.
  assert.equal(paintOf(paintTable(), TERRAIN.grass_a).cat, 'moss');
});

test('a fixed chunk paints by its place: the town as the town, lots by their side', () => {
  assert.equal(fixedStyle(town.place, 0, 2), 'town');
  for (let g = 0; g < 8; g++) {
    const o = lotOrigin(g);
    assert.equal(fixedStyle(lots.place, o.tx / S, o.ty / S), g % 2 ? 'lot-east' : 'lot-west', `lot ${g}`);
  }
  assert.equal(fixedPaintAt(0, 48), fixedPaintId('town', town.ground[48 - town.ty]![0 - town.tx]!));
});

test('ground lines up across the town’s edge into the generated Wilds, pixel for pixel', () => {
  const src = townAndWilds();
  const margin = 40;
  // Town chunk (1, 2) painted 40 px into the generated chunk east of it.
  const x0 = PX;
  const y0 = 2 * PX;
  const a = paint(x0, y0, PX + margin, PX, src);
  const east = paint(2 * PX, y0, PX, PX, src);
  for (let wy = y0; wy < y0 + PX; wy++) for (let wx = 2 * PX; wx < 2 * PX + margin; wx++) assert.deepEqual(px(a, x0, y0, PX + margin, wx, wy), px(east, 2 * PX, y0, PX, wx, wy), `world pixel ${wx},${wy}`);
  const own = paint(x0, y0, PX, PX, src);
  for (let wy = y0; wy < y0 + PX; wy++) assert.deepEqual(px(own, x0, y0, PX, 2 * PX - 1, wy), px(a, x0, y0, PX + margin, 2 * PX - 1, wy), 'painting further changes nothing already painted');
});

test('the white quiet’s drifts lie on the Wilds, not on the town', () => {
  const src = townAndWilds();
  const quiet = wildsLook('outer', 'Quiet').ground;
  const paintWith = (G: typeof quiet, cx: number) => {
    const out = new Uint8ClampedArray(PX * PX * 4);
    paintGround(out, cx * PX, 2 * PX, PX, PX, src, G, SEED, paintTable());
    return out;
  };
  // The middle of the square: no drift anywhere.
  assert.deepEqual(paintWith(quiet, 0), paintWith({ ...quiet, mist: null }, 0));
  // The generated woods beside the town: drifts lie there.
  assert.notDeepEqual(paintWith(quiet, 2), paintWith({ ...quiet, mist: null }, 2));
});

test('town grounds look their own: cobbles, tilled furrows and a worn verge', () => {
  const G = wildsLook('outer', 'Carting').ground;
  const flat = (name: keyof typeof TERRAIN): Source => ({ ground: () => fixedPaintId('town', TERRAIN[name]), solid: () => false });
  const mean = (img: Uint8ClampedArray) => {
    let s = 0;
    for (let i = 0; i < img.length; i += 4) s += img[i]! + img[i + 1]! + img[i + 2]!;
    return s / (img.length / 4);
  };
  const out = (src: Source) => {
    const o = new Uint8ClampedArray(64 * 64 * 4);
    paintGround(o, 0, 0, 64, 64, src, G, SEED, paintTable());
    return o;
  };
  const meadow = out(flat('grass_a'));
  const cobble = out(flat('cobble'));
  const tilled = out(flat('tilled'));
  assert.notDeepEqual(cobble, meadow);
  assert.notDeepEqual(tilled, meadow);
  assert.notDeepEqual(tilled, cobble);
  // Furrows run east–west: rows differ far more than columns.
  const rowMeans = Array.from({ length: 64 }, (_, y) => mean(tilled.subarray(y * 64 * 4, (y + 1) * 64 * 4)));
  const spread = Math.max(...rowMeans) - Math.min(...rowMeans);
  assert.ok(spread > 40, `furrow rows differ (${spread.toFixed(1)})`);
  // Grass beside a cobbled lane wears to earth along its edge, not tile by tile.
  const lane: Source = { ground: (tx) => fixedPaintId('town', tx < 2 ? TERRAIN.cobble : TERRAIN.grass_a), solid: () => false };
  const verge = out(lane);
  const columnIsEarth = (x: number) => {
    let n = 0;
    for (let y = 0; y < 64; y++) {
      const i = (y * 64 + x) * 4;
      const c: [number, number, number] = [verge[i]!, verge[i + 1]!, verge[i + 2]!];
      if (G.trodden.some((t) => t[0] === c[0] && t[1] === c[1] && t[2] === c[2])) n++;
    }
    return n;
  };
  assert.ok(columnIsEarth(33) > 4, 'earth just past the cobbles');
  assert.equal(columnIsEarth(60), 0, 'none a tile and more away');
});

test('a lot’s cleared tiles paint as feathered trodden earth, and repaint its chunk', () => {
  const g = 2;
  const o = lotOrigin(g);
  const before = footprint('homestead-lots')!;
  const hash = fixedChunkHash(before, o.tx / S, o.ty / S);
  const home = { worldId: before.epoch.slice('plot:'.length, before.epoch.lastIndexOf('@')), cleared: [[6, 6]], stumps: [], plants: [], desolate: false };
  applyLotHome(g, home as never);
  const after = footprint('homestead-lots')!;
  const at = (fp: typeof after) => fixedPaintGrid(fp)[(o.ty + 6 - fp.ty) * fp.w + (o.tx + 6 - fp.tx)];
  assert.equal(at(after), fixedPaintId(fixedStyle(after.place, o.tx / S, o.ty / S), TERRAIN.dirt));
  assert.notEqual(fixedChunkHash(after, o.tx / S, o.ty / S), hash, 'the chunk repaints');
  applyLotHome(g, null);
  assert.equal(fixedChunkHash(footprint('homestead-lots')!, o.tx / S, o.ty / S), hash, 'back as it was');
});
