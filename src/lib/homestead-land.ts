/**
 * A homestead's wild land, generated the same way on the client and the
 * server (server/internal/land): integer-only, from the Wilds hash and PRNG
 * (./wilds/hash.ts), so the server can validate placement against the very
 * trees and rocks the player sees.
 *
 * Spec (generator 1; re-implementable from this description):
 *
 *   seed = hash(worldId, "homestead-land", generator, gate)  (the world's id: public, known to guests as "guest")
 *   rng  = Rng(seed)
 *   every tile GRASS; the border ring EDGE, except the gate mouth on the
 *   south edge (x in [gate.x, gate.x+gate.w)), which is PATH, as is the
 *   corridor from there up to the home site's bottom row.
 *   protected(x, y): the home site grown by one tile, or the corridor grown
 *   by one tile sideways (rows from the site's bottom down).
 *   stream: if rng.nextInt(1000) < streamPermille:
 *     side = rng.nextInt(2); [lo, hi] = side 0 ? [2, 9] : [W-10, W-3]
 *     x = lo + rng.nextInt(hi-lo+1); ford = 3 + rng.nextInt(H-6)
 *     for y in 1..H-2:
 *       if GRASS and not protected: WATER (FORD on the ford row)
 *       r = rng.nextInt(4); r=0 and x>lo: x-1; r=1 and x<hi: x+1
 *   slope: if rng.nextInt(1000) < slopePermille:
 *     y0 = 2 + rng.nextInt(3); x0 = 2 + rng.nextInt(floor(W/3)); len = 8 + rng.nextInt(10)
 *     rows y0, y0+1, x in [x0, min(x0+len, W-2)): GRASS and not protected → SLOPE
 *   scatter trees, then stumps, then boulders: for each attempt,
 *     x = 1 + rng.nextInt(W-2), y = 1 + rng.nextInt(H-2);
 *     GRASS and not protected → that kind (a failed attempt is not retried).
 */
import { HOMESTEAD_DATA, type HomesteadData } from './homestead.ts';
import { Rng, hash } from './wilds/hash.ts';

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
export type LandKind = (typeof LAND)[keyof typeof LAND];

/** One character per kind, for parity vectors and debugging. */
export const LAND_CHARS = '.TSBw~/#=';

export type LandConfig = HomesteadData['land'];

export interface Land {
  width: number;
  height: number;
  /** Row-major kinds. */
  tiles: Uint8Array;
}

/** The land seed for a gate in a world. */
export function landSeed(worldId: string, gate: number, cfg: LandConfig = HOMESTEAD_DATA.land): number {
  return hash([worldId, 'homestead-land', cfg.generator, gate]);
}

