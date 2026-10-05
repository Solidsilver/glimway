/**
 * The Wilds client runtime: pure rules for the generated region's area ids
 * and the one position convention (brief item 2).
 *
 * Position convention — the single source of truth:
 * - Saved/progress positions in the Wilds are always `area: 'wilds'` with
 *   REGION-WIDE pixel coordinates: chunk offset × CHUNK_TILES tiles × 16 px,
 *   plus the chunk-local pixel. The server stores exactly this (contract:
 *   claims and defeat reports check `floor(position / 16)` against region
 *   tiles), and guests keep the same convention in their local saves.
 * - A chunk scene's coordinates are chunk-local pixels (the scene is one
 *   24×24-tile chunk). Every conversion between the two goes through this
 *   module, so saves, reloads, claims and defeat reports all agree.
 *
 * Area ids: the region as a whole is `wilds` (what saves store; what the
 * Commons' exit targets). Each chunk is registered as
 * `chunk:<regionId>:<cx>:<cy>`; `wilds` resolves to the region's entry chunk.
 * These are exactly the generator library's exit targets
 * (`chunk:<regionId>:<cx>:<cy>`, `commons`).
 */
import { TILE } from '../textures.ts';
import { COMMONS_FROM_WILDS } from '../commons.ts';
import { loadWilds } from '../../lib/wilds/data.ts';
import { chunkTerrain } from '../../lib/wilds/index.ts';
import type { Epoch, WildsRegion } from '../../lib/wilds/types.ts';
import type { AreaId } from '../../lib/state.ts';

/** The one permanent inner region this build ships. */
export const WILDS_REGION_ID = 'inner-1';
/** The saved area id for anywhere in the Wilds (server contract). */
export const WILDS_AREA: AreaId = 'wilds';

export const CHUNK_TILES = loadWilds().chunkSize;
/** Pixels per progress tile (matches src/game/textures.ts TILE and the server). */
export const WILDS_TILE_PX = TILE;
/** One chunk's side length in pixels. */
export const CHUNK_PX = CHUNK_TILES * WILDS_TILE_PX;

export const wildsRegion = (): WildsRegion => {
  const region = loadWilds().regions.find((r) => r.id === WILDS_REGION_ID);
  if (!region) throw new Error(`wilds: region ${WILDS_REGION_ID} is not in content/wilds.json`);
  return region;
};

/** `chunk:<regionId>:<cx>:<cy>` — a chunk's area id. */
export function chunkAreaId(cx: number, cy: number): AreaId {
  return `chunk:${WILDS_REGION_ID}:${cx}:${cy}`;
}

/** True for `wilds` and for any chunk of the Wilds region. */
export function isWildsArea(areaId: string): boolean {
  return areaId === WILDS_AREA || parseChunkArea(areaId) !== null;
}

/** The chunk an area id plays in: `wilds` → the entry chunk. Null elsewhere. */
export function parseChunkArea(areaId: string): { cx: number; cy: number } | null {
  if (areaId === WILDS_AREA) {
    const region = wildsRegion();
    return { cx: region.entryX, cy: region.entryY };
  }
  const m = /^chunk:(.+):(-?\d+):(-?\d+)$/.exec(areaId);
  if (!m || m[1] !== WILDS_REGION_ID) return null;
  const cx = Number(m[2]);
  const cy = Number(m[3]);
  const region = wildsRegion();
  if (cx < 0 || cy < 0 || cx >= region.gridWidth || cy >= region.gridHeight) return null;
  return { cx, cy };
}

/** Chunk-local scene pixels → region-wide progress pixels. */
export function toRegionPosition(cx: number, cy: number, x: number, y: number): { x: number; y: number } {
  return { x: cx * CHUNK_PX + x, y: cy * CHUNK_PX + y };
}

/** Region-wide progress pixels → the chunk they are in + chunk-local pixels. */
export function fromRegionPosition(
  x: number,
  y: number
): { cx: number; cy: number; x: number; y: number } {
  const cx = Math.floor(x / CHUNK_PX);
  const cy = Math.floor(y / CHUNK_PX);
  return { cx, cy, x: x - cx * CHUNK_PX, y: y - cy * CHUNK_PX };
}

