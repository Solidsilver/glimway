/**
 * The open map's coordinates (docs/design/open-map.md 2.1): world tiles and
 * chunks are signed, north is -y, and chunk (0, 0) is the one the Commons
 * gate opens into. Tile (x, y) lies in chunk (floor(x/S), floor(y/S)) and
 * pixel (px, py) on tile (floor(px/16), floor(py/16)). The twin of
 * server/internal/wilds/coords.go and frontier.go; both replay
 * content/vectors/wilds-coords.json.
 */
import { PLACES, type Places } from '../places.ts';
import { TILE } from '../tile.ts';
import { loadWilds } from './data.ts';
import type { WildsEpochKind, WildsPlace } from './types.ts';

/** a/b rounded toward minus infinity, for integers; b > 0. */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** The chunk a world tile lies in. */
export function chunkOf(tx: number, ty: number): { cx: number; cy: number } {
  const S = loadWilds().chunkSize;
  return { cx: floorDiv(tx, S), cy: floorDiv(ty, S) };
}

/** A world tile's place inside its chunk, 0..S-1 each way. */
export function localOf(tx: number, ty: number): { lx: number; ly: number } {
  const S = loadWilds().chunkSize;
  const { cx, cy } = chunkOf(tx, ty);
  return { lx: tx - cx * S, ly: ty - cy * S };
}

/** The world tile under a world pixel. */
export function tileOfPixel(px: number, py: number): { tx: number; ty: number } {
  return { tx: floorDiv(px, TILE), ty: floorDiv(py, TILE) };
}

/** Chebyshev distance in chunks from (cx, cy) to the footprint's nearest chunk; 0 inside it. */
export function footprintDistance(p: Pick<WildsPlace, 'cx' | 'cy' | 'width' | 'height'>, cx: number, cy: number): number {
  const dx = Math.max(p.cx - cx, cx - (p.cx + p.width - 1), 0);
  const dy = Math.max(p.cy - cy, cy - (p.cy + p.height - 1), 0);
  return Math.max(dx, dy);
}

/** The footprint holding chunk (cx, cy), if any. */
export function footprintAt(cx: number, cy: number): WildsPlace | undefined {
  return loadWilds().places.find((p) => footprintDistance(p, cx, cy) === 0);
}

/** The least distance from a chunk to any footprint. */
export function nearestFootprint(cx: number, cy: number, fixed: Places['fixed'] = PLACES.fixed): number {
  return Math.min(...[...loadWilds().places, ...fixed].map((p) => footprintDistance(p, cx, cy)));
}

/** Rings of tierRingChunks past the footprints: 0 inside one. */
export function ring(cx: number, cy: number): number {
  return Math.ceil(nearestFootprint(cx, cy) / loadWilds().tierRingChunks);
}

/** A chunk's tier of difficulty (decision 9). */
export function tier(cx: number, cy: number): number {
  const p = footprintAt(cx, cy);
  if (p) return p.tier;
  return Math.min(2 + Math.max(ring(cx, cy) - 1, 0), loadWilds().tiers.length);
}

/** The epoch kind a chunk is made in: its footprint's, else the wick's. */
export function epochKindAt(cx: number, cy: number): WildsEpochKind {
  return footprintAt(cx, cy)?.epochKind ?? 'wick';
}

/** The cell holding chunk (cx, cy): the Tangle is (0, 0), the Whitequiet (0, -1). */
export function cellOf(cx: number, cy: number): { x: number; y: number } {
  const c = loadWilds().cells;
  return { x: floorDiv(cx - c.originCx, c.cellChunks), y: floorDiv(cy - c.originCy, c.cellChunks) };
}

/** A cell's place id. */
export function cellPlaceId(x: number, y: number): string {
  return `place:${x}:${y}`;
}

/**
 * The 0.8 frontier (decision 3): within frontier.reach chunks of a
 * footprint and no further south than frontier.southLimit. The server
 * enforces it; the client treats chunks outside it as solid.
 */
export function insideFrontier(cx: number, cy: number, fixed: Places['fixed'] = PLACES.fixed): boolean {
  const f = loadWilds().frontier;
  return cy <= f.southLimit && nearestFootprint(cx, cy, fixed) <= f.reach;
}

/** Bounding rectangle of the reach union; membership uses insideFrontier. */
export function frontierRect(): { minCx: number; minCy: number; maxCx: number; maxCy: number } {
  const w = loadWilds(), reach = w.frontier.reach;
  const places = [...w.places, ...PLACES.fixed];
  return {
    minCx: Math.min(...places.map(p => p.cx - reach)),
    minCy: Math.min(...places.map(p => p.cy - reach)),
    maxCx: Math.max(...places.map(p => p.cx + p.width - 1 + reach)),
    maxCy: Math.min(w.frontier.southLimit, Math.max(...places.map(p => p.cy + p.height - 1 + reach))),
  };
}
