/**
 * A served Wilds chunk (server-first.md 3.2, open-map.md 2.2), unpacked for
 * drawing and collision: ground and solid grids, decor pieces, story sites,
 * entity bodies and the places whose landmark stands here; plus what the
 * scene builds from it, in world coordinates (scenery sprites and the
 * workable pieces).
 *
 * Chunks come only from the server (game/wilds/chunks.ts fetches, validates
 * and caches them); nothing here generates terrain.
 */
import { SiteKind as SiteKindPb, type WorldChunk } from '../../lib/gen/glimway/v1/wilds_pb.js';
import type { WildsEntityKind } from '../../lib/wilds/types.ts';
import type { SiteKind, StorySite } from '../../lib/wilds/outer.ts';
import { TERRAIN, tileBottom, tileKey, tileMid } from '../../lib/tile.ts';
import { loadWilds } from '../../lib/wilds/data.ts';
import type { GatherSpot, ScenerySpot } from '../worlds.ts';
import { DECOR_ART, isDecorKind, type DecorKind } from './decor.ts';
import { tangleFrame } from './tangle-key.ts';
import { lookAtlasKey } from './wilds-looks.ts';
import { LAMP_STONE_DARK, openMapDecor } from './open-map-art.ts';

export interface Tile {
  tx: number;
  ty: number;
}

export interface DecorSpot {
  kind: DecorKind;
  /** Anchor tile (chunk-local): the art stands on this tile's bottom edge, centred. */
  tx: number;
  ty: number;
  /** Pixel nudge from that anchor. */
  ox: number;
  oy: number;
  /** Art variant (0–7; the art seeds from it). */
  variant: number;
  /** Mirror the art (turncaps: lean east instead of west). */
  flip: boolean;
  /** The art overhangs a walkable tile, so it fades when someone walks beneath. */
  overhang: boolean;
}

/** A generated entity's immutable body (its changing state is in the near read). Tiles are chunk-local. */
export interface EntityBody {
  id: string;
  kind: WildsEntityKind;
  tx: number;
  ty: number;
  enemies: string[];
  material: string;
  tier: number;
  poi: string;
}

/** A cell's place whose landmark stands in this chunk (open-map.md 2.10). Tiles are chunk-local. */
export interface PlaceMark {
  id: string;
  kind: string;
  tx: number;
  ty: number;
}

export interface ChunkTerrain {
  epochId: string;
  cx: number;
  cy: number;
  /** Tiles a side. */
  size: number;
  /** Ground ids (TERRAIN), [ly][lx]. */
  ground: number[][];
  solid: boolean[][];
  decor: DecorSpot[];
  sites: StorySite[];
  entities: EntityBody[];
  places: PlaceMark[];
  /** 'outer': the deep drift's look; `mark` is its season's Mark (null when permanent). */
  look: 'tangle' | 'outer';
  mark: string | null;
  /** Difficulty tier and main land (content ids). */
  tier: number;
  land: string;
}

const SITE_KINDS: Record<number, SiteKind> = {
  [SiteKindPb.ECHO]: 'echo',
  [SiteKindPb.CAIRN]: 'cairn',
  [SiteKindPb.NEST]: 'nest',
  [SiteKindPb.PLANK]: 'plank',
  [SiteKindPb.GIVEN]: 'given',
  [SiteKindPb.REEDS]: 'reeds',
  [SiteKindPb.LAMP_STONE]: 'lamp-stone',
  [SiteKindPb.RUMOUR]: 'rumour',
};

