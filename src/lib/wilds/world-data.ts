/**
 * Adapts generated chunk terrain to the game runtime's WorldData shape.
 * Rendering integration lands later; this keeps the terrain type honest in
 * the meantime. Note WorldData's `to` is typed as the curated AreaId union,
 * while wilds exits carry placeholder targets (`commons`,
 * `chunk:<regionId>:<cx>:<cy>`) the scene must resolve — see the report.
 */
import type { AreaId } from '../state.ts';
import type { WorldData } from '../../game/worlds.ts';
import { TILE } from '../../game/textures.ts';
import { TANGLE_ATLAS, tangleFrame } from '../../game/wilds/tangle-key.ts';
import { DECOR_ART } from './tangle.ts';
import type { ChunkTerrain } from './types.ts';

/** Flat decals (roots, litter, pebbles) sit just above the ground. */
const DECAL_DEPTH = -5;
/** Tint by how far a piece stands from open ground: the deep woods are darker. */
const DEPTH_TINT = [undefined, undefined, 0xc4c4cc, 0xa4a4b4] as const;

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
      key: TANGLE_ATLAS,
      frame: tangleFrame(d.kind, d.variant),
      x: d.tx * TILE + TILE / 2 + d.ox,
      y: (d.ty + 1) * TILE + d.oy,
      depth: DECOR_ART[d.kind].flat ? DECAL_DEPTH : 'y',
      flipX: d.flip,
      fade: d.overhang,
      tint: DEPTH_TINT[woodsDepth(chunk, d.tx, d.ty)],
    })),
    groundStyle: 'tangle',
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    emberSpots: [],
    spawn: chunk.spawn,
  };
}
