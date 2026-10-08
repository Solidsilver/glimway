/**
 * The Wilds client runtime: pure rules for the generated regions' area ids
 * and the one position convention (brief item 2).
 *
 * Regions: the Tangle (`inner-1`, permanent) and the outer Wilds
 * (`outer-1`, which turns every wick). They meet at the crossing on the
 * Tangle's far side (src/lib/wilds/outer.ts).
 *
 * Position convention — the single source of truth:
 * - Saved/progress positions in the Wilds are always `area: 'wilds'` with
 *   REGION-WIDE pixel coordinates: chunk offset × CHUNK_TILES tiles × 16 px,
 *   plus the chunk-local pixel. The server stores exactly this (contract:
 *   claims and defeat reports check `floor(position / 16)` against region
 *   tiles — the region named by the epoch in the request), and guests keep
 *   the same convention in their local saves.
 * - Which region a saved position is in is the client-only save marker
 *   `wildsRegion` (absent: the Tangle). The server keeps `area: 'wilds'` for
 *   both, so it never needs to know.
 * - A chunk scene's coordinates are chunk-local pixels (the scene is one
 *   24×24-tile chunk). Every conversion between the two goes through this
 *   module, so saves, reloads, claims and defeat reports all agree.
 *
 * Area ids: the Wilds as a whole are `wilds` (what saves store; what the
 * Commons' exit targets; it resolves to the Tangle's entry chunk). Each chunk
 * is registered as `chunk:<regionId>:<cx>:<cy>` — exactly the generator
 * library's exit targets.
 */
import { TILE, tileAt } from '../../lib/tile.ts';
import { COMMONS_FROM_WILDS } from '../commons.ts';
import { loadWilds } from '../../lib/wilds/data.ts';
import { chunkTerrain } from '../../lib/wilds/index.ts';
import { GUEST_WORLD_SEED, INNER_REGION_ID, OUTER_REGION_ID } from '../../lib/wilds/outer.ts';
import type { Epoch, WildsRegion } from '../../lib/wilds/types.ts';
import type { AreaId } from '../../lib/state.ts';
import { tileMid } from '../../lib/tile.ts'

/** The Tangle: the permanent inner region, just past the Commons. */
export const WILDS_REGION_ID = INNER_REGION_ID;
/** The outer Wilds, past the Tangle crossing. */
export { OUTER_REGION_ID };
/** The saved area id for anywhere in the Wilds (server contract). */
export const WILDS_AREA: AreaId = 'wilds';

/** The regions this build can enter. */
export const WILDS_REGION_IDS: readonly string[] = [INNER_REGION_ID, OUTER_REGION_ID];

export const CHUNK_TILES = loadWilds().chunkSize;
/** One chunk's side length in pixels. */
export const CHUNK_PX = CHUNK_TILES * TILE;

export const wildsRegion = (id: string = WILDS_REGION_ID): WildsRegion => {
  const region = loadWilds().regions.find((r) => r.id === id);
  if (!region) throw new Error(`wilds: region ${id} is not in content/wilds.json`);
  return region;
};

/** `chunk:<regionId>:<cx>:<cy>` — a chunk's area id. */
export function chunkAreaId(cx: number, cy: number, regionId: string = WILDS_REGION_ID): AreaId {
  return `chunk:${regionId}:${cx}:${cy}`;
}

/** True for `wilds` and for any chunk of a Wilds region. */
export function isWildsArea(areaId: string): boolean {
  return areaId === WILDS_AREA || parseChunkArea(areaId) !== null;
}

/** The chunk an area id plays in: `wilds` → the Tangle's entry chunk. Null elsewhere. */
export function parseChunkArea(areaId: string): { region: string; cx: number; cy: number } | null {
  if (areaId === WILDS_AREA) {
    const region = wildsRegion();
    return { region: WILDS_REGION_ID, cx: region.entryX, cy: region.entryY };
  }
  const m = /^chunk:(.+):(-?\d+):(-?\d+)$/.exec(areaId);
  if (!m || !WILDS_REGION_IDS.includes(m[1])) return null;
  const cx = Number(m[2]);
  const cy = Number(m[3]);
  const region = wildsRegion(m[1]);
  if (cx < 0 || cy < 0 || cx >= region.gridWidth || cy >= region.gridHeight) return null;
  return { region: m[1], cx, cy };
}

