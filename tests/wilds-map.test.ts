import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN } from '../src/lib/tile.ts';
import { MAP_COLOURS, fitLabels, mapBounds, mapEdges, mapFrame, mapPicture, type MapInput } from '../src/lib/wilds/map-model.ts';
import { mapChunkKeys } from '../src/game/wilds/map-data.ts';
import { WALKED_MAX, forgetWalked, markSeen, markWalked, seenAt, seenLandmarks, walkedChunks } from '../src/game/wilds/walked.ts';
import { displayArea, setWildsLand, areaInfo } from '../src/content/world.ts';

const WINDOW = { minCx: -6, minCy: -8, maxCx: 4, maxCy: 7 };
const S = 24;

/** A chunk of one ground, a solid tree at local (1, 1), laid stone at (2, 2). */
function chunk(cx: number, cy: number, ground: number) {
  const g = Array.from({ length: S }, () => Array.from({ length: S }, () => ground));
  const solid = Array.from({ length: S }, () => Array.from({ length: S }, () => false));
  solid[1]![1] = true;
  g[2]![2] = TERRAIN.stone_a;
  return { cx, cy, ground: g, solid };
}

function input(o: Partial<MapInput> = {}): MapInput {
  return { window: WINDOW, chunks: [], glimpse: [], ways: [], places: [], hero: null, words: { you: 'You', gate: 'Commons gate' }, ...o };
}

const pixel = (p: { width: number; rgba: Uint8ClampedArray; originTx: number; originTy: number }, tx: number, ty: number) => {
  const i = ((ty - p.originTy) * p.width + (tx - p.originTx)) * 4;
  return [p.rgba[i], p.rgba[i + 1], p.rgba[i + 2], p.rgba[i + 3]];
};

test('the map frames what you know with a chunk round it, growing to the window round you and its glimpse', () => {
  // The window already contains all town and lot chunks.
  assert.deepEqual(mapBounds(input()), WINDOW);
  const glimpse = [{ cx: -5, cy: -4, land: 'meadow', river: true }, { cx: 0, cy: -9, land: 'woods', river: false }];
  assert.deepEqual(mapBounds(input({ glimpse })), { minCx: -6, minCy: -9, maxCx: 4, maxCy: 7 });
  // Fresh: all four footprints plus a chunk around them.
  assert.deepEqual(mapFrame(input({ glimpse })), { minCx: -3, minCy: -6, maxCx: 3, maxCy: 5 });
  // Walked out west: the frame reaches the glimpse beside it.
  const west = input({ glimpse, chunks: [chunk(-4, -4, TERRAIN.grass_c)], hero: { tx: -4 * S + 5, ty: -4 * S + 5 } });
  assert.deepEqual(mapFrame(west), { minCx: -5, minCy: -6, maxCx: 3, maxCy: 5 });
  const p = mapPicture(west);
  assert.equal(p.width, 9 * S);
  assert.equal(p.height, 12 * S);
  assert.deepEqual([p.originTx, p.originTy], [-5 * S, -6 * S]);
  // The glimpse: a pale wash, see-through; and hatching where the Wend runs.
  const wash = pixel(p, -5 * S + 3, -4 * S + 4);
  assert.ok(wash[3]! > 0 && wash[3]! < 255);
  let hatched = 0;
  for (let i = 0; i < S; i++) if (pixel(p, -5 * S + i, -4 * S + 5).slice(0, 3).join() === MAP_COLOURS.river.join()) hatched++;
  assert.ok(hatched > 0, 'the river’s hatching');
  // The window's land with no glimpse is parchment.
  assert.deepEqual(pixel(p, -5 * S + 1, -6 * S + 1).slice(0, 3), [...MAP_COLOURS.parchment]);
  // Everything walked: the whole window and its glimpse.
  const everywhere = input({ glimpse, chunks: [chunk(-6, 2, TERRAIN.grass_b), chunk(4, -8, TERRAIN.grass_b), chunk(1, 7, TERRAIN.grass_b)] });
  assert.deepEqual(mapFrame(everywhere), mapBounds(everywhere));
});

