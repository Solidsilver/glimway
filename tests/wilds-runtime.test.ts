import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHUNK_PX,
  CHUNK_TILES,
  WILDS_AREA,
  chunkAreaId,
  fromRegionPosition,
  inRegion,
  isWildsArea,
  parseChunkArea,
  regionTile,
  toRegionPosition,
  wildsArrivalPosition,
  wildsSceneEntry,
} from '../src/game/wilds/regions.ts';
import { loadChunk } from '../src/game/wilds/chunks.ts';
import type { WildsEpoch } from '../src/game/wilds/store.ts';
import { wildsPaperFor, WILDS_PAPER_PLACEMENTS } from '../src/game/wilds/placements.ts';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import { PAPERS } from '../src/content/papers.ts';
import { loadWilds } from '../src/lib/wilds/data.ts';

/**
 * The Wilds position convention: Wilds positions are REGION-WIDE pixels
 * (chunk offset × chunk tiles × 16px); scenes play in chunk-local pixels.
 * One conversion place, exercised here — saves, reloads and operations'
 * `where` all go through it. The chunk is the server's (tests/fixtures,
 * written by server/internal/wilds TestClientFixtures).
 */

const epoch: WildsEpoch = { id: 'fixture-inner', worldSeed: 'fixture', regionId: 'inner-1', generatorVersion: 2, season: '0', endsAt: null };
const fixture = decodeChunk(new Uint8Array(readFileSync(new URL('./fixtures/wilds-inner-1-1.bin', import.meta.url))));
const entry = await loadChunk({ chunk: async () => fixture }, epoch.id, 1, 1);

test('wilds area ids: wilds resolves to the entry chunk, chunks round-trip', () => {
  assert.deepEqual(parseChunkArea(WILDS_AREA), { region: 'inner-1', cx: 1, cy: 1 });
  assert.deepEqual(parseChunkArea('chunk:inner-1:0:2'), { region: 'inner-1', cx: 0, cy: 2 });
  // The outer Wilds: their own chunk ids, same grid rules.
  assert.deepEqual(parseChunkArea('chunk:outer-1:2:0'), { region: 'outer-1', cx: 2, cy: 0 });
  assert.equal(parseChunkArea('chunk:outer-1:3:0'), null);
  assert.equal(chunkAreaId(1, 1, 'outer-1'), 'chunk:outer-1:1:1');
  assert.equal(isWildsArea('chunk:outer-1:1:1'), true);
  assert.equal(parseChunkArea('chunk:other:0:0'), null);
  assert.equal(parseChunkArea('chunk:inner-1:3:0'), null); // outside the 3×3 grid
  assert.equal(parseChunkArea('village'), null);
  assert.equal(chunkAreaId(0, 2), 'chunk:inner-1:0:2');
  assert.equal(isWildsArea(WILDS_AREA), true);
  assert.equal(isWildsArea(chunkAreaId(2, 2)), true);
  assert.equal(isWildsArea('village'), false);
  assert.equal(isWildsArea('commons'), false);
});

test('chunk-local pixels ↔ region-wide pixels', () => {
  // Chunk (1,1) starts at 1 × 24 tiles × 16 px = 384 on each axis.
  assert.deepEqual(toRegionPosition(1, 1, 40, 360), { x: 424, y: 744 });
  assert.deepEqual(fromRegionPosition(424, 744), { cx: 1, cy: 1, x: 40, y: 360 });
  const round = fromRegionPosition(toRegionPosition(0, 2, 8, 8).x, toRegionPosition(0, 2, 8, 8).y);
  assert.deepEqual(round, { cx: 0, cy: 2, x: 8, y: 8 });
  assert.equal(CHUNK_PX, CHUNK_TILES * 16);
});

test('region tiles: pixels (160,160) are tile (10,10)', () => {
  assert.deepEqual(regionTile(160, 160), { x: 10, y: 10 });
  const p = toRegionPosition(1, 0, 40, 40);
  assert.deepEqual(regionTile(p.x, p.y), { x: 1 * CHUNK_TILES + 2, y: 0 * CHUNK_TILES + 2 });
});