/** Unpack a validated chunk (lib/api/chunks.ts decodeChunk). Throws on names this build can't draw. */
export function terrainOf(chunk: WorldChunk): ChunkTerrain {
  const S = chunk.size;
  const palette = chunk.palette.map((name) => {
    const id = (TERRAIN as Record<string, number>)[name];
    if (id === undefined) throw new Error(`wilds: unknown ground ${name}`);
    return id;
  });
  const ground: number[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < S; y++) {
    const g: number[] = [];
    const s: boolean[] = [];
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      g.push(palette[(chunk.ground[i >> 1]! >> (4 * (i & 1))) & 15]!);
      s.push(((chunk.solid[i >> 3]! >> (i & 7)) & 1) === 1);
    }
    ground.push(g);
    solid.push(s);
  }
  const d = chunk.decor!;
  const kinds = d.kinds.map((k) => {
    if (!isDecorKind(k)) throw new Error(`wilds: unknown decor ${k}`);
    return k;
  });
  const decor: DecorSpot[] = d.kind.map((k, i) => {
    const flags = d.flags[i >> 2]! >> (2 * (i & 3));
    return { kind: kinds[k]!, tx: d.tx[i]!, ty: d.ty[i]!, ox: d.ox[i]!, oy: d.oy[i]!, variant: d.variant[i]!, flip: (flags & 1) === 1, overhang: (flags & 2) === 2 };
  });
  return {
    epochId: chunk.epochId,
    cx: chunk.cx,
    cy: chunk.cy,
    size: S,
    ground,
    solid,
    decor,
    sites: chunk.sites.map((s) => ({ id: s.id, kind: SITE_KINDS[s.kind]!, cx: chunk.cx, cy: chunk.cy, tx: s.tx, ty: s.ty })),
    entities: chunk.entities.map((e) => ({ id: e.id, kind: e.kind as WildsEntityKind, tx: e.tx, ty: e.ty, enemies: [...e.enemies], material: e.material, tier: e.tier, poi: e.poi })),
    places: chunk.places.map((p) => ({ id: p.id, kind: p.kind, tx: p.tx, ty: p.ty })),
    look: chunk.look === 'outer' ? 'outer' : 'tangle',
    mark: chunk.mark || null,
    tier: chunk.tier,
    land: chunk.land,
  };
}

/** The chunk's first world tile (its north-west corner). */
export function chunkOrigin(chunk: Pick<ChunkTerrain, 'cx' | 'cy' | 'size'>): Tile {
  return { tx: chunk.cx * chunk.size, ty: chunk.cy * chunk.size };
}

// ------------------------------------------------------------ the scene's pieces

/**
 * Flat decals (roots, litter, pebbles) sit just above the ground: the open
 * map's floor is far below any y (world y is negative north of the gate).
 */
export const DECAL_DEPTH = -10_000_000 + 5;
/** Tint by how far a piece stands from open ground: the deep woods are darker. */
const DEPTH_TINT = [undefined, undefined, 0xc4c4cc, 0xa4a4b4] as const;

/** The decor kinds that are some place kind's landmark (seen from a chunk away, open-map.md 2.10). */
export const LANDMARK_KINDS: ReadonlySet<DecorKind> = new Set(loadWilds().placeKinds.map((k) => k.landmark).filter(isDecorKind));

/**
 * What each kind of woods piece is to work on (docs/items/crafting-and-repair.md,
 * "Gathering"): the content/gathering.json target its yields come from, said
 * in words. Pieces that aren't worked are left out. The Tangle's trees are
 * their own target (their Amberfall sap; content/gathering.json); the outer
 * drift's trees are plain trees (OUTER_TREE). A flower patch is a bloom
 * patch in Bloom-wick and an herb patch the rest of the year.
 */
export const GATHER_OF: Partial<Record<DecorKind, { target: string; label: string }>> = {
  oak: { target: 'tangle-tree', label: 'Chop the tree' },
  pine: { target: 'tangle-tree', label: 'Chop the tree' },
  birch: { target: 'tangle-tree', label: 'Chop the tree' },
  'iron-oak': { target: 'iron-oak', label: 'Chop the iron-oak' },
  snag: { target: 'willow', label: 'Chop the willow snag' },
  boulder: { target: 'boulder', label: 'Break the boulder' },
  cairn: { target: 'lamp-stone', label: 'Break the old lamp stone' },
  stump: { target: 'stump', label: 'Dig the stump' },
  'ring-stump': { target: 'stump', label: 'Dig the stump' },
  turncaps: { target: 'stump', label: 'Dig the turncaps' },
  flowers: { target: 'herbs', label: 'Dig the herb patch' },
  fern: { target: 'sapling', label: 'Dig for seedlings' },
  log: { target: 'hollow-tree', label: 'Dig the hollow log' },
};

/** The flowers' piece in Bloom-wick: the same patch, picked, not dug. */
const BLOOM_PATCH = { target: 'bloom-patch', label: 'Pick the bloom flowers' };
/** The outer drift's trees: timber, but no Amberfall sap ("on trees in the Tangle"). */
const OUTER_TREE = { target: 'tree', label: 'Chop the tree' };
const TREES: readonly DecorKind[] = ['oak', 'pine', 'birch'];

