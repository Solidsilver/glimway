import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN } from '../src/lib/tile.ts';
import { loadWilds, wildsGround } from '../src/lib/wilds/data.ts';
import { insideFrontier } from '../src/lib/wilds/coords.ts';
import { walkFactor } from '../src/lib/wilds/walk.ts';
import { CHUNK_PX, chunkKey, chunkOfPixel, gateArrival, gateArrivalPosition, gateTiles, parseChunkKey, worldTile } from '../src/game/wilds/coords.ts';
import { crossed, frontierDistance, keepAttached, nearestOpen, paintable, planWindow, SLACK_TILES, veilEdges } from '../src/game/wilds/window-plan.ts';
import { chunkGather, chunkLandmarks, chunkScenery, effectiveTerrain, LANDMARK_KINDS } from '../src/game/wilds/terrain.ts';
import { OPEN_MAP_DECOR_KINDS, openMapDecor } from '../src/game/wilds/open-map-art.ts';
import { DECOR_ART } from '../src/game/wilds/decor.ts';
import { forgetWalked, markSeen, markWalked, seenLandmarks, walkedChunks } from '../src/game/wilds/walked.ts';
import { chunkAt, fixtureTerrain } from './wilds-fixture.ts';
import { terrainOf } from '../src/game/wilds/terrain.ts';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import { toBinary } from '@bufbuild/protobuf';
import { WildsChunkSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js';

// ---------------------------------------------------------------- coordinates

test('world pixels: signed, floor-divided into chunks of 384 px', () => {
  assert.equal(CHUNK_PX, 384);
  assert.deepEqual(chunkOfPixel(0, 0), { cx: 0, cy: 0 });
  assert.deepEqual(chunkOfPixel(383.9, 383.9), { cx: 0, cy: 0 });
  assert.deepEqual(chunkOfPixel(-0.5, -0.5), { cx: -1, cy: -1 });
  assert.deepEqual(chunkOfPixel(-384, -385), { cx: -1, cy: -2 });
  assert.deepEqual(worldTile(-1, -2, 3, 4), { tx: -21, ty: -44 });
  assert.equal(chunkKey(-3, 7), '-3,7');
  assert.deepEqual(parseChunkKey(chunkKey(-3, -7)), { cx: -3, cy: -7 });
});

test('the Commons gate: three tiles on chunk (0, 0)’s south edge, and you arrive one in from its middle', () => {
  assert.deepEqual(gateTiles(), { tx: 1, ty: 23, tw: 3, th: 1 });
  assert.deepEqual(gateArrival(), { tx: 2, ty: 22 });
  assert.deepEqual(gateArrivalPosition(), { x: 40, y: 360 });
  assert.deepEqual(chunkOfPixel(gateArrivalPosition().x, gateArrivalPosition().y), { cx: 0, cy: 0 });
});

// ---------------------------------------------------------------- the window

const inside = (cx: number, cy: number) => insideFrontier(cx, cy);

test('the window: the 3×3 attached, the 5×5 fetched, the ring for landmarks', () => {
  const p = planWindow(0, -4, inside);
  assert.equal(p.attach.length, 9);
  assert.equal(p.fetch.length, 25);
  assert.equal(p.ring.length, 16);
  assert.deepEqual(p.drift, []);
  assert.ok(p.attach.includes('0,-4') && p.attach.includes('-1,-5') && p.attach.includes('1,-3'));
  assert.ok(!p.attach.includes('2,-4') && p.ring.includes('2,-4'));
  for (const k of p.attach) assert.ok(p.fetch.includes(k));
});

test('at the frontier the window’s far side is the drift: never fetched, never attached', () => {
  // The north-west corner of the 0.8 frontier (cx -4..4, cy -8..0).
  const corner = planWindow(-4, -8, inside);
  assert.equal(corner.attach.length, 4);
  assert.equal(corner.drift.length, 5);
  assert.equal(corner.fetch.length, 9);
  assert.ok(corner.drift.includes('-5,-9') && corner.drift.includes('-3,-9') && corner.drift.includes('-5,-7'));
  // The gate's chunk: the village lies south (cy 1 is outside the frontier).
  const gate = planWindow(0, 0, inside);
  assert.deepEqual(gate.drift.sort(), ['-1,1', '0,1', '1,1']);
  assert.equal(gate.attach.length, 6);
});

test('a chunk is painted once every neighbour inside the frontier is known', () => {
  const known = new Set(['0,-4', '1,-4', '-1,-4', '0,-5', '0,-3', '1,-5', '-1,-5', '1,-3'])
  const has = (cx: number, cy: number) => known.has(chunkKey(cx, cy));
  assert.equal(paintable(0, -4, inside, has), false, 'one neighbour missing');
  known.add('-1,-3');
  assert.equal(paintable(0, -4, inside, has), true);
  // Past the frontier counts as known (it reads as the drift).
  const edge = new Set(['-4,-8', '-3,-8', '-4,-7', '-3,-7']);
  assert.equal(paintable(-4, -8, inside, (cx, cy) => edge.has(chunkKey(cx, cy))), true);
  assert.equal(paintable(5, 5, inside, () => false), false, 'not known itself');
});

test('crossing a chunk edge recentres the window; walking inside one does not', () => {
  assert.equal(crossed(null, { cx: 0, cy: 0 }), true);
  assert.equal(crossed({ cx: 0, cy: 0 }, { cx: 0, cy: 0 }), false);
  assert.equal(crossed({ cx: 0, cy: 0 }, { cx: 0, cy: -1 }), true);
});

test('slack at the edge: a chunk that left the 3×3 stays until the hero is SLACK_TILES past the edge', () => {
  // The hero walked from chunk (0, 0) east into (1, 0); chunk (-1, 0) left the 3×3.
  const westOf = (k: number) => keepAttached(-1, 0, 24 + k, 12, SLACK_TILES);
  assert.equal(westOf(0), true, 'just over the edge: kept');
  assert.equal(westOf(SLACK_TILES - 1), true, 'still within the slack');
  assert.equal(westOf(SLACK_TILES), false, 'past it: it goes');
  // Every chunk of the 3×3 is always kept, wherever in the centre chunk the hero stands.
  for (const [tx, ty] of [[0, 0], [23, 23], [0, 23], [12, 12]] as const)
    for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++) assert.equal(keepAttached(cx, cy, tx, ty, 0), true, `${cx},${cy} from ${tx},${ty}`);
  // Two chunks away is never kept without slack, and the diagonal counts by its nearer side.
  assert.equal(keepAttached(2, 0, 23, 12, 0), false);
  assert.equal(keepAttached(-1, -1, 24 + 2, -3, SLACK_TILES), true, 'just past a corner, both ways within the slack');
  assert.equal(keepAttached(-1, -1, 24 + 2, 24 + SLACK_TILES, SLACK_TILES), false);
  // Signed tiles: two rows south of the frontier's north row (cy -8), the same.
  assert.equal(keepAttached(0, -8, 5, -6 * 24 + 3, SLACK_TILES), true);
  assert.equal(keepAttached(0, -8, 5, -6 * 24 + SLACK_TILES, SLACK_TILES), false);
});

