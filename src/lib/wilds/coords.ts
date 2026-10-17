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

/** A held chunk (lamps.md 2.2): it pushes the frontier out by frontier.heldSlack chunks. */
export interface HeldKey {
  cx: number;
  cy: number;
}

/** The world's held chunks as the near read last named them (store.ts sets them). */
let held: readonly HeldKey[] = [];

/** Set the world's held chunks (the near read's frontier.held; [] on leaving a world). */
export function setHeldReach(keys: readonly HeldKey[]): void {
  held = keys.map((k) => ({ cx: k.cx, cy: k.cy }));
}

/** The world's held chunks as last set. */
export function heldReach(): readonly HeldKey[] {
  return held;
}

/** Within frontier.heldSlack chunks of a held chunk, and no further south than frontier.southLimit. */
export function inHeldSlack(cx: number, cy: number, keys: readonly HeldKey[] = held): boolean {
  const f = loadWilds().frontier;
  return cy <= f.southLimit && keys.some((k) => Math.max(Math.abs(k.cx - cx), Math.abs(k.cy - cy)) <= f.heldSlack);
}

/**
 * The frontier (decision 3; lamps.md 2.2): within frontier.reach chunks of a
 * footprint and no further south than frontier.southLimit, or in a held
 * chunk's slack. The server enforces it (server/internal/frontier); the
 * client treats chunks outside it as solid.
 */
export function insideFrontier(cx: number, cy: number, fixed: Places['fixed'] = PLACES.fixed, keys: readonly HeldKey[] = held): boolean {
  const f = loadWilds().frontier;
  return (cy <= f.southLimit && nearestFootprint(cx, cy, fixed) <= f.reach) || inHeldSlack(cx, cy, keys);
}

/** Bounding rectangle of the reach union, held slack included; membership uses insideFrontier. */
export function frontierRect(keys: readonly HeldKey[] = held): { minCx: number; minCy: number; maxCx: number; maxCy: number } {
  const w = loadWilds(), reach = w.frontier.reach, slack = w.frontier.heldSlack, south = w.frontier.southLimit;
  const places = [...w.places, ...PLACES.fixed];
  const r = {
    minCx: Math.min(...places.map(p => p.cx - reach)),
    minCy: Math.min(...places.map(p => p.cy - reach)),
    maxCx: Math.max(...places.map(p => p.cx + p.width - 1 + reach)),
    maxCy: Math.min(south, Math.max(...places.map(p => p.cy + p.height - 1 + reach))),
  };
  // Only slack the static frontier doesn't already hold widens it, as on the server.
  for (const k of keys) {
    for (let cy = k.cy - slack; cy <= Math.min(k.cy + slack, south); cy++) {
      for (let cx = k.cx - slack; cx <= k.cx + slack; cx++) {
        if (cy <= south && nearestFootprint(cx, cy) <= reach) continue;
        r.minCx = Math.min(r.minCx, cx);
        r.minCy = Math.min(r.minCy, cy);
        r.maxCx = Math.max(r.maxCx, cx);
        r.maxCy = Math.max(r.maxCy, cy);
      }
    }
  }
  return r;
}
