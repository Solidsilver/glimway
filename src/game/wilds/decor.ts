/**
 * The Wilds' drawing vocabulary: the decor kinds the server's generator
 * places (server/internal/wilds/woods_v2.go), their art footprints, and the
 * ground ids a chunk paints with. Chunks name both by string (a chunk's
 * `palette` and `decor.kinds`); these tables are what the art reads them as.
 */
import { TERRAIN } from '../../lib/tile.ts';

export type DecorKind =
  | 'oak'
  | 'pine'
  | 'birch'
  | 'iron-oak'
  | 'snag'
  | 'thicket'
  | 'stump'
  | 'ring-stump'
  | 'log'
  | 'boulder'
  | 'cairn'
  | 'fern'
  | 'grass'
  | 'flowers'
  | 'turncaps'
  | 'reeds'
  | 'roots'
  | 'litter'
  | 'pebbles';

/** Ground ids the Wilds paint with (the ground art reads them back). */
export const TANGLE_GROUND = {
  /** Under the trees: dark loam, moss and leaf litter. */
  woods: TERRAIN.grass_b,
  /** Walkable moss in clearings and glades. */
  moss: TERRAIN.grass_a,
  /** The trodden line of a path. */
  path: TERRAIN.path_a,
  /** Walkable verge beside a path's trodden line (moss, worn at the middle). */
  verge: TERRAIN.path_b,
  /** Bare, trodden earth around camps. */
  trodden: TERRAIN.dirt,
  /** Broken cobbles of the old road. */
  road: TERRAIN.cobble_moss,
  /** Still water (a backwater of the Wend): solid. */
  water: TERRAIN.water_a,
} as const;

/**
 * Art footprint per decor kind, in px: width centred on the anchor and
 * height above it. `blocking` pieces only ever stand on solid tiles; `flat`
 * ones are ground decals drawn under everything.
 */
export const DECOR_ART: Record<DecorKind, { w: number; h: number; blocking: boolean; flat: boolean }> = {
  oak: { w: 30, h: 32, blocking: true, flat: false },
  pine: { w: 22, h: 36, blocking: true, flat: false },
  birch: { w: 22, h: 32, blocking: true, flat: false },
  'iron-oak': { w: 40, h: 42, blocking: true, flat: false },
  snag: { w: 18, h: 28, blocking: true, flat: false },
  thicket: { w: 24, h: 18, blocking: true, flat: false },
  stump: { w: 18, h: 14, blocking: true, flat: false },
  'ring-stump': { w: 22, h: 14, blocking: true, flat: false },
  log: { w: 32, h: 13, blocking: true, flat: false },
  boulder: { w: 20, h: 15, blocking: true, flat: false },
  cairn: { w: 14, h: 21, blocking: true, flat: false },
  fern: { w: 15, h: 11, blocking: false, flat: false },
  grass: { w: 11, h: 9, blocking: false, flat: false },
  flowers: { w: 11, h: 7, blocking: false, flat: false },
  turncaps: { w: 13, h: 9, blocking: false, flat: false },
  reeds: { w: 14, h: 15, blocking: false, flat: false },
  roots: { w: 16, h: 12, blocking: false, flat: true },
  litter: { w: 14, h: 9, blocking: false, flat: true },
  pebbles: { w: 11, h: 7, blocking: false, flat: true },
};

export function isDecorKind(k: string): k is DecorKind {
  return Object.hasOwn(DECOR_ART, k);
}

/** Smooth 2D value noise in 0..1 (one octave, smoothstep-interpolated), for the ground art. */
export function valueNoise(seed: number): (x: number, y: number) => number {
  const lattice = (x: number, y: number): number => {
    let v = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = lattice(x0, y0) + (lattice(x0 + 1, y0) - lattice(x0, y0)) * sx;
    const b = lattice(x0, y0 + 1) + (lattice(x0 + 1, y0 + 1) - lattice(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}
