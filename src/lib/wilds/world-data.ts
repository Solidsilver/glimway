/**
 * Adapts generated chunk terrain to the game runtime's WorldData shape.
 * Rendering integration lands later; this keeps the terrain type honest in
 * the meantime. Note WorldData's `to` is typed as the curated AreaId union,
 * while wilds exits carry placeholder targets (`commons`,
 * `chunk:<regionId>:<cx>:<cy>`) the scene must resolve — see the report.
 */
import type { AreaId } from '../state.ts';
import type { GatherSpot, WorldData } from '../../game/worlds.ts';
import { TILE } from '../../game/textures.ts';
import { tangleFrame } from '../../game/wilds/tangle-key.ts';
import { lookAtlasKey } from '../../game/wilds/wilds-looks.ts';
import { DECOR_ART } from './tangle.ts';
import type { ChunkTerrain, DecorKind } from './types.ts';

/** Flat decals (roots, litter, pebbles) sit just above the ground. */
const DECAL_DEPTH = -5;
/** Tint by how far a piece stands from open ground: the deep woods are darker. */
const DEPTH_TINT = [undefined, undefined, 0xc4c4cc, 0xa4a4b4] as const;

/**
 * What each kind of woods piece is to work on (docs/items/crafting-and-repair.md,
 * "Gathering"): the content/gathering.json target its yields come from, said
 * in words. Pieces that aren't worked are left out.
 */
export const GATHER_OF: Partial<Record<DecorKind, { target: string; label: string }>> = {
  oak: { target: 'tree', label: 'Chop the tree' },
  pine: { target: 'tree', label: 'Chop the tree' },
  birch: { target: 'tree', label: 'Chop the tree' },
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

/**
 * The workable pieces of a chunk (trees, boulders, stumps, patches): one
 * per tile, the standing piece over the patch at its foot (working a tile
 * fells what's drawn there).
 */
function gatherSpots(chunk: ChunkTerrain, atlas: string): GatherSpot[] {
  const byTile = new Map<string, (typeof chunk.decor)[number]>();
  for (const d of chunk.decor) {
    if (!GATHER_OF[d.kind]) continue;
    const key = `${d.tx},${d.ty}`;
    const had = byTile.get(key);
    if (!had || (DECOR_ART[d.kind].blocking && !DECOR_ART[had.kind].blocking)) byTile.set(key, d);
  }
  return [...byTile.values()].map((d) => ({ target: GATHER_OF[d.kind]!.target, label: GATHER_OF[d.kind]!.label, tx: d.tx, ty: d.ty, art: { key: atlas, frame: tangleFrame(d.kind, d.variant) } }));
}

/** Chebyshev distance (capped at 3) from a tile to the nearest walkable one. */
function woodsDepth(chunk: ChunkTerrain, tx: number, ty: number): number {
  for (let r = 0; r < 3; r++) {
    for (let y = ty - r; y <= ty + r; y++) {
      for (let x = tx - r; x <= tx + r; x++) {
        if (x < 0 || y < 0 || x >= chunk.width || y >= chunk.height) continue;
        if (!chunk.solid[y][x]) return r;
      }
    }
  }
  return 3;
}

export function toWorldData(chunk: ChunkTerrain, areaId: AreaId): WorldData {
  const atlas = lookAtlasKey(chunk.look, chunk.mark);
  return {
    areaId,
    width: chunk.width,
    height: chunk.height,
    widthPx: chunk.widthPx,
    heightPx: chunk.heightPx,
    ground: chunk.ground,
    solid: chunk.solid,
    trees: chunk.trees,
    bushes: chunk.bushes,
    rocks: chunk.rocks,
    npcs: [],
    enemies: [],
    exits: chunk.exits.map((e) => ({
      tx: e.tx,
      ty: e.ty,
      tw: e.tw,
      th: e.th,
      to: e.to as AreaId,
      entry: e.entry,
    })),
    props: [],
    discoverySpots: [],
    // The woods: every decor piece is code-drawn scenery standing on its
    // tile's bottom edge; pieces that overhang a path fade when walked under.
    scenery: chunk.decor.map((d) => ({
      key: atlas,
      frame: tangleFrame(d.kind, d.variant),
      x: d.tx * TILE + TILE / 2 + d.ox,
      y: (d.ty + 1) * TILE + d.oy,
      depth: DECOR_ART[d.kind].flat ? DECAL_DEPTH : 'y',
      flipX: d.flip,
      fade: d.overhang,
      tint: DEPTH_TINT[woodsDepth(chunk, d.tx, d.ty)],
      tx: d.tx,
      ty: d.ty,
    })),
    gathering: gatherSpots(chunk, atlas),
    storySites: chunk.sites.map((s) => ({ id: s.id, kind: s.kind, tx: s.tx, ty: s.ty })),
    groundStyle: chunk.look,
    groundMark: chunk.mark,
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    emberSpots: [],
    spawn: chunk.spawn,
  };
}