test('the turning moves you to the nearest open tile, never home', () => {
  const open = new Set(['5,5', '9,9', '6,3']);
  const isOpen = (x: number, y: number) => open.has(`${x},${y}`);
  assert.deepEqual(nearestOpen(5, 5, isOpen), { tx: 5, ty: 5 }, 'already open: stay');
  open.delete('5,5');
  assert.deepEqual(nearestOpen(5, 5, isOpen), { tx: 6, ty: 3 }, 'the nearest one, by distance');
  assert.equal(nearestOpen(5, 5, () => false, 4), null, 'nothing within reach');
  // Signed tiles are no different.
  assert.deepEqual(nearestOpen(-30, -100, (x, y) => x === -31 && y === -100), { tx: -31, ty: -100 });
});

test('the drift: distance past the frontier, and which edges carry the veil', () => {
  const f = { minCx: -4, minCy: -8, maxCx: 4, maxCy: 0 };
  assert.equal(frontierDistance(f, 0, 0), 0);
  assert.equal(frontierDistance(f, -4 * 384 - 10, 0), 10);
  assert.equal(frontierDistance(f, 0, -8 * 384 - 50), 50);
  assert.deepEqual(veilEdges(0, -9, inside), ['south'], 'north of the frontier: the veil on its south edge');
  assert.deepEqual(veilEdges(5, -4, inside), ['west']);
  assert.deepEqual(veilEdges(5, -9, inside), [], 'a corner sees no inside chunk across an edge');
});