test('walked far out and home again, the map still reaches what you know past the window round you', () => {
  // Home-centred window; walked east to chunk 100, a place seen and a way out there.
  const home = { minCx: -32, minCy: -32, maxCx: 32, maxCy: 32 };
  const back = input({
    window: home,
    chunks: [chunk(0, 0, TERRAIN.grass_c), chunk(100, 0, TERRAIN.grass_c)],
    places: [{ id: 'place:40:-1', kind: 'glade', tx: 110 * S + 3, ty: -2 * S, seen: true, foundBy: null }],
    ways: [{ id: 'way', name: 'Way', a: 'x', b: 'y', path: [{ x: 50 * S, y: 40 * S }] }],
    hero: { tx: 5, ty: 5 }
  });
  const b = mapBounds(back);
  assert.equal(b.maxCx, 110, 'the seen place');
  assert.equal(b.maxCy, 40, 'the way');
  const f = mapFrame(back);
  assert.ok(f.maxCx >= 100, `the frame reaches the walked chunk (maxCx ${f.maxCx})`);
  assert.ok(f.maxCx >= 110 && f.maxCy >= 40, 'and the place and way past it');
  // Never past the world border.
  const edge = input({ window: home, chunks: [chunk(4096, 0, TERRAIN.grass_c), chunk(4097, 0, TERRAIN.grass_c)] });
  assert.equal(mapBounds(edge).maxCx, 4096);
  assert.equal(mapFrame(edge).maxCx, 4096);
});

test('walked chunks are drawn in their ground’s colours; the rest of the window is parchment, and the border is edged in the drift’s dashes', () => {
  const p = mapPicture(input({ chunks: [chunk(1, -6, TERRAIN.grass_c), chunk(-1, -6, TERRAIN.water_a), chunk(3, -8, TERRAIN.grass_b)] }));
  const meadow = pixel(p, S + 5, -6 * S + 5);
  const tree = pixel(p, S + 1, -6 * S + 1);
  const laid = pixel(p, S + 2, -6 * S + 2);
  const water = pixel(p, -S + 5, -6 * S + 5);
  const blank = pixel(p, 2 * S + 5, -3 * S + 5);
  assert.notDeepEqual(meadow, blank);
  assert.deepEqual(blank.slice(0, 3), [...MAP_COLOURS.parchment], 'unwalked land is blank parchment');
  assert.ok(tree[0]! < meadow[0]! && tree[1]! < meadow[1]!, 'trees and stone are darker than the open ground');
  assert.ok(laid[0]! > 200 && laid[1]! > 200, 'laid stone shows pale');
  assert.ok(water[2]! > water[0]!, 'the Wend is blue');
  // No border in the window: no dashes. Where the window reaches the border, its edge.
  assert.deepEqual(mapEdges(WINDOW), []);
  const B = 4096;
  assert.deepEqual(mapEdges({ minCx: B - 2, minCy: -1, maxCx: B, maxCy: 0 }), [
    { x0: (B + 1) * S, y0: -S, x1: (B + 1) * S, y1: 0 },
    { x0: (B + 1) * S, y0: 0, x1: (B + 1) * S, y1: S },
  ]);
});

test('labels that would overlap at the size shown are left off, the most useful kept', () => {
  const labels = [
    { kind: 'gate' as const, text: 'Commons gate', x: 50, y: 62 },
    { kind: 'place' as const, text: 'A camp glade', x: 52, y: 50, sub: 'Tansy' },
    { kind: 'you' as const, text: 'You', x: 51, y: 56 },
    { kind: 'way' as const, text: "Tansy's way", x: 120, y: 50 },
  ];
  assert.deepEqual(fitLabels(labels, 1).map((l) => l.kind).sort(), ['way', 'you']);
  assert.deepEqual(fitLabels(labels, 7).map((l) => l.kind).sort(), ['gate', 'place', 'way', 'you'], 'zoomed in, all of them fit');
});

test('ways, places, the footprints, the gate and you are marked and labelled', () => {
  const p = mapPicture(
    input({
      ways: [{ id: 'way:a:b', name: "Tansy's way", a: 'place:0:-2', b: 'place:1:-1', path: [{ x: 10, y: -60 }, { x: 10, y: -59 }, { x: 10, y: -58 }] }],
      places: [
        { id: 'place:1:-1', kind: 'camp-glade', tx: 40, ty: -100, seen: true, foundBy: 'Tansy' },
        { id: 'place:-1:-1', kind: 'outcrop', tx: -40, ty: -100, seen: true, foundBy: null },
        { id: 'place:1:-2', kind: 'ruin', tx: 40, ty: -150, seen: false, foundBy: null },
      ],
      hero: { tx: 2, ty: -10 },
    }),
  );
  assert.deepEqual(pixel(p, 10, -59).slice(0, 3), [...MAP_COLOURS.way]);
  assert.deepEqual(pixel(p, 40, -100).slice(0, 3), [...MAP_COLOURS.found], 'a found place in the finder’s colour');
  assert.deepEqual(pixel(p, -40, -100).slice(0, 3), [...MAP_COLOURS.landmark], 'a seen landmark');
  assert.deepEqual(pixel(p, 2, -10).slice(0, 3), [...MAP_COLOURS.you]);
  const by = (kind: string) => p.labels.filter((l) => l.kind === kind);
  assert.deepEqual(by('way').map((l) => [l.text, l.x, l.y]), [["Tansy's way", 10 - p.originTx, -59 - p.originTy]]);
  assert.deepEqual(by('place').map((l) => [l.text, l.sub ?? null]), [['A camp glade', 'Tansy'], ['An outcrop', null]], 'a place not seen nor found stays off the map');
  assert.deepEqual(by('footprint').map((l) => l.text), ['The Tangle', 'The Whitequiet', 'Hearthwick', 'West Row', 'East Row', ...Array.from({ length: 8 }, (_, g) => `${g % 2 ? 'East' : 'West'} Row ${Math.floor(g / 2) + 1}`)]);
  assert.deepEqual(by('gate').map((l) => l.text), ['Commons gate']);
  assert.deepEqual(by('you').map((l) => l.text), ['You']);
  // Labels sit inside the picture.
  for (const l of p.labels) assert.ok(l.x >= 0 && l.y >= 0 && l.x < p.width && l.y < p.height, `${l.kind} ${l.text}`);
});

