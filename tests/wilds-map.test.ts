import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN } from '../src/lib/tile.ts';
import { MAP_COLOURS, fitLabels, mapBounds, mapFrame, mapPicture, type MapInput } from '../src/lib/wilds/map-model.ts';
import { mapChunkKeys } from '../src/game/wilds/map-data.ts';
import { forgetWalked, markSeen, markWalked, seenAt, seenLandmarks, walkedChunks } from '../src/game/wilds/walked.ts';
import { displayArea, setWildsLand, areaInfo } from '../src/content/world.ts';

const FRONTIER = { minCx: -4, minCy: -8, maxCx: 4, maxCy: 0 };
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
  return { frontier: FRONTIER, chunks: [], glimpse: [], ways: [], places: [], hero: null, words: { you: 'You', gate: 'Commons gate' }, ...o };
}

const pixel = (p: { width: number; rgba: Uint8ClampedArray; originTx: number; originTy: number }, tx: number, ty: number) => {
  const i = ((ty - p.originTy) * p.width + (tx - p.originTx)) * 4;
  return [p.rgba[i], p.rgba[i + 1], p.rgba[i + 2], p.rgba[i + 3]];
};

test('the map frames what you know with a chunk round it, growing to the frontier and the glimpse past it', () => {
  // The frontier and the Commons (fixed, cx -1..1, cy 1..2) south of the gate.
  assert.deepEqual(mapBounds({ frontier: FRONTIER, glimpse: [] }), { ...FRONTIER, maxCy: 2 });
  const glimpse = [{ cx: -5, cy: -4, land: 'meadow', river: true }, { cx: 0, cy: -9, land: 'woods', river: false }];
  assert.deepEqual(mapBounds({ frontier: FRONTIER, glimpse }), { minCx: -5, minCy: -9, maxCx: 4, maxCy: 2 });
  // Fresh: the Tangle, the Whitequiet and the Commons (cx -1..1, cy -5..2) and a chunk round them, never south of the Commons.
  assert.deepEqual(mapFrame(input({ glimpse })), { minCx: -2, minCy: -6, maxCx: 2, maxCy: 2 });
  // Walked out to the west edge: the frame reaches the glimpse past it.
  const west = input({ glimpse, chunks: [chunk(-4, -4, TERRAIN.grass_c)], hero: { tx: -4 * S + 5, ty: -4 * S + 5 } });
  assert.deepEqual(mapFrame(west), { minCx: -5, minCy: -6, maxCx: 2, maxCy: 2 });
  const p = mapPicture(west);
  assert.equal(p.width, 8 * S);
  assert.equal(p.height, 9 * S);
  assert.deepEqual([p.originTx, p.originTy], [-5 * S, -6 * S]);
  // Past the drift: a pale wash, see-through; and hatching where the Wend runs on.
  const wash = pixel(p, -5 * S + 3, -4 * S + 4);
  assert.ok(wash[3]! > 0 && wash[3]! < 255);
  let hatched = 0;
  for (let i = 0; i < S; i++) if (pixel(p, -5 * S + i, -4 * S + 5).slice(0, 3).join() === MAP_COLOURS.river.join()) hatched++;
  assert.ok(hatched > 0, 'the river’s hatching');
  // Nothing at all where neither the frontier nor a glimpse reaches.
  assert.equal(pixel(p, -5 * S + 1, -6 * S + 1)[3], 0);
  // Everything walked: the whole frontier and its glimpse.
  const everywhere = input({ glimpse, chunks: [chunk(-4, -8, TERRAIN.grass_b), chunk(4, 0, TERRAIN.grass_b)] });
  assert.deepEqual(mapFrame(everywhere), mapBounds(everywhere));
});

test('walked chunks are drawn in their ground’s colours; the rest of the frontier is parchment, edged in the drift’s dashes', () => {
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
  // The frontier's edge, dashed.
  const top = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => pixel(p, S + x, -8 * S).slice(0, 3).join());
  assert.ok(top.includes(MAP_COLOURS.drift.join()) && top.some((c) => c !== MAP_COLOURS.drift.join()));
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
  assert.deepEqual(by('footprint').map((l) => l.text), ['The Tangle', 'The Whitequiet', 'The Commons']);
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
