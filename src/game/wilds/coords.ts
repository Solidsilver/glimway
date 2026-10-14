/**
 * The open map on the client (docs/design/open-map.md 2.1, 2.5): one
 * convention for every position in the Wilds.
 *
 * - The scene's coordinates ARE world pixels, signed: tile (tx, ty) covers
 *   pixels [16·tx, 16·tx + 16), and lies in chunk (floor(tx/24),
 *   floor(ty/24)). North is -y; chunk (0, 0) is the one the Commons gate
 *   opens into.
 * - The save keeps `area: 'outdoors'` and the hero's world pixels; an
 *   operation's `where` is the same (`area: 'outdoors'`, x, y), and the server
 *   reads `floor(position / 16)` world tiles.
 *
 * The pure tile and chunk rules are src/lib/wilds/coords.ts (shared vectors
 * with the server); this adds pixels, the gate, and the scene's area id.
 */
import { TILE } from '../../lib/tile.ts';
import { floorDiv } from '../../lib/wilds/coords.ts';
import { loadWilds } from '../../lib/wilds/data.ts';
import type { AreaId } from '../../lib/state.ts';


/** The saved area id for anywhere in the Wilds, and the scene's area id there. */
export const OUTDOORS_AREA: AreaId = 'outdoors';

export const CHUNK_TILES = loadWilds().chunkSize;
/** One chunk's side length in pixels. */
export const CHUNK_PX = CHUNK_TILES * TILE;

/** True in the Wilds. */
export function isWildsArea(areaId: string): boolean {
  return areaId === OUTDOORS_AREA;
}

/** The chunk a world pixel lies in. */
export function chunkOfPixel(x: number, y: number): { cx: number; cy: number } {
  return { cx: floorDiv(x, CHUNK_PX), cy: floorDiv(y, CHUNK_PX) };
}

/** `cx,cy`: the client's key for a chunk. */
export const chunkKey = (cx: number, cy: number): string => `${cx},${cy}`;

export function parseChunkKey(key: string): { cx: number; cy: number } {
  const [cx, cy] = key.split(',').map(Number);
  return { cx: cx!, cy: cy! };
}

/** A chunk-local tile's world tile. */
export function worldTile(cx: number, cy: number, lx: number, ly: number): { tx: number; ty: number } {
  return { tx: cx * CHUNK_TILES + lx, ty: cy * CHUNK_TILES + ly };
}

/**
 * The Commons gate (content `places.tangle.openings.commons-gate`): its
 * world tiles on the south edge of chunk (0, 0), the Tangle's mouth onto the
 * Commons (the Commons' arch lies just south of it, on fixed ground).
 */
export function gateTiles(): { tx: number; ty: number; tw: number; th: number } {
  const tangle = loadWilds().places.find((p) => p.id === 'tangle');
  const gate = tangle?.openings.find((o) => o.id === 'commons-gate');
  if (!gate || gate.edge !== 'south') throw new Error('wilds: no Commons gate in content');
  const at = worldTile(gate.cx, gate.cy, gate.offset, CHUNK_TILES - 1);
  return { tx: at.tx, ty: at.ty, tw: gate.width, th: 1 };
}
