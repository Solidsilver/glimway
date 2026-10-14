/**
 * The one lookup for "where am I" (docs/design/location-seam.md 1.2): which
 * place a position in a space is in and what that place allows, which
 * source a chunk's ground comes from, whether an outdoor chunk exists, and
 * where anchors and area-local content tiles lie on the grid. The client
 * predicts with it; the server (server/internal/location, the twin)
 * decides. Both replay content/vectors/location.json.
 *
 * Positions are world pixels, as `where` and saved places carry them;
 * tiles are 16 px and chunks content/wilds.json's chunkSize tiles, signed
 * and floor-divided (src/lib/wilds/coords.ts). Content coordinates are
 * bounded (places.proto) so every expression is exact in both runtimes.
 * Each function takes the places as its last argument, defaulting to the
 * shipped ones.
 */
import { PLACES, fixedChunks, type FixedPlace, type PlaceRules, type Places } from './places.ts';
import { rootArea } from './rooms.ts';
import { TILE } from './tile.ts';
import { chunkOf, epochKindAt, footprintAt, insideFrontier, tileOfPixel } from './wilds/coords.ts';
import type { WildsEpochKind } from './wilds/types.ts';

/** The coordinate frame a position is in, and the saved area. */
export type Space = string;
export const OUTDOORS: Space = 'outdoors';
/** The place id of generated ground outside every Wilds footprint. */
export const BEYOND = 'beyond';

/** Where a chunk's ground comes from; `none` off the grid. Held (Lamps) comes later. */
export interface Source {
  kind: 'none' | 'fixed' | 'generated';
  layout: string;
  revision: number;
  epochKind: WildsEpochKind | '';
}

export type RestKind = 'none' | 'village' | 'home';

/**
 * The named region a position is in and what it allows. `id` is a place id
 * ("commons", "tangle", "whitequiet", "beyond", a zone's place) or, off the
 * grid, the space itself ("village", "home:3", "in:commons:yard").
 */
export interface Place {
  id: string;
  safe: boolean;
  ride: boolean;
  sync: boolean;
  rest: RestKind;
  source: Source;
}

const NO_SOURCE: Source = { kind: 'none', layout: '', revision: 0, epochKind: '' };

function fixedAt(cx: number, cy: number, places: Places): FixedPlace | undefined {
  return places.fixed.find((f) => {
    const { x0, y0, x1, y1 } = fixedChunks(f);
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  });
}

function fixedById(id: string, places: Places): FixedPlace | undefined {
  return places.fixed.find((f) => f.id === id);
}

function withRules(id: string, r: PlaceRules, source: Source = NO_SOURCE): Place {
  return { id, safe: r.safe, ride: r.ride, sync: r.sync, rest: r.rest as RestKind, source };
}

function fixedSource(f: FixedPlace): Source {
  return { kind: 'fixed', layout: f.layout, revision: f.revision, epochKind: '' };
}

const HOME = /^home:(0|[1-9]\d{0,3})$/;

/** The rules of a space beside the grid, by its root ("village", "home:3"), if anything names it. */
function spaceRules(root: string, places: Places): PlaceRules | undefined {
  const s = places.spaces;
  if (root === 'village') return s.village;
  if (root === 'woodland') return s.woodland;
  if (root === 'ruin') return s.ruin;
  if (HOME.test(root)) return s.home;
  return fixedById(root, places)?.rules;
}

/**
 * The place a position is in (world pixels in the space's frame). Outdoors
 * it is a fixed footprint's zone or the footprint itself, else the
 * generated place: a Wilds footprint's id or the Beyond. A fixed place's
 * own id as the space (the Commons before the join) reads its layout pixels
 * through the origin. A room takes its root space's rules and never allows
 * riding. Any other space is its own place, allowing nothing. It doesn't
 * ask whether the chunk is on the grid (onGrid does).
 */
export function at(space: Space, x: number, y: number, places: Places = PLACES): Place {
  if (space === OUTDOORS) {
    const { tx, ty } = tileOfPixel(x, y);
    const { cx, cy } = chunkOf(tx, ty);
    const f = fixedAt(cx, cy, places);
    if (f) {
      const lx = tx - f.origin.tx, ly = ty - f.origin.ty;
      const z = f.zones.find((z) => lx >= z.tx && lx < z.tx + z.w && ly >= z.ty && ly < z.ty + z.h);
      return z ? withRules(z.place, z.rules, fixedSource(f)) : withRules(f.id, f.rules, fixedSource(f));
    }
    return withRules(footprintAt(cx, cy)?.id ?? BEYOND, places.generated, { kind: 'generated', layout: '', revision: 0, epochKind: epochKindAt(cx, cy) });
  }
  const f = fixedById(space, places);
  if (f) return at(OUTDOORS, x + f.origin.tx * TILE, y + f.origin.ty * TILE, places);
  if (space.startsWith('in:')) {
    const r = spaceRules(rootArea(space), places);
    return r ? { ...withRules(space, r), ride: false } : nowhere(space);
  }
  const r = spaceRules(space, places);
  return r ? withRules(space, r) : nowhere(space);
}

function nowhere(id: string): Place {
  return { id, safe: false, ride: false, sync: false, rest: 'none', source: NO_SOURCE };
}

/** Where an outdoor chunk's ground comes from: a fixed footprint holding it, else the generator. */
export function sourceOf(cx: number, cy: number, places: Places = PLACES): Source {
  const f = fixedAt(cx, cy, places);
  return f ? fixedSource(f) : { kind: 'generated', layout: '', revision: 0, epochKind: epochKindAt(cx, cy) };
}

/** An outdoor chunk exists: generated land may be made there (the frontier), or a fixed footprint covers it. */
export function onGrid(cx: number, cy: number, places: Places = PLACES): boolean {
  return insideFrontier(cx, cy) || fixedAt(cx, cy, places) !== undefined;
}

/** "<place>:<anchor>" ("commons:arch", "commons:gate:3") as its space and its tile's centre in world pixels. */
export function anchor(id: string, places: Places = PLACES): { space: Space; x: number; y: number } | null {
  const i = id.indexOf(':');
  if (i < 0) return null;
  const f = fixedById(id.slice(0, i), places);
  const a = f?.anchors.find((a) => a.id === id.slice(i + 1));
  if (!f || !a) return null;
  return { space: OUTDOORS, x: (a.tx + f.origin.tx) * TILE + TILE / 2, y: (a.ty + f.origin.ty) * TILE + TILE / 2 };
}

/**
 * An area-local content tile in its space: a fixed place's layout tile
 * ("commons") moves by the place's origin into outdoors; any other area is
 * its own space and the tile is unchanged. The bridge for content naming
 * Commons positions in Commons tiles until the town redesign moves them to
 * anchors.
 */
export function resolve(area: string, tx: number, ty: number, places: Places = PLACES): { space: Space; tx: number; ty: number } {
  const f = fixedById(area, places);
  return f ? { space: OUTDOORS, tx: tx + f.origin.tx, ty: ty + f.origin.ty } : { space: area, tx, ty };
}
