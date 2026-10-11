/**
 * The Wilds' drawing vocabulary: the decor kinds the server's generator
 * places and the ground ids a chunk paints with. Both lists, and the decor
 * art footprints, are content (content/wilds.json `decor` and `grounds`),
 * shared with the generator (server/internal/wilds/woods_v2.go). Chunks name
 * both by string (a chunk's `palette` and `decor.kinds`); these tables are
 * what the art reads them as.
 */
import { TERRAIN } from '../../lib/tile.ts';
import { loadWilds, wildsGround } from '../../lib/wilds/data.ts';

/**
 * Every content decor kind, as a type the art can key tables by. The list
 * is content's; tests/wilds-loader.test.ts pins this union to it, so a kind
 * added to content must be added here (and drawn) in the same change.
 */
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
  | 'pebbles'
  | 'meadow-grass'
  | 'meadow-flowers'
  | 'meadow-outcrop'
  | 'meadow-oak'
  | 'meadow-stone'
  | 'bank-stones'
  | 'split-oak'
  | 'standing-stone';

const terrainOf = (id: string): number => {
  const t = (TERRAIN as Record<string, number>)[wildsGround(id).terrain];
  if (t === undefined) throw new Error(`wilds: ground ${id} has no terrain`);
  return t;
};

/** Ground ids the Wilds paint with (the ground art reads them back), from content. */
export const TANGLE_GROUND = {
  /** Under the trees: dark loam, moss and leaf litter. */
  woods: terrainOf('woods'),
  /** Walkable moss in clearings and glades. */
  moss: terrainOf('moss'),
  /** The trodden line of a path. */
  path: terrainOf('path'),
  /** Walkable verge beside a path's trodden line (moss, worn at the middle). */
  verge: terrainOf('verge'),
  /** Bare, trodden earth around camps. */
  trodden: terrainOf('trodden'),
  /** Broken cobbles of the old road. */
  road: terrainOf('road'),
  /** Still water (a backwater of the Wend): solid. */
  water: terrainOf('water'),
} as const;

export interface DecorArt { w: number; h: number; blocking: boolean; flat: boolean }

/**
 * Art footprint per decor kind, in px: width centred on the anchor and
 * height above it. `blocking` pieces only ever stand on solid tiles; `flat`
 * ones are ground decals drawn under everything.
 */
export const DECOR_ART = Object.fromEntries(
  loadWilds().decor.map((d) => [d.kind, { w: d.w, h: d.h, blocking: d.blocking, flat: d.flat }]),
) as Record<DecorKind, DecorArt>;

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