// ---------------------------------------------------------------- walking

test('walk speed by ground: laid stone and plank 15% faster, a ford half speed', () => {
  const t = (id: string) => (TERRAIN as Record<string, number>)[wildsGround(id).terrain]!;
  assert.equal(walkFactor(t('laid-stone')), 1.15);
  assert.equal(walkFactor(t('laid-plank')), 1.15);
  assert.equal(walkFactor(t('ford')), 0.5);
  assert.equal(walkFactor(t('moss')), 1);
  assert.equal(walkFactor(t('paving')), 1);
  assert.equal(walkFactor(null), 1, 'nothing known: as usual');
});

test('ground changes on top of a chunk: cleared opens a tile and takes its standing piece; laid carries its ground', () => {
  const t = fixtureTerrain('tangle');
  const thicket = t.decor.find((d) => DECOR_ART[d.kind].blocking && t.solid[d.ty]![d.tx])!;
  const open = (() => {
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if (!t.solid[y]![x]) return { x, y };
    throw new Error('no open tile');
  })();
  const e = effectiveTerrain(t, [
    { tx: thicket.tx, ty: thicket.ty, change: 'cleared' },
    { tx: open.x, ty: open.y, change: 'stone' },
    { tx: 99, ty: 0, change: 'plank' },
  ]);
  assert.equal(e.solid[thicket.ty]![thicket.tx], false);
  assert.ok(!e.decor.some((d) => d.tx === thicket.tx && d.ty === thicket.ty && DECOR_ART[d.kind].blocking), 'the piece is gone');
  assert.equal(e.ground[open.y]![open.x], (TERRAIN as Record<string, number>)[wildsGround('laid-stone').terrain]);
  assert.equal(t.solid[thicket.ty]![thicket.tx], true, 'the chunk itself is never changed');
  assert.equal(effectiveTerrain(t, []), t, 'no changes: the chunk as served');
});

// ---------------------------------------------------------------- what is drawn

test('every decor kind is drawn: woods kinds by the code painter, the open map’s by its delivered art', () => {
  for (const d of loadWilds().decor) {
    const art = openMapDecor(d.kind as never, 0);
    if (OPEN_MAP_DECOR_KINDS.includes(d.kind as never)) assert.match(art ?? '', /^om-art:/, d.kind);
    else assert.equal(art, null, `${d.kind} is code-drawn`);
  }
  for (const k of LANDMARK_KINDS) assert.ok(OPEN_MAP_DECOR_KINDS.includes(k), `landmark ${k} has art`);
  assert.deepEqual([...LANDMARK_KINDS].sort(), ['meadow-oak', 'meadow-outcrop', 'split-oak', 'standing-stone']);
  assert.equal(openMapDecor('meadow-grass', 4), 'om-art:meadow-grass-1');
  assert.equal(openMapDecor('split-oak', 3), 'om-art:landmark-split-oak');
});

