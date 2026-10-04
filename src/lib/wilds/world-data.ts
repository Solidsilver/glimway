/**
 * Adapts generated chunk terrain to the game runtime's WorldData shape.
 * Rendering integration lands later; this keeps the terrain type honest in
 * the meantime. Note WorldData's `to` is typed as the curated AreaId union,
 * while wilds exits carry placeholder targets (`commons`,
 * `chunk:<regionId>:<cx>:<cy>`) the scene must resolve — see the report.
 */
import type { AreaId } from '../state.ts';
import type { WorldData } from '../../game/worlds.ts';
import type { ChunkTerrain } from './types.ts';

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
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    emberSpots: [],
    spawn: chunk.spawn,
  };
}