export function generateLand(seed: number, cfg: LandConfig = HOMESTEAD_DATA.land): Land {
  const W = cfg.width;
  const H = cfg.height;
  const tiles = new Uint8Array(W * H);
  const at = (x: number, y: number) => tiles[y * W + x];
  const put = (x: number, y: number, k: number) => {
    tiles[y * W + x] = k;
  };
  const site = cfg.site;
  const gate = cfg.gate;
  const siteBottom = site.y + site.h;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      put(x, y, border ? LAND.EDGE : LAND.GRASS);
    }
  for (let y = siteBottom; y < H; y++) for (let x = gate.x; x < gate.x + gate.w; x++) put(x, y, LAND.PATH);
  const isProtected = (x: number, y: number) =>
    (x >= site.x - 1 && x <= site.x + site.w && y >= site.y - 1 && y <= siteBottom) ||
    (x >= gate.x - 1 && x <= gate.x + gate.w && y >= siteBottom);

  const rng = new Rng(seed);
  if (rng.nextInt(1000) < cfg.streamPermille) {
    const side = rng.nextInt(2);
    const [lo, hi] = side === 0 ? [2, 9] : [W - 10, W - 3];
    let x = lo + rng.nextInt(hi - lo + 1);
    const ford = 3 + rng.nextInt(H - 6);
    for (let y = 1; y < H - 1; y++) {
      if (at(x, y) === LAND.GRASS && !isProtected(x, y)) put(x, y, y === ford ? LAND.FORD : LAND.WATER);
      const r = rng.nextInt(4);
      if (r === 0 && x > lo) x -= 1;
      else if (r === 1 && x < hi) x += 1;
    }
  }
  if (rng.nextInt(1000) < cfg.slopePermille) {
    const y0 = 2 + rng.nextInt(3);
    const x0 = 2 + rng.nextInt(Math.floor(W / 3));
    const len = 8 + rng.nextInt(10);
    const x1 = Math.min(x0 + len, W - 2);
    for (let y = y0; y <= y0 + 1; y++) for (let x = x0; x < x1; x++) if (at(x, y) === LAND.GRASS && !isProtected(x, y)) put(x, y, LAND.SLOPE);
  }
  const scatter = (n: number, kind: number) => {
    for (let i = 0; i < n; i++) {
      const x = 1 + rng.nextInt(W - 2);
      const y = 1 + rng.nextInt(H - 2);
      if (at(x, y) === LAND.GRASS && !isProtected(x, y)) put(x, y, kind);
    }
  };
  scatter(cfg.trees, LAND.TREE);
  scatter(cfg.stumps, LAND.STUMP);
  scatter(cfg.boulders, LAND.BOULDER);
  return { width: W, height: H, tiles };
}

/** The land as text rows (one char per tile, see LAND_CHARS). */
export function landRows(land: Land): string[] {
  const out: string[] = [];
  for (let y = 0; y < land.height; y++) {
    let row = '';
    for (let x = 0; x < land.width; x++) row += LAND_CHARS[land.tiles[y * land.width + x]];
    out.push(row);
  }
  return out;
}

export function landAt(land: Land, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= land.width || y >= land.height) return LAND.EDGE;
  return land.tiles[y * land.width + x];
}

/** Obstacles Silas can clear for embers (trees, stumps, boulders). */
export function clearable(kind: number): boolean {
  return kind === LAND.TREE || kind === LAND.STUMP || kind === LAND.BOULDER;
}

const key = (x: number, y: number) => `${x},${y}`;

/** What stands on a tile once cleared tiles are taken into account. */
export function effectiveKind(land: Land, cleared: ReadonlySet<string>, x: number, y: number): number {
  const k = landAt(land, x, y);
  return clearable(k) && cleared.has(key(x, y)) ? LAND.GRASS : k;
}

/** Can the hero walk here? */
export function walkable(kind: number): boolean {
  return kind === LAND.GRASS || kind === LAND.PATH || kind === LAND.FORD || kind === LAND.SLOPE;
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

/** The lights holding a homestead's ground: the start light plus every placed post. */
export function homeLights(posts: readonly { x: number; y: number }[], data: HomesteadData = HOMESTEAD_DATA): Light[] {
  const s = data.land.startLight;
  return [{ x: s.x, y: s.y, radius: s.radius }, ...posts.map((p) => ({ x: p.x, y: p.y, radius: data.lanternPosts.radius }))];
}

/** Is a tile within any light (integer distance, tile centres)? */
export function isLit(lights: readonly Light[], x: number, y: number): boolean {
  return lights.some((l) => (x - l.x) * (x - l.x) + (y - l.y) * (y - l.y) <= l.radius * l.radius);
}

/** The materials the n-th lantern post of a homestead costs (0-based). */
export function postCost(n: number, data: HomesteadData = HOMESTEAD_DATA): Record<string, number> {
  const c = data.lanternPosts.costs;
  if (n < c.length) return { ...c[n] };
  const last = c[c.length - 1];
  const out: Record<string, number> = {};
  for (const [m, v] of Object.entries(last)) out[m] = v + (data.lanternPosts.growth[m] ?? 0) * (n - c.length + 1);
  return out;
}