/**
 * The workable pieces of a chunk, in world tiles: one per tile, the standing
 * piece over the patch at its foot. `day` is the calendar day, for the
 * seasons' pieces.
 */
export function chunkGather(chunk: ChunkTerrain, day?: { wick: string } | null): GatherSpot[] {
  const atlas = lookAtlasKey(chunk.look, chunk.mark);
  const bloom = day?.wick === 'Bloom';
  const outer = chunk.look === 'outer';
  const of = (d: { kind: DecorKind }) =>
    bloom && d.kind === 'flowers' ? BLOOM_PATCH : outer && TREES.includes(d.kind) ? OUTER_TREE : GATHER_OF[d.kind];
  const byTile = new Map<string, DecorSpot>();
  for (const d of chunk.decor) {
    if (!of(d)) continue;
    const key = tileKey(d.tx, d.ty);
    const had = byTile.get(key);
    if (!had || (DECOR_ART[d.kind].blocking && !DECOR_ART[had.kind].blocking)) byTile.set(key, d);
  }
  const o = chunkOrigin(chunk);
  return [...byTile.values()].map((d) => {
    const g = of(d)!;
    return { target: g.target, label: g.label, tx: o.tx + d.tx, ty: o.ty + d.ty, art: { key: atlas, frame: tangleFrame(d.kind, d.variant) } };
  });
}

/** Chebyshev distance (capped at 3) from a tile to the nearest walkable one in the chunk. */
function woodsDepth(chunk: ChunkTerrain, tx: number, ty: number): number {
  for (let r = 0; r < 3; r++) {
    for (let y = ty - r; y <= ty + r; y++) {
      for (let x = tx - r; x <= tx + r; x++) {
        if (x < 0 || y < 0 || x >= chunk.size || y >= chunk.size) continue;
        if (!chunk.solid[y]![x]) return r;
      }
    }
  }
  return 3;
}

/**
 * A chunk's decor as scenery, in world pixels: the woods pieces from the
 * look's code-drawn atlas, the open map's pieces (meadow, bank stones,
 * landmarks) from their delivered art (./open-map-art.ts). A piece whose art
 * didn't load is left out, never stood in for. Every piece stands on its
 * tile's bottom edge; pieces that overhang a path fade when walked under.
 * A flat piece on open ground no work can take is a `decal`: it stands for
 * no tile, and the scene draws it baked with the chunk's others.
 */
export function chunkScenery(chunk: ChunkTerrain, has: (key: string) => boolean): ScenerySpot[] {
  const atlas = lookAtlasKey(chunk.look, chunk.mark);
  const o = chunkOrigin(chunk);
  const out: ScenerySpot[] = [];
  const kinds: DecorKind[] = [];
  for (const d of chunk.decor) {
    const tx = o.tx + d.tx;
    const ty = o.ty + d.ty;
    const delivered = openMapDecor(d.kind, d.variant);
    const key = delivered ?? atlas;
    if (delivered && !has(delivered)) continue;
    kinds.push(d.kind);
    out.push({
      key,
      ...(delivered ? {} : { frame: tangleFrame(d.kind, d.variant) }),
      x: tileMid(tx) + d.ox,
      y: tileBottom(ty) + d.oy,
      depth: DECOR_ART[d.kind].flat ? DECAL_DEPTH : 'y',
      flipX: d.flip,
      fade: d.overhang,
      tint: delivered ? undefined : DEPTH_TINT[woodsDepth(chunk, d.tx, d.ty)],
      tx,
      ty,
    });
  }
  markDecals(chunk, out, kinds);
  return out;
}

/**
 * Which flat pieces are decals: on open ground no work can take (no
 * workable piece on the tile, not solid), never fading, and overlapping no
 * flat piece they would swap places with when drawn together (another
 * texture's, or one that stays an image): the scene draws a texture's
 * decals together, so only pieces whose order among flat pieces can't show
 * are drawn that way. Footprints are the art's (content `decor` w and h),
 * a pixel wider each way.
 */
