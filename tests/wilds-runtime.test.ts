import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_PX,
  CHUNK_TILES,
  WILDS_AREA,
  chunkAreaId,
  fromRegionPosition,
  guestEpoch,
  inRegion,
  isWildsArea,
  parseChunkArea,
  regionTile,
  toRegionPosition,
  wildsArrivalPosition,
  wildsSceneEntry,
} from '../src/game/wilds/regions.ts';
import { wildsPaperFor, WILDS_PAPER_PLACEMENTS } from '../src/game/wilds/placements.ts';
import { PAPERS } from '../src/content/papers.ts';
import { chunkEntities, chunkTerrain, loadWilds, rollLoot } from '../src/lib/wilds/index.ts';
import type { Epoch } from '../src/lib/wilds/types.ts';

/**
 * The Wilds position convention (brief item 2): saved Wilds progress is
 * area `wilds` with REGION-WIDE pixels (chunk offset × chunk tiles × 16px);
 * scenes play in chunk-local pixels. One conversion place, exercised here —
 * saves, reloads, claims and defeat reports all go through it.
 */

const epoch: Epoch = guestEpoch();

test('wilds area ids: wilds resolves to the entry chunk, chunks round-trip', () => {
  assert.deepEqual(parseChunkArea(WILDS_AREA), { cx: 1, cy: 1 });
  assert.deepEqual(parseChunkArea('chunk:inner-1:0:2'), { cx: 0, cy: 2 });
  assert.equal(parseChunkArea('chunk:other:0:0'), null);
  assert.equal(parseChunkArea('chunk:inner-1:3:0'), null); // outside the 3×3 grid
  assert.equal(parseChunkArea('village'), null);
  assert.equal(chunkAreaId(0, 2), 'chunk:inner-1:0:2');
  assert.equal(isWildsArea(WILDS_AREA), true);
  assert.equal(isWildsArea(chunkAreaId(2, 2)), true);
  assert.equal(isWildsArea('village'), false);
  assert.equal(isWildsArea('commons'), false);
});

test('chunk-local pixels ↔ region-wide progress pixels', () => {
  // Chunk (1,1) starts at 1 × 24 tiles × 16 px = 384 on each axis.
  assert.deepEqual(toRegionPosition(1, 1, 40, 360), { x: 424, y: 744 });
  assert.deepEqual(fromRegionPosition(424, 744), { cx: 1, cy: 1, x: 40, y: 360 });
  const round = fromRegionPosition(toRegionPosition(0, 2, 8, 8).x, toRegionPosition(0, 2, 8, 8).y);
  assert.deepEqual(round, { cx: 0, cy: 2, x: 8, y: 8 });
  assert.equal(CHUNK_PX, CHUNK_TILES * 16);
});

test('region tiles for defeat reports: progress (160,160) is tile (10,10)', () => {
  // The contract's example: a lantern at tile (10,10) for progress (160,160).
  assert.deepEqual(regionTile(160, 160), { x: 10, y: 10 });
  const p = toRegionPosition(1, 0, 40, 40);
  assert.deepEqual(regionTile(p.x, p.y), { x: 1 * CHUNK_TILES + 2, y: 0 * CHUNK_TILES + 2 });
});

test('wildsSceneEntry: a saved region-wide position picks its chunk and local tile', () => {
  const arrival = wildsArrivalPosition(epoch);
  const entry = wildsSceneEntry({ area: WILDS_AREA, position: arrival }, epoch);
  assert.ok(entry);
  assert.equal(entry.areaId, chunkAreaId(1, 1));
  // The arrival tile sits just inside the commons gap of the entry chunk.
  assert.equal(entry.tile.tx, Math.floor((arrival.x - 384) / 16));
  assert.equal(entry.tile.ty, Math.floor((arrival.y - 384) / 16));
  // A position in another chunk resolves there (reload keeps the chunk).
  // (Any walkable tile of that chunk: the woods are dense, so find one.)
  const woods = chunkTerrain(epoch, 2, 0);
  const open = woods.ground.flatMap((row, ty) => row.map((_, tx) => ({ tx, ty }))).find((t) => t.tx > 2 && t.ty > 2 && !woods.solid[t.ty][t.tx])!;
  const far = toRegionPosition(2, 0, open.tx * 16 + 4, open.ty * 16 + 12);
  const chunk20 = wildsSceneEntry({ area: WILDS_AREA, position: far }, epoch);
  assert.ok(chunk20);
  assert.equal(chunk20.areaId, chunkAreaId(2, 0));
  assert.deepEqual(chunk20.tile, open);
});

test('wildsSceneEntry: unconverted positions arrive at the region entry', () => {
  // A naive writer (or an old save) with a chunk-local or huge position.
  const entry = wildsSceneEntry({ area: WILDS_AREA, position: { x: 40, y: 36000 } }, epoch);
  assert.ok(entry);
  assert.equal(entry.areaId, chunkAreaId(1, 1));
  const arrival = wildsArrivalPosition(epoch);
  const local = fromRegionPosition(arrival.x, arrival.y);
  assert.deepEqual(entry.tile, { tx: Math.floor(local.x / 16), ty: Math.floor(local.y / 16) });
  assert.equal(inRegion(40000, 0), false);
});

test('wildsSceneEntry: null outside the Wilds', () => {
  assert.equal(wildsSceneEntry({ area: 'village', position: { x: 400, y: 300 } }, epoch), null);
});

test('the arrival tile is inside the region and walkable', () => {
  const arrival = wildsArrivalPosition(epoch);
  assert.equal(inRegion(arrival.x, arrival.y), true);
  const entry = wildsSceneEntry({ area: WILDS_AREA, position: arrival }, epoch)!;
  const [cx, cy] = [1, 1];
  const chunk = chunkTerrain(epoch, cx, cy);
  const blocked = new Set([...chunk.trees, ...chunk.bushes, ...chunk.rocks].map((t) => `${t.tx},${t.ty}`));
  assert.equal(chunk.solid[entry.tile.ty][entry.tile.tx], false);
  assert.equal(blocked.has(`${entry.tile.tx},${entry.tile.ty}`), false);
});

test('guest generation: every entity stands on walkable ground in its chunk', () => {
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      const chunk = chunkTerrain(epoch, cx, cy);
      const blocked = new Set([...chunk.trees, ...chunk.bushes, ...chunk.rocks].map((t) => `${t.tx},${t.ty}`));
      for (const e of chunkEntities(epoch, cx, cy)) {
        assert.equal(chunk.solid[e.ty][e.tx], false, `${e.id} on solid ground`);
        assert.equal(blocked.has(`${e.tx},${e.ty}`), false, `${e.id} under scenery`);
      }
    }
  }
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

test('guest loot rolls match the generator for a real claim cycle', () => {
  const entities = chunkEntities(epoch, 1, 1);
  const node = entities.find((e) => e.kind === 'node');
  assert.ok(node);
  const drop = rollLoot(epoch, node.id, 0);
  assert.ok(Array.isArray(drop.materials));
  for (const m of drop.materials) assert.ok(loadWilds().materials.includes(m.id));
});