test('the map shows the chunks walked this wick and always the Tangle', () => {
  const keys = mapChunkKeys(['3,-7', '0,-1']);
  assert.ok(keys.includes('3,-7'));
  for (let cy = -2; cy <= 0; cy++) for (let cx = -1; cx <= 1; cx++) assert.ok(keys.includes(`${cx},${cy}`));
  assert.equal(keys.length, 10);
});

test('walked and seen are kept per wick, with where each landmark stands', () => {
  forgetWalked();
  markWalked('wick-a', '1,-6');
  markWalked('wick-a', '1,-6');
  markSeen('wick-a', 'place:1:-2');
  markSeen('wick-a', 'place:1:-2', { tx: 30, ty: -140 });
  markSeen('wick-b', 'place:0:-3', { tx: 3, ty: -190 });
  assert.deepEqual(walkedChunks('wick-a'), ['1,-6']);
  assert.deepEqual(seenLandmarks('wick-a'), ['place:1:-2']);
  assert.deepEqual(seenAt('wick-a'), { 'place:1:-2': [30, -140] });
  assert.deepEqual(seenLandmarks('wick-b'), ['place:0:-3']);
  assert.deepEqual(walkedChunks('wick-b'), []);
});

test('the HUD names the meadow and the Wend past the Whitequiet, from the land the scene has loaded', () => {
  const at = (tx: number, ty: number) => displayArea({ area: 'outdoors', position: { x: tx * 16 + 8, y: ty * 16 + 8 } });
  setWildsLand((tx) => (tx < -60 ? 'wend' : tx > 60 ? 'meadow' : null));
  try {
    assert.equal(at(12, -60), 'whitequiet', 'the footprints come first');
    assert.equal(at(12, -150), 'beyond');
    assert.equal(at(-70, -100), 'wend');
    assert.equal(at(70, -100), 'meadow');
    assert.equal(areaInfo('wend').name, 'The Wend');
    assert.equal(areaInfo('meadow').name, 'The meadow');
    assert.equal(areaInfo('beyond').name, 'The Wilds');
  } finally {
    setWildsLand(null);
  }
  assert.equal(at(70, -100), 'beyond', 'with nothing loaded, the woods');
});

test('a label wholly off screen (yours too) never pushes out one that shows', () => {
  const you = { kind: 'you' as const, text: 'You', x: -30, y: 10 };
  const place = { kind: 'place' as const, text: 'Visible place', x: 20, y: 37 };
  // Without the viewport, your label wins the overlap left of the screen.
  assert.deepEqual(fitLabels([you, place], 1).map((l) => l.kind), ['you']);
  // With it, yours is culled first and the place, partly on screen, shows.
  assert.deepEqual(fitLabels([you, place], 1, { w: 100, h: 100 }).map((l) => l.kind), ['place']);
  // A label partly on screen still counts.
  const edge = { kind: 'way' as const, text: 'A way on the edge', x: 2, y: 60 };
  assert.deepEqual(fitLabels([edge], 1, { w: 100, h: 100 }).map((l) => l.kind), ['way']);
});

test('a wick keeps the most recent WALKED_MAX chunks walked', () => {
  forgetWalked();
  for (let i = 0; i < WALKED_MAX + 10; i++) markWalked('wick-long', `${i}:0`);
  const walked = walkedChunks('wick-long');
  assert.equal(walked.length, WALKED_MAX);
  assert.equal(walked[0], '10:0');
  assert.equal(walked.at(-1), `${WALKED_MAX + 9}:0`);
  forgetWalked();
});
