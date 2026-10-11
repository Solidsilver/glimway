/**
 * Walking speed by ground (open-map.md decisions 7 and 12): laid stone and
 * plank are a little faster, a ford's shallows half speed, everything else
 * as usual. The multipliers are content (`paths.walk`, per mille). The
 * server doesn't check movement and this adds no check.
 */
import { TERRAIN } from '../tile.ts';
import { loadWilds, wildsGround } from './data.ts';

const BY_TERRAIN = new Map<number, number>();
for (const w of loadWilds().paths.walk) {
  const t = (TERRAIN as Record<string, number>)[wildsGround(w.ground).terrain];
  if (t !== undefined) BY_TERRAIN.set(t, w.speedPermille / 1000);
}

/** The walking speed multiplier on a ground (a TERRAIN id; 1 for anything without one). */
export function walkFactor(terrain: number | null | undefined): number {
  return terrain === null || terrain === undefined ? 1 : BY_TERRAIN.get(terrain) ?? 1;
}