/** The region a save's Wilds position is in (the client-only marker). */
export function regionOfState(state: { area: string; wildsRegion?: string }): string {
  return state.area === WILDS_AREA && state.wildsRegion === OUTER_REGION_ID ? OUTER_REGION_ID : WILDS_REGION_ID;
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
  return { x: tileAt(x), y: tileAt(y) };
}

/** True when region-wide pixels are inside the region at all. */
export function inRegion(x: number, y: number, regionId: string = WILDS_REGION_ID): boolean {
  const region = wildsRegion(regionId);
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
 * (Their outer Wilds turn with the calendar: lib/wilds/outer.ts guestOuterEpoch.)
 */
export function guestEpoch(): Epoch {
  return { worldSeed: GUEST_WORLD_SEED, regionId: WILDS_REGION_ID, generatorVersion: 1, season: '0' };
}

/**
 * The progress position a player entering a region arrives at: its entry
 * chunk's way-home gap (the Commons gap in the Tangle; the crossing's gap in
 * the outer Wilds). Exported for whoever transitions into `wilds` (the
 * Commons' exit, the dev warp) and for the Turning, which brings players back
 * to the outer region's entrance.
 */
export function wildsArrivalPosition(epoch: Epoch): { x: number; y: number } {
  const region = wildsRegion(epoch.regionId);
  const chunk = chunkTerrain(epoch, region.entryX, region.entryY);
  return toRegionPosition(region.entryX, region.entryY, tileMid(chunk.spawn.tx), tileMid(chunk.spawn.ty));
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
 * position falls in (in the epoch's region), and the chunk-local arrival tile
 * (walkable — the spawn replaces a position that drifted into scenery). Null
 * outside the Wilds. Callers pass the epoch of the save's region (the store's).
 */
export function wildsSceneEntry(
  state: { area: string; position: { x: number; y: number } },
  epoch: Epoch
): { areaId: AreaId; tile: { tx: number; ty: number } } | null {
  if (!isWildsArea(state.area)) return null;
  if (inRegion(state.position.x, state.position.y, epoch.regionId)) {
    const tile = wildsTileOf(state.position, epoch);
    if (tile) return tile;
  }
  // Not region-wide (an unconverted position): arrive at the region's entry.
  const arrival = wildsArrivalPosition(epoch);
  const r = fromRegionPosition(arrival.x, arrival.y);
  return {
    areaId: chunkAreaId(r.cx, r.cy, epoch.regionId),
    tile: { tx: tileAt(r.x), ty: tileAt(r.y) },
  };
}

/** The walkable chunk tile a region-wide position lands on, or null. */
function wildsTileOf(position: { x: number; y: number }, epoch: Epoch): { areaId: AreaId; tile: { tx: number; ty: number } } | null {
  const r = fromRegionPosition(position.x, position.y);
  const region = wildsRegion(epoch.regionId);
  if (r.cx < 0 || r.cy < 0 || r.cx >= region.gridWidth || r.cy >= region.gridHeight) return null;
  const tx = tileAt(r.x);
  const ty = tileAt(r.y);
  const chunk = chunkTerrain(epoch, r.cx, r.cy);
  const clear =
    tx >= 0 &&
    ty >= 0 &&
    tx < chunk.width &&
    ty < chunk.height &&
    !chunk.solid[ty][tx] &&
    ![...chunk.trees, ...chunk.bushes, ...chunk.rocks].some((p) => p.tx === tx && p.ty === ty);
  return {
    areaId: chunkAreaId(r.cx, r.cy, epoch.regionId),
    tile: clear ? { tx, ty } : chunk.spawn,
  };
}
