/**
 * A homestead's wild land, as the server serves it (GET /api/homestead/land/
 * <gate>; server/internal/land generates it, and validates placement and
 * gathering against the same tiles). The client never generates land: it
 * keeps the served grid per gate (rememberLand, servedLand) and reads it
 * with the helpers below.
 */
import { HOMESTEAD_DATA, type HomesteadData } from './homestead.ts';

export const LAND = {
  GRASS: 0,
  TREE: 1,
  STUMP: 2,
  BOULDER: 3,
  WATER: 4,
  FORD: 5,
  SLOPE: 6,
  EDGE: 7,
  PATH: 8,
} as const;

/** The served cell names (the LAND vocabulary), by kind value. */
export const LAND_CELLS = ['grass', 'tree', 'stump', 'boulder', 'water', 'ford', 'slope', 'edge', 'path'] as const;


export interface Land {
  width: number;
  height: number;
  /** Row-major kinds. */
  tiles: Uint8Array;
}

export function landAt(land: Land, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= land.width || y >= land.height) return LAND.EDGE;
  return land.tiles[y * land.width + x];
}

/** Obstacles Silas can clear for glims (trees, stumps, boulders). */
export function clearable(kind: number): boolean {
  return kind === LAND.TREE || kind === LAND.STUMP || kind === LAND.BOULDER;
}

const key = (x: number, y: number) => `${x},${y}`;

/** What stands on a tile once cleared tiles are taken into account. */
export function effectiveKind(land: Land, cleared: ReadonlySet<string>, x: number, y: number): number {
  const k = landAt(land, x, y);
  return clearable(k) && cleared.has(key(x, y)) ? LAND.GRASS : k;
}

/** Can something be built here (light permitting)? */
export function buildableKind(kind: number): boolean {
  return kind === LAND.GRASS || kind === LAND.PATH;
}

export function clearedSet(list: readonly { x: number; y: number }[] | readonly [number, number][]): Set<string> {
  return new Set(list.map((c) => (Array.isArray(c) ? key(c[0], c[1]) : key((c as { x: number }).x, (c as { y: number }).y))));
}

/** A light: the home's own lamp at the site, or a named lantern post. */
export interface Light {
  x: number;
  y: number;
  radius: number;
}

/**
 * The lights holding a homestead's ground: the home's own light, and every
 * placed post whose light connects back to it — a post counts once its tile
 * stands in the home's light or in the light of a post that already counts.
 * Posts can't hold each other up out in the dark (server/internal/api
 * connectedLights is the same rule).
 */
export function homeLights(posts: readonly { x: number; y: number }[], data: HomesteadData = HOMESTEAD_DATA): Light[] {
  const s = data.land.startLight;
  const out: Light[] = [{ x: s.x, y: s.y, radius: s.radius }];
  const waiting = [...posts];
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < waiting.length; i++) {
      const p = waiting[i];
      if (isLit(out, p.x, p.y)) {
        out.push({ x: p.x, y: p.y, radius: data.lanternPosts.radius });
        waiting.splice(i--, 1);
        grew = true;
      }
    }
  }
  return out;
}

/** Is a tile within any light (integer distance, tile centres)? */
export function isLit(lights: readonly Light[], x: number, y: number): boolean {
  return lights.some((l) => (x - l.x) * (x - l.x) + (y - l.y) * (y - l.y) <= l.radius * l.radius);
}

/** The materials the n-th lantern post of a homestead costs (0-based). */
export function postCost(n: number, data: HomesteadData = HOMESTEAD_DATA): Record<string, number> {
  const c = data.lanternPosts.costs;
  if (n < c.length) return { ...c[n].materials };
  const last = c[c.length - 1].materials;
  const out: Record<string, number> = {};
  for (const [m, v] of Object.entries(last)) out[m] = v + (data.lanternPosts.growth[m] ?? 0) * (n - c.length + 1);
  return out;
}

// ------------------------------------------------------------ served land

/** A served land grid (HomesteadLand) as kinds. Throws on a name it doesn't know. */
export function landFromCells(served: { width: number; height: number; cells: readonly string[] }): Land {
  if (served.cells.length !== served.width * served.height) throw new Error('land: cells do not fill the grid');
  const tiles = new Uint8Array(served.cells.length);
  served.cells.forEach((c, i) => {
    const k = (LAND_CELLS as readonly string[]).indexOf(c);
    if (k < 0) throw new Error(`land: unknown cell ${c}`);
    tiles[i] = k;
  });
  return { width: served.width, height: served.height, tiles };
}

/** Served lands, by world and gate; the current world is the one last remembered. */
const served = new Map<string, Land>();
let currentWorld = '';

/** Keep a gate's served land. */
export function rememberLand(worldId: string, gate: number, land: Land): void {
  served.set(`${worldId}:${gate}`, land);
  currentWorld = worldId;
}

/** A gate's served land (in this world, or the current one), or null until it has been read. */
export function servedLand(gate: number, worldId: string = currentWorld): Land | null {
  return served.get(`${worldId}:${gate}`) ?? null;
}
