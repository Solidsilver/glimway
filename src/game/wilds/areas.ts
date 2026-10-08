/**
 * Wilds area kinds. Each chunk of a region (the Tangle, the outer Wilds) is
 * an area kind built from its served chunk (game/wilds/chunks.ts, via
 * `toWorldData`); `wilds` resolves to the Tangle's entry chunk. Exits carry
 * the server's raw targets — `chunk:<regionId>:<cx>:<cy>` between neighbours
 * and over the crossing, `commons` on the Tangle's entry chunk — which
 * WorldScene's transitions resolve (WorldScene.transitionTo keeps
 * `area: 'wilds'` and region-wide pixels for chunk targets).
 *
 * Registered per epoch, once the region read has named it and its chunks
 * have loaded (game/wilds/store.ts refreshWilds): building a chunk scene
 * never waits on the network.
 */
import { toWorldData } from './terrain.ts';
import type { AreaId } from '../../lib/state.ts';
import { calendarAt } from '../../lib/calendar.ts';
import { registerAreaKind, type AreaKind, type ForegroundSpot } from '../worlds.ts';
import { gameNow } from '../clock.ts';
import { WILDS_AREA, WILDS_REGION_ID, chunkAreaId, wildsRegion } from './regions.ts';
import { cachedTerrain } from './chunks.ts';
import type { WildsEpoch } from './store.ts';

/**
 * No delivered occluders: the Tangle's trees are code-drawn scenery
 * (src/game/wilds/tangle-art.ts), and the ones that overhang a path fade
 * through the generic foreground pass.
 */
function wildsForeground(): ForegroundSpot[] {
  return [];
}

function wildsKind(epoch: WildsEpoch, cx: number, cy: number): AreaKind {
  const areaId = chunkAreaId(cx, cy, epoch.regionId);
  return {
    build: () => {
      const chunk = cachedTerrain(epoch.id, cx, cy);
      if (!chunk) throw new Error(`wilds: chunk ${cx},${cy} of ${epoch.id} is not loaded`);
      // The calendar day decides the seasons' pieces (bloom patches in
      // Bloom-wick); the server re-checks the season from its own clock.
      return toWorldData(chunk, areaId, calendarAt(gameNow()));
    },
    foreground: wildsForeground,
  };
}

/**
 * Register every chunk area of the epoch's region; for the Tangle also
 * `wilds` (its entry chunk — what the Commons' exit targets). Idempotent;
 * the newest epoch of a region wins.
 */
export function registerWildsAreas(epoch: WildsEpoch): void {
  const region = wildsRegion(epoch.regionId);
  for (let cy = 0; cy < region.gridHeight; cy++) {
    for (let cx = 0; cx < region.gridWidth; cx++) {
      register(chunkAreaId(cx, cy, epoch.regionId), epoch, cx, cy);
    }
  }
  if (epoch.regionId === WILDS_REGION_ID) register(WILDS_AREA, epoch, region.entryX, region.entryY);
}

function register(areaId: AreaId, epoch: WildsEpoch, cx: number, cy: number): void {
  registerAreaKind(areaId, wildsKind(epoch, cx, cy));
}
