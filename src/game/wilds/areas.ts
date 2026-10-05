/**
 * Wilds area kinds. Each chunk of the region is an area kind built from the
 * generator library's `chunkTerrain` (via `toWorldData`); `wilds` resolves to
 * the region's entry chunk. Exits carry the generator's raw targets —
 * `chunk:<regionId>:<cx>:<cy>` between neighbors and `commons` on the entry
 * chunk — which WorldScene's transitions resolve (WorldScene.transitionTo
 * keeps `area: 'wilds'` and region-wide pixels for chunk targets).
 *
 * Registered per epoch (guests: a fixed local epoch; connected: the server's
 * frozen epoch), because terrain seeds come from the epoch's world seed.
 */
import { chunkTerrain, toWorldData } from '../../lib/wilds/index.ts';
import type { Epoch } from '../../lib/wilds/types.ts';
import type { AreaId } from '../../lib/state.ts';
import { registerAreaKind, type AreaKind, type ForegroundSpot } from '../worlds.ts';
import { WILDS_AREA, WILDS_REGION_ID, chunkAreaId, wildsRegion } from './regions.ts';

/**
 * No delivered occluders: the Tangle's trees are code-drawn scenery
 * (src/game/wilds/tangle-art.ts), and the ones that overhang a path fade
 * through the generic foreground pass.
 */
function wildsForeground(): ForegroundSpot[] {
  return [];
}

function wildsKind(epoch: Epoch, cx: number, cy: number): AreaKind {
  const areaId = chunkAreaId(cx, cy);
  return {
    build: () => {
      const chunk = chunkTerrain(epoch, cx, cy);
      // WorldData's exits keep the generator's raw targets (`chunk:…`,
      // `commons`); the scene resolves them into transitions.
      return toWorldData(chunk, areaId);
    },
    foreground: wildsForeground,
  };
}

/**
 * Register `wilds` (the region's entry chunk — what the Commons' exit
 * targets) and every chunk area. Idempotent; the newest epoch wins.
 */
export function registerWildsAreas(epoch: Epoch): void {
  const region = wildsRegion();
  for (let cy = 0; cy < region.gridHeight; cy++) {
    for (let cx = 0; cx < region.gridWidth; cx++) {
      register(chunkAreaId(cx, cy), epoch, cx, cy);
    }
  }
  register(WILDS_AREA, epoch, region.entryX, region.entryY);
}

function register(areaId: AreaId, epoch: Epoch, cx: number, cy: number): void {
  registerAreaKind(areaId, wildsKind(epoch, cx, cy));
}

/** Guard so tests can assert the region id this module is built for. */
export const wildsAreaRegionId = WILDS_REGION_ID;