function markDecals(chunk: ChunkTerrain, spots: ScenerySpot[], kinds: readonly DecorKind[]): void {
  const o = chunkOrigin(chunk);
  const worked = new Set(chunk.decor.filter((d) => GATHER_OF[d.kind]).map((d) => tileKey(d.tx, d.ty)));
  const flat = spots.flatMap((s, i) => {
    if (s.depth !== DECAL_DEPTH) return [];
    const art = DECOR_ART[kinds[i]!];
    const lx = s.tx! - o.tx;
    const ly = s.ty! - o.ty;
    const open = !s.fade && !chunk.solid[ly]![lx] && !worked.has(tileKey(lx, ly));
    return [{ s, open, x0: s.x - art.w / 2 - 1, x1: s.x + art.w / 2 + 1, y0: s.y - art.h - 1, y1: s.y + 1 }];
  });
  type Flat = (typeof flat)[number];
  const overlap = (a: Flat, b: Flat) => a !== b && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  // Settle it: a piece kept as an image can stop a neighbour being a decal.
  let decals = flat.filter((f) => f.open);
  for (let changed = true; changed; ) {
    const set = new Set(decals);
    const next = decals.filter((f) => !flat.some((g) => overlap(f, g) && (!set.has(g) || g.s.key !== f.s.key)));
    changed = next.length !== decals.length;
    decals = next;
  }
  for (const f of decals) f.s.decal = true;
}

/** The chunk's landmark pieces (drawn from a chunk away), as scenery in world pixels. */
export function chunkLandmarks(chunk: ChunkTerrain, has: (key: string) => boolean): (ScenerySpot & { place: string | null })[] {
  const o = chunkOrigin(chunk);
  const out: (ScenerySpot & { place: string | null })[] = [];
  for (const d of chunk.decor) {
    if (!LANDMARK_KINDS.has(d.kind)) continue;
    const key = openMapDecor(d.kind, d.variant);
    if (!key || !has(key)) continue;
    const place = chunk.places.find((p) => p.tx === d.tx && p.ty === d.ty)?.id ?? null;
    out.push({ key, x: tileMid(o.tx + d.tx) + d.ox, y: tileBottom(o.ty + d.ty) + d.oy, depth: 'y', flipX: d.flip, tx: o.tx + d.tx, ty: o.ty + d.ty, place });
  }
  // The Lantern Road's dark lamp stones count too (open-map.md 2.10).
  for (const site of chunk.sites) {
    if (site.kind !== 'lamp-stone' || !has(LAMP_STONE_DARK)) continue;
    out.push({ key: LAMP_STONE_DARK, x: tileMid(o.tx + site.tx), y: tileBottom(o.ty + site.ty), depth: 'y', tx: o.tx + site.tx, ty: o.ty + site.ty, place: null });
  }
  return out;
}


// ------------------------------------------------------------ world changes

const terrainId = (groundId: string): number => {
  const t = (TERRAIN as Record<string, number>)[loadWilds().grounds.find((g) => g.id === groundId)?.terrain ?? ''];
  if (t === undefined) throw new Error(`wilds: ground ${groundId} has no terrain`);
  return t;
};
/** The ground a laid change carries (content `paths.lay`: stone → laid-stone, plank → laid-plank). */
const LAID = new Map(loadWilds().paths.lay.map((l) => [l.kind, terrainId(l.ground)]));

/**
 * A chunk with its player-made changes applied (open-map.md section 3, the
 * client's twin of `wilds.Effective`): a cleared tile is walkable and its
 * standing piece is gone; a laid tile carries laid stone or plank. Tiles are
 * chunk-local. The chunk itself is never changed.
 */
export function effectiveTerrain(t: ChunkTerrain, changes: readonly { tx: number; ty: number; change: string }[]): ChunkTerrain {
  if (!changes.length) return t;
  const ground = t.ground.map((row) => [...row]);
  const solid = t.solid.map((row) => [...row]);
  const cleared = new Set<string>();
  for (const c of changes) {
    if (c.tx < 0 || c.ty < 0 || c.tx >= t.size || c.ty >= t.size) continue;
    const laid = LAID.get(c.change);
    if (c.change === 'cleared' || laid !== undefined) {
      if (solid[c.ty]![c.tx]) cleared.add(tileKey(c.tx, c.ty));
      solid[c.ty]![c.tx] = false;
    }
    if (laid !== undefined) ground[c.ty]![c.tx] = laid;
  }
  const decor = cleared.size ? t.decor.filter((d) => !(DECOR_ART[d.kind].blocking && cleared.has(tileKey(d.tx, d.ty)))) : t.decor;
  return { ...t, ground, solid, decor };
}
