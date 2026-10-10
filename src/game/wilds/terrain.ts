/**
 * A served Wilds chunk (server-first.md 3.2), unpacked for drawing and
 * collision: ground and solid grids, decor pieces, exits, story sites and
 * entity bodies, plus the adapter to the game runtime's WorldData shape.
 *
 * Chunks come only from the server (game/wilds/chunks.ts fetches, validates
 * and caches them); nothing here generates terrain.
 */
import { Dir, SiteKind as SiteKindPb, type WildsChunk } from '../../lib/gen/glimway/v1/wilds_pb.js';
import type { AreaId } from '../../lib/state.ts';
import type { WildsEntityKind } from '../../lib/wilds/types.ts';
import type { SiteKind, StorySite } from '../../lib/wilds/outer.ts';
import { TERRAIN, TILE, tileBottom, tileKey, tileMid } from '../../lib/tile.ts';
import type { GatherSpot, WorldData } from '../worlds.ts';
import { DECOR_ART, isDecorKind, type DecorKind } from './decor.ts';
import { tangleFrame } from './tangle-key.ts';
import { lookAtlasKey } from './wilds-looks.ts';

export type ExitDir = 'north' | 'east' | 'south' | 'west';

export interface Tile {
  tx: number;
  ty: number;
}

/** A chunk exit: `to` is `commons` or `chunk:<region>:<cx>:<cy>`; `entry` is in the destination's tiles. */
export interface ChunkExit {
  tx: number;
  ty: number;
  tw: number;
  th: number;
  to: string;
  entry: Tile;
  dir: ExitDir;
}

export interface DecorSpot {
  kind: DecorKind;
  /** Anchor tile: the art stands on this tile's bottom edge, centred. */
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

/** A generated entity's immutable body (its changing state is in the region read). */
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

export interface ChunkTerrain {
  epochId: string;
  regionId: string;
  cx: number;
  cy: number;
  width: number;
  height: number;
  widthPx: number;
  heightPx: number;
  /** Ground ids (TERRAIN), [ty][tx]. */
  ground: number[][];
  solid: boolean[][];
  decor: DecorSpot[];
  exits: ChunkExit[];
  spawn: Tile;
  sites: StorySite[];
  entities: EntityBody[];
  /** 'outer': the deep drift's look; `mark` is its season's Mark (null when permanent). */
  look: 'tangle' | 'outer';
  mark: string | null;
}

const DIRS: Record<number, ExitDir> = { [Dir.NORTH]: 'north', [Dir.EAST]: 'east', [Dir.SOUTH]: 'south', [Dir.WEST]: 'west' };
const SITE_KINDS: Record<number, SiteKind> = {
  [SiteKindPb.ECHO]: 'echo',
  [SiteKindPb.CAIRN]: 'cairn',
  [SiteKindPb.NEST]: 'nest',
  [SiteKindPb.PLANK]: 'plank',
  [SiteKindPb.GIVEN]: 'given',
  [SiteKindPb.REEDS]: 'reeds',
};

/** Unpack a validated chunk (lib/api/chunks.ts decodeChunk). Throws on names this build can't draw. */
export function terrainOf(chunk: WildsChunk): ChunkTerrain {
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
    regionId: chunk.region,
    cx: chunk.cx,
    cy: chunk.cy,
    width: S,
    height: S,
    widthPx: S * TILE,
    heightPx: S * TILE,
    ground,
    solid,
    decor,
    exits: chunk.exits.map((e) => ({ tx: e.tx, ty: e.ty, tw: e.tw, th: e.th, to: e.to, entry: { tx: e.entry!.tx, ty: e.entry!.ty }, dir: DIRS[e.dir]! })),
    spawn: { tx: chunk.spawn!.tx, ty: chunk.spawn!.ty },
    sites: chunk.sites.map((s) => ({ id: s.id, kind: SITE_KINDS[s.kind]!, cx: chunk.cx, cy: chunk.cy, tx: s.tx, ty: s.ty })),
    entities: chunk.entities.map((e) => ({ id: e.id, kind: e.kind as WildsEntityKind, tx: e.tx, ty: e.ty, enemies: [...e.enemies], material: e.material, tier: e.tier, poi: e.poi })),
    look: chunk.look === 'outer' ? 'outer' : 'tangle',
    mark: chunk.mark || null,
  };
}

// ------------------------------------------------------------ WorldData

/** Flat decals (roots, litter, pebbles) sit just above the ground. */
const DECAL_DEPTH = -5;
/** Tint by how far a piece stands from open ground: the deep woods are darker. */
const DEPTH_TINT = [undefined, undefined, 0xc4c4cc, 0xa4a4b4] as const;

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
  cairn: { target: 'lamp-stone', label: 'Break the old lamp-stone' },
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
 * The workable pieces of a chunk: one per tile, the standing piece over the
 * patch at its foot. `day` is the calendar day, for the seasons' pieces.
 */
function gatherSpots(chunk: ChunkTerrain, atlas: string, day?: { wick: string } | null): GatherSpot[] {
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
  return [...byTile.values()].map((d) => {
    const g = of(d)!;
    return { target: g.target, label: g.label, tx: d.tx, ty: d.ty, art: { key: atlas, frame: tangleFrame(d.kind, d.variant) } };
  });
}

/** Chebyshev distance (capped at 3) from a tile to the nearest walkable one. */
function woodsDepth(chunk: ChunkTerrain, tx: number, ty: number): number {
  for (let r = 0; r < 3; r++) {
    for (let y = ty - r; y <= ty + r; y++) {
      for (let x = tx - r; x <= tx + r; x++) {
        if (x < 0 || y < 0 || x >= chunk.width || y >= chunk.height) continue;
        if (!chunk.solid[y]![x]) return r;
      }
    }
  }
  return 3;
}

export function toWorldData(chunk: ChunkTerrain, areaId: AreaId, day?: { wick: string } | null): WorldData {
  const atlas = lookAtlasKey(chunk.look, chunk.mark);
  return {
    areaId,
    width: chunk.width,
    height: chunk.height,
    widthPx: chunk.widthPx,
    heightPx: chunk.heightPx,
    ground: chunk.ground,
    solid: chunk.solid,
    trees: [],
    bushes: [],
    rocks: [],
    npcs: [],
    enemies: [],
    // Exits keep the server's raw targets (`chunk:…`, `commons`); the scene resolves them.
    exits: chunk.exits.map((e) => ({ tx: e.tx, ty: e.ty, tw: e.tw, th: e.th, to: e.to as AreaId, entry: e.entry })),
    props: [],
    discoverySpots: [],
    // The woods: every decor piece is code-drawn scenery standing on its
    // tile's bottom edge; pieces that overhang a path fade when walked under.
    scenery: chunk.decor.map((d) => ({
      key: atlas,
      frame: tangleFrame(d.kind, d.variant),
      x: tileMid(d.tx) + d.ox,
      y: tileBottom(d.ty) + d.oy,
      depth: DECOR_ART[d.kind].flat ? DECAL_DEPTH : 'y',
      flipX: d.flip,
      fade: d.overhang,
      tint: DEPTH_TINT[woodsDepth(chunk, d.tx, d.ty)],
      tx: d.tx,
      ty: d.ty,
    })),
    gathering: gatherSpots(chunk, atlas, day),
    storySites: chunk.sites.map((s) => ({ id: s.id, kind: s.kind, tx: s.tx, ty: s.ty })),
    groundStyle: chunk.look,
    groundMark: chunk.mark,
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    glimSpots: [],
    spawn: chunk.spawn,
  };
}