/** Region-wide progress pixels → region tiles (defeat-report coordinates). */
export function regionTile(x: number, y: number): { x: number; y: number } {
  return { x: Math.floor(x / WILDS_TILE_PX), y: Math.floor(y / WILDS_TILE_PX) };
}

/** True when region-wide pixels are inside the region at all. */
export function inRegion(x: number, y: number): boolean {
  const region = wildsRegion();
  return (
    x >= 0 &&
    y >= 0 &&
    x < region.gridWidth * CHUNK_PX &&
    y < region.gridHeight * CHUNK_PX
  );
}

/**
 * Guests generate the Tangle from a fixed local epoch (no server, no shared
 * world seed). Deterministic, so a guest's Tangle is the same every visit.
 */
export function guestEpoch(): Epoch {
  return { worldSeed: 'fingersnap-guest', regionId: WILDS_REGION_ID, generatorVersion: 1, season: '0' };
}

/**
 * The progress position a player entering the Wilds arrives at: the entry
 * chunk's arrival tile from the Commons gap. Exported for whoever transitions
 * into `wilds` (the Commons' exit, the dev warp): entering the Wilds means
 * writing this region-wide position, then the chunk resolves from it.
 */
export function wildsArrivalPosition(epoch: Epoch): { x: number; y: number } {
  const chunk = chunkTerrain(epoch, wildsRegion().entryX, wildsRegion().entryY);
  const commons = chunk.exits.find((e) => e.to === 'commons') ?? chunk.exits[0];
  const entry = commons ? commons.entry : chunk.spawn;
  return toRegionPosition(
    wildsRegion().entryX,
    wildsRegion().entryY,
    (entry.tx + 0.5) * WILDS_TILE_PX,
    (entry.ty + 0.5) * WILDS_TILE_PX
  );
}

/**
 * The Commons tile a player leaving the Wilds arrives at (just inside the
 * north arch — the agreed handoff with the Commons; see src/game/commons.ts).
 */
export function wildsReturnTile(): { tx: number; ty: number } {
  return { ...COMMONS_FROM_WILDS };
}

/**
 * Where a Wilds scene plays, from saved progress: the chunk the region-wide
 * position falls in, and the chunk-local arrival tile (walkable — the spawn
 * replaces a position that drifted into scenery). Null outside the Wilds.
 * Callers pass the epoch the region was generated from (the store's).
 */
export function wildsSceneEntry(
  state: { area: string; position: { x: number; y: number } },
  epoch: Epoch
): { areaId: AreaId; tile: { tx: number; ty: number } } | null {
  if (!isWildsArea(state.area)) return null;
  if (inRegion(state.position.x, state.position.y)) {
    const tile = wildsTileOf(state.position, epoch);
    if (tile) return tile;
  }
  // Not region-wide (an unconverted position): arrive at the region's entry.
  const arrival = wildsArrivalPosition(epoch);
  const r = fromRegionPosition(arrival.x, arrival.y);
  return {
    areaId: chunkAreaId(r.cx, r.cy),
    tile: { tx: Math.floor(r.x / WILDS_TILE_PX), ty: Math.floor(r.y / WILDS_TILE_PX) },
  };
}

/** The walkable chunk tile a region-wide position lands on, or null. */
function wildsTileOf(position: { x: number; y: number }, epoch: Epoch): { areaId: AreaId; tile: { tx: number; ty: number } } | null {
  const r = fromRegionPosition(position.x, position.y);
  const region = wildsRegion();
  if (r.cx < 0 || r.cy < 0 || r.cx >= region.gridWidth || r.cy >= region.gridHeight) return null;
  const tx = Math.floor(r.x / WILDS_TILE_PX);
  const ty = Math.floor(r.y / WILDS_TILE_PX);
  const chunk = chunkTerrain(epoch, r.cx, r.cy);
  const clear =
    tx >= 0 &&
    ty >= 0 &&
    tx < chunk.width &&
    ty < chunk.height &&
    !chunk.solid[ty][tx] &&
    ![...chunk.trees, ...chunk.bushes, ...chunk.rocks].some((p) => p.tx === tx && p.ty === ty);
  return {
    areaId: chunkAreaId(r.cx, r.cy),
    tile: clear ? { tx, ty } : chunk.spawn,
  };
}