test('a chunk’s scenery and pieces stand at world tiles; landmarks are drawn from a chunk away with their place', () => {
  const m = chunkAt('whitequiet-0-4', -2, -5);
  m.decor!.kinds.push('split-oak');
  m.decor!.kind.push(m.decor!.kinds.length - 1);
  m.decor!.tx.push(10);
  m.decor!.ty.push(11);
  m.decor!.ox.push(0);
  m.decor!.oy.push(0);
  m.decor!.variant.push(0);
  if (m.decor!.flags.length < Math.ceil(m.decor!.kind.length / 4)) m.decor!.flags = Uint8Array.from([...m.decor!.flags, 0]);
  m.places = [{ $typeName: 'glimway.v1.WildsPlaceMark', id: 'place:-1:-1', kind: 'camp-glade', tx: 10, ty: 11 }];
  const t = terrainOf(decodeChunk(toBinary(WildsChunkSchema, m)));
  const scenery = chunkScenery(t, () => true);
  assert.equal(scenery.length, t.decor.length);
  for (const s of scenery) assert.ok(s.tx! >= -48 && s.tx! < -24 && s.ty! >= -120 && s.ty! < -96, `${s.tx},${s.ty} in chunk (-2,-5)`);
  const oak = scenery.find((s) => s.key === 'om-art:landmark-split-oak')!;
  assert.deepEqual([oak.x, oak.y], [(-48 + 10) * 16 + 8, (-120 + 11 + 1) * 16]);
  assert.equal(chunkScenery(t, (k) => !k.startsWith('om-art:')).length, t.decor.length - 1, 'missing art is left out, never stood in for');
  assert.deepEqual(chunkLandmarks(t, () => true).map((l) => l.place), ['place:-1:-1']);
  // A dark lamp stone by the road is a landmark too.
  m.sites.push({ $typeName: 'glimway.v1.StorySite', id: 'lamp-stone:-2:-5', kind: 7, tx: 3, ty: 4 });
  const road = terrainOf(decodeChunk(toBinary(WildsChunkSchema, m)));
  assert.ok(chunkLandmarks(road, () => true).some((l) => l.key === 'om-art:lamp-stone-dark' && l.tx === -48 + 3));
  for (const g of chunkGather(t)) assert.ok(g.tx >= -48 && g.tx < -24);
});

test('served entities stand on walkable ground', () => {
  for (const region of ['tangle', 'whitequiet-0-4', 'road', 'ford'] as const) {
    const t = fixtureTerrain(region);
    for (const e of t.entities) assert.equal(t.solid[e.ty]![e.tx], false, `${e.id}`);
  }
});

// ---------------------------------------------------------------- walked and seen

test('walked chunks and seen landmarks are kept per wick on the device', () => {
  forgetWalked();
  markWalked('wick-a', '0,-1');
  markWalked('wick-a', '0,-1');
  markWalked('wick-a', '1,-1');
  markSeen('wick-a', 'place:0:-2');
  assert.deepEqual(walkedChunks('wick-a'), ['0,-1', '1,-1']);
  assert.deepEqual(seenLandmarks('wick-a'), ['place:0:-2']);
  assert.deepEqual(walkedChunks('wick-b'), [], 'a new wick starts empty');
});

test('the frontier is cx -4..4, cy -8..0 (the client’s twin of frontier.Inside)', () => {
  let n = 0;
  for (let cy = -10; cy <= 2; cy++) for (let cx = -6; cx <= 6; cx++) if (inside(cx, cy)) n++;
  assert.equal(n, 81);
});

test('the open map is one area but three places on the HUD: the Tangle, the Whitequiet, beyond', async () => {
  const { displayArea, areaInfo } = await import('../src/content/world.ts');
  const at = (tx: number, ty: number) => displayArea({ area: 'outdoors', position: { x: tx * 16 + 8, y: ty * 16 + 8 } });
  assert.equal(at(2, 22), 'tangle');
  assert.equal(at(12, -60), 'whitequiet');
  assert.equal(at(12, -150), 'beyond');
  assert.equal(at(-60, -12), 'beyond');
  assert.equal(displayArea({ area: 'commons', position: { x: 0, y: 0 } }), 'commons');
  assert.equal(areaInfo('outdoors').name, 'The Tangle');
  assert.equal(areaInfo('whitequiet').name, 'The Whitequiet');
  assert.ok(areaInfo('beyond').name.length > 0);
});
