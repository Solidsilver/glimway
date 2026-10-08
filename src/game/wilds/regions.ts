/**
 * The Wilds client runtime: pure rules for the regions' area ids and the one
 * position convention.
 *
 * Regions: the Tangle (`inner-1`, permanent) and the outer Wilds
 * (`outer-1`, which turns every wick). They meet at the crossing on the
 * Tangle's far side. The server generates both; their chunks arrive through
 * game/wilds/chunks.ts.
 *
 * Position convention — the single source of truth:
 * - Positions in the Wilds are REGION-WIDE pixel coordinates: chunk offset ×
 *   CHUNK_TILES tiles × 16 px, plus the chunk-local pixel. The server reads
 *   exactly this from an operation's `where` (`wilds:<region>`, x, y), as
 *   `floor(position / 16)` region tiles.
 * - The save keeps `area: 'wilds'` with the client-only marker `wildsRegion`
 *   (absent: the Tangle); `where.area` names the region instead.
 * - A chunk scene's coordinates are chunk-local pixels (the scene is one
 *   24×24-tile chunk). Every conversion between the two goes through this
 *   module, so saves, reloads and operations all agree.
 *
 * Area ids: the Wilds as a whole are `wilds` (what saves store; what the
 * Commons' exit targets; it resolves to the Tangle's entry chunk). Each chunk
 * is registered as `chunk:<regionId>:<cx>:<cy>` — exactly the served exits'
 * targets.
 */
import { TILE, tileAt } from '../../lib/tile.ts';
import { COMMONS_FROM_WILDS } from '../commons.ts';
import { loadWilds } from '../../lib/wilds/data.ts';
import { INNER_REGION_ID, OUTER_REGION_ID } from '../../lib/wilds/outer.ts';
import type { WildsRegion } from '../../lib/wilds/types.ts';
import { cachedTerrain } from './chunks.ts';
import type { WildsEpoch } from './store.ts';
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
 * The progress position a player entering a region arrives at: its entry
 * chunk's way-home gap (the Commons gap in the Tangle; the crossing's gap in
 * the outer Wilds). Exported for whoever transitions into `wilds` (the
 * Commons' exit, the dev warp) and for the Turning, which brings players back
 * to the outer region's entrance. The served chunk's spawn when it is loaded;
 * before that, the generator's fixed spot just inside the way home.
 */
export function wildsArrivalPosition(epoch: WildsEpoch): { x: number; y: number } {
  const region = wildsRegion(epoch.regionId);
  const spawn = cachedTerrain(epoch.id, region.entryX, region.entryY)?.spawn ?? { tx: HOME_GAP_TX + 1, ty: CHUNK_TILES - 2 };
  return toRegionPosition(region.entryX, region.entryY, tileMid(spawn.tx), tileMid(spawn.ty));
}

/** The way home on a region's entry chunk: its south edge at tx = 1 (server/internal/wilds/gen_v2.go). */
const HOME_GAP_TX = 1;

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
  epoch: WildsEpoch
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

/**
 * The walkable chunk tile a region-wide position lands on, or null. With the
 * chunk not loaded yet, the tile stands as saved (the scene loads it first).
 */
function wildsTileOf(position: { x: number; y: number }, epoch: WildsEpoch): { areaId: AreaId; tile: { tx: number; ty: number } } | null {
  const r = fromRegionPosition(position.x, position.y);
  const region = wildsRegion(epoch.regionId);
  if (r.cx < 0 || r.cy < 0 || r.cx >= region.gridWidth || r.cy >= region.gridHeight) return null;
  const tx = tileAt(r.x);
  const ty = tileAt(r.y);
  const chunk = cachedTerrain(epoch.id, r.cx, r.cy);
  const clear = !chunk || (tx >= 0 && ty >= 0 && tx < chunk.width && ty < chunk.height && !chunk.solid[ty]![tx]);
  return {
    areaId: chunkAreaId(r.cx, r.cy, epoch.regionId),
    tile: clear || !chunk ? { tx, ty } : chunk.spawn,
  };
}