test('the arrival is the served entry chunk’s spawn, inside the region and walkable', () => {
  const arrival = wildsArrivalPosition(epoch);
  assert.equal(inRegion(arrival.x, arrival.y), true);
  const at = wildsSceneEntry({ area: WILDS_AREA, position: arrival }, epoch)!;
  assert.equal(at.areaId, chunkAreaId(1, 1));
  assert.deepEqual(at.tile, entry.spawn);
  assert.equal(entry.solid[at.tile.ty]![at.tile.tx], false);
  // Before the region's chunks load, the generator's fixed spot by the way home.
  const unread: WildsEpoch = { ...epoch, id: '' };
  assert.deepEqual(wildsArrivalPosition(unread), toRegionPosition(1, 1, 2 * 16 + 8, 22 * 16 + 8));
  assert.deepEqual(wildsArrivalPosition(unread), arrival, 'the served spawn is that spot');
});

test('wildsSceneEntry: a saved position keeps its tile when open, else the chunk’s spawn', () => {
  const open = entry.ground.flatMap((row, ty) => row.map((_, tx) => ({ tx, ty }))).find((t) => t.tx > 4 && t.ty > 4 && !entry.solid[t.ty]![t.tx])!;
  const here = wildsSceneEntry({ area: WILDS_AREA, position: toRegionPosition(1, 1, open.tx * 16 + 4, open.ty * 16 + 12) }, epoch)!;
  assert.deepEqual(here.tile, open);
  const wall = toRegionPosition(1, 1, 4, 4); // the chunk's corner is woods
  assert.equal(entry.solid[0]![0], true);
  assert.deepEqual(wildsSceneEntry({ area: WILDS_AREA, position: wall }, epoch)!.tile, entry.spawn);
  // A chunk not loaded yet: the tile stands as saved (the scene loads first).
  const far = wildsSceneEntry({ area: WILDS_AREA, position: toRegionPosition(2, 0, 100, 60) }, epoch)!;
  assert.equal(far.areaId, chunkAreaId(2, 0));
  assert.deepEqual(far.tile, { tx: 6, ty: 3 });
});

test('wildsSceneEntry: positions outside the region arrive at the entry; null outside the Wilds', () => {
  const at = wildsSceneEntry({ area: WILDS_AREA, position: { x: 40, y: 36000 } }, epoch)!;
  assert.equal(at.areaId, chunkAreaId(1, 1));
  assert.deepEqual(at.tile, entry.spawn);
  assert.equal(inRegion(40000, 0), false);
  assert.equal(wildsSceneEntry({ area: 'village', position: { x: 400, y: 300 } }, epoch), null);
});

test('served entities stand on walkable ground', () => {
  assert.ok(entry.entities.length > 0);
  for (const e of entry.entities) assert.equal(entry.solid[e.ty]![e.tx], false, `${e.id} on solid ground`);
});

test('wilds paper placements: every id is a real wilds paper, hooks match', () => {
  const data = loadWilds();
  for (const p of WILDS_PAPER_PLACEMENTS) {
    const paper = PAPERS.find((x) => x.id === p.paperId);
    assert.ok(paper, `${p.paperId} exists in papers.ts`);
    if (p.poi !== undefined) {
      assert.equal(paper.source.kind, 'wilds-poi', `${p.paperId} is a wilds-poi source`);
      assert.ok(data.poiIds.includes(p.poi), `${p.poi} is a generated POI id`);
    }
    if (p.chestTier !== undefined) {
      assert.equal(paper.source.kind, 'wilds-chest', `${p.paperId} is a wilds-chest source`);
      assert.ok(p.chestTier >= 1 && p.chestTier <= 3, 'chest tiers the generator rolls');
    }
  }
});

test('wilds paper placements: the east-only find only pays in the east column', () => {
  const east = wildsPaperFor({ kind: 'poi', poi: 'mossy-arch', tier: 0 }, 2, 3);
  assert.equal(east, 'joss-penhallow-field-notes-pencil-map');
  assert.equal(wildsPaperFor({ kind: 'poi', poi: 'mossy-arch', tier: 0 }, 1, 3), null);
  assert.equal(wildsPaperFor({ kind: 'poi', poi: 'old-shrine', tier: 0 }, 0, 3), 'failed-grid-of-sector-4');
  assert.equal(wildsPaperFor({ kind: 'chest', poi: '', tier: 3 }, 0, 3), 'the-blind-routes-smugglers-ledger');
  assert.equal(wildsPaperFor({ kind: 'chest', poi: '', tier: 2 }, 2, 3), null);
});
