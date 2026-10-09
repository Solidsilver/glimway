/**
 * Where a yard pet is (crafts.md 2.3): a pure function of the homestead's
 * seed and the clock, so every screen on the land agrees without a word on
 * the wire. No server rule reads a yard pet's place.
 *
 * - Time is cut into segments of 30 to 90 s, lengths drawn from
 *   `hash(landSeed, petKey, slot, …)`. To find "now" without walking back to
 *   the epoch, segments are laid inside fixed blocks of BLOCK_S seconds; the
 *   last segment of a block ends at the block's end.
 * - Each segment picks a target from the lit, walkable tiles; one in four is
 *   a nap, whose target is a lit tile beside a tree or the cottage, where the
 *   pet lies down once it arrives.
 * - Inside a segment the pet walks in a straight line from the previous
 *   target at WALK_PX_S, then stands (or naps). Pets aren't solid and don't
 *   path-find.
 */
import { hash } from './hash.ts';
import { HOMESTEAD_DATA, grownItem, rotatedFootprint, type HomeInstance, type HomesteadData } from './homestead.ts';
import { LAND, clearedSet, effectiveKind, homeLights, isLit, type Land } from './homestead-land.ts';
import { TILE } from './tile.ts';

export const SEGMENT_MIN_S = 30;
export const SEGMENT_MAX_S = 90;
/** Segments are laid inside blocks this long (every segment starts and ends inside one). */
export const BLOCK_S = 600;
/** Walking pace, px/s. */
export const WALK_PX_S = 30;
/** One segment in this many is a nap. */
export const NAP_EVERY = 4;

export type YardPose = 'walk' | 'stand' | 'nap';

export interface YardPetPlace {
  x: number;
  y: number;
  facing: 'left' | 'right';
  pose: YardPose;
}

/** The tiles a yard pet may target on one homestead (computed once per drawing). */
export interface YardTiles {
  seed: number;
  /** Lit, walkable tiles, in row order. */
  walk: [number, number][];
  /** Lit, walkable tiles beside a tree or the cottage (nap spots); falls back to `walk` when empty. */
  nap: [number, number][];
}

/** What of a homestead the tiles come from. */
export interface YardHome {
  landSeed: number;
  cleared: readonly [number, number][];
  items: readonly HomeInstance[];
  plants?: readonly { x: number; y: number }[];
}

/**
 * The lit, walkable tiles of a homestead: open ground (grass or path, a
 * cleared tile counts as grass) in lamplight, off the home site and every
 * placed outdoor piece. Nap tiles are those beside a standing tree or the
 * cottage (the home site's edge).
 */
export function yardTiles(home: YardHome, land: Land, data: HomesteadData = HOMESTEAD_DATA): YardTiles {
  const cleared = clearedSet(home.cleared);
  const lights = homeLights(home.items.filter((i) => i.itemDef === data.lanternPosts.item && i.scene === 'outdoor' && i.x !== null && i.y !== null) as { x: number; y: number }[], data);
  const blocked = new Set<string>();
  const site = data.land.site;
  for (let y = site.y; y < site.y + site.h; y++) for (let x = site.x; x < site.x + site.w; x++) blocked.add(`${x},${y}`);
  for (const it of home.items) {
    if (it.scene !== 'outdoor' || it.x === null || it.y === null) continue;
    const def = data.items.find((d) => d.id === it.itemDef);
    if (!def) continue;
    const [w, h] = rotatedFootprint(grownItem(def, it, data), it.rotation ?? 0);
    for (let y = it.y; y < it.y + h; y++) for (let x = it.x; x < it.x + w; x++) blocked.add(`${x},${y}`);
  }
  const walk: [number, number][] = [];
  const nap: [number, number][] = [];
  const inSite = (x: number, y: number) => x >= site.x && x < site.x + site.w && y >= site.y && y < site.y + site.h;
  const tree = (x: number, y: number) => x >= 0 && y >= 0 && x < land.width && y < land.height && effectiveKind(land, cleared, x, y) === LAND.TREE;
  for (let y = 1; y < land.height - 1; y++) {
    for (let x = 1; x < land.width - 1; x++) {
      const k = effectiveKind(land, cleared, x, y);
      if (k !== LAND.GRASS && k !== LAND.PATH) continue;
      if (blocked.has(`${x},${y}`) || !isLit(lights, x, y)) continue;
      walk.push([x, y]);
      const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tree(x + dx, y + dy) || inSite(x + dx, y + dy));
      if (beside) nap.push([x, y]);
    }
  }
  return { seed: home.landSeed, walk, nap: nap.length > 0 ? nap : walk };
}

export interface Segment {
  start: number;
  end: number;
  nap: boolean;
  tile: [number, number];
}

/** The segments of one block, in order (lengths 30–90 s; the last ends at the block's end). */
export function blockSegments(t: YardTiles, petKey: string, slot: number, block: number): Segment[] {
  const out: Segment[] = [];
  let at = block * BLOCK_S;
  const end = at + BLOCK_S;
  for (let j = 0; at < end; j++) {
    const h = hash([t.seed | 0, petKey, slot, block | 0, j]);
    // The rest of the block when it fits in one segment; else a length that leaves at least a segment's worth.
    const left = end - at;
    const most = Math.min(SEGMENT_MAX_S, left - SEGMENT_MIN_S);
    const len = left <= SEGMENT_MAX_S ? left : SEGMENT_MIN_S + (h % (most - SEGMENT_MIN_S + 1));
    const nap = (h >>> 8) % NAP_EVERY === 0;
    const pool = nap ? t.nap : t.walk;
    const tile = pool[hash([h, 'tile']) % pool.length];
    out.push({ start: at, end: at + len, nap, tile });
    at += len;
  }
  return out;
}

/** Tile centre (feet, a little below the middle), px. */
const spot = ([x, y]: [number, number]) => ({ x: x * TILE + TILE / 2, y: y * TILE + TILE - 3 });

/**
 * A yard pet at `now` (Unix seconds, the server's clock), or null when its
 * land has nowhere lit to stand.
 */
export function yardPetAt(t: YardTiles, petKey: string, slot: number, now: number): YardPetPlace | null {
  if (t.walk.length === 0) return null;
  const block = Math.floor(now / BLOCK_S);
  const segs = blockSegments(t, petKey, slot, block);
  let i = segs.findIndex((s) => now >= s.start && now < s.end);
  if (i < 0) i = segs.length - 1;
  const seg = segs[i];
  const prev = i > 0 ? segs[i - 1] : blockSegments(t, petKey, slot, block - 1).at(-1)!;
  const from = spot(prev.tile);
  const to = spot(seg.tile);
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const walkS = d / WALK_PX_S;
  const into = now - seg.start;
  const dir: 'left' | 'right' = to.x < from.x ? 'left' : to.x > from.x ? 'right' : hash([seg.start, petKey]) % 2 === 0 ? 'left' : 'right';
  if (into < walkS) {
    const k = into / walkS;
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, facing: dir, pose: 'walk' };
  }
  return { x: to.x, y: to.y, facing: dir, pose: seg.nap ? 'nap' : 'stand' };
}
