/**
 * Typed loader for content/places.json — the places over the outdoor grid:
 * the fixed footprints, the rules every generated place shares and the
 * rules of the spaces beside the grid (docs/design/location-seam.md 1.2).
 * The schema and its field rules live in proto/glimway/content/v1/
 * places.proto; the server reads the same file through content/places.go.
 * src/lib/location.ts asks it where things are.
 */
import raw from '../../content/places.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { PlacesSchema, type PlacesValid } from './gen/glimway/content/v1/places_pb.js';
import { loadWilds } from './wilds/data.ts';
import type { WildsData } from './wilds/types.ts';

export type Places = PlacesValid;
export type FixedPlace = PlacesValid['fixed'][number];
export type PlaceRules = PlacesValid['generated'];

/** A fixed place's footprint as an inclusive chunk rectangle. */
export function fixedChunks(p: FixedPlace): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: p.cx, y0: p.cy, x1: p.cx + p.width - 1, y1: p.cy + p.height - 1 };
}

/** The ids a fixed place may not take: the outdoor space, the Beyond and the spaces beside the grid. */
const PLACE_SPACES = ['outdoors', 'beyond', 'village', 'woodland', 'ruin', 'home', 'in'];

/**
 * The rules that span entries, the twin of Go's placesRules
 * (content/places.go), word for word: both refuse the shared vectors with
 * the same message.
 */
function placesRules(p: Places, w: WildsData): void {
  const bad = (msg: string): never => {
    throw new Error(`invalid places: ${msg}`);
  };
  const S = w.chunkSize;
  const taken = w.places.map((f) => ({ id: f.id, x0: f.cx, y0: f.cy, x1: f.cx + f.width - 1, y1: f.cy + f.height - 1 }));
  const seen = new Set<string>();
  for (const f of p.fixed) {
    if (seen.has(f.id)) bad(`duplicate place ${f.id}`);
    seen.add(f.id);
    if (PLACE_SPACES.includes(f.id) || w.places.some((g) => g.id === f.id)) bad(`place ${f.id} is reserved`);
    const { x0, y0, x1, y1 } = fixedChunks(f);
    for (const r of taken) if (x0 <= r.x1 && r.x0 <= x1 && y0 <= r.y1 && r.y0 <= y1) bad(`place ${f.id} overlaps ${r.id}`);
    taken.push({ id: f.id, x0, y0, x1, y1 });
    // The footprint in layout tiles, inclusive.
    const lx0 = x0 * S - f.origin.tx, ly0 = y0 * S - f.origin.ty, lx1 = (x1 + 1) * S - 1 - f.origin.tx, ly1 = (y1 + 1) * S - 1 - f.origin.ty;
    const inside = (tx: number, ty: number) => tx >= lx0 && tx <= lx1 && ty >= ly0 && ty <= ly1;
    const zones = new Set<string>();
    for (const z of f.zones) {
      if (zones.has(z.id)) bad(`${f.id}: duplicate zone ${z.id}`);
      zones.add(z.id);
      if (!inside(z.tx, z.ty) || !inside(z.tx + z.w - 1, z.ty + z.h - 1)) bad(`${f.id} zone ${z.id}: outside the footprint`);
    }
    const anchors = new Set<string>();
    for (const a of f.anchors) {
      if (anchors.has(a.id)) bad(`${f.id}: duplicate anchor ${a.id}`);
      anchors.add(a.id);
      const wx = a.tx + f.origin.tx, wy = a.ty + f.origin.ty;
      const onFixed = p.fixed.some(other => { const r = fixedChunks(other); return wx >= r.x0*S && wx < (r.x1+1)*S && wy >= r.y0*S && wy < (r.y1+1)*S; });
      if (!onFixed) bad(`${f.id} anchor ${a.id}: outside the footprint`);
    }
    // The gate anchors are the frozen capacity: gate:0 up to gate:n-1.
    const gates = new Set<number>();
    for (const a of f.anchors) {
      const prefix = f.id === 'hearthwick' ? 'lot:' : 'gate:';
      if (!a.id.startsWith(prefix)) continue;
      const n = a.id.slice(prefix.length);
      if (!/^(0|[1-9][0-9]{0,3})$/.test(n)) bad(`${f.id} anchor ${a.id}: not a gate number`);
      gates.add(Number(n));
    }
    for (let g = 0; g < gates.size; g++) if (!gates.has(g)) bad(`${f.id}: gate anchors skip gate:${g}`);
  }
}

/** A fixed place's gate capacity: its gate anchors, gate:0 to gate:n-1 (the loader's rule). */
export function gateCapacity(p: FixedPlace): number {
  return p.anchors.filter((a) => a.id.startsWith(p.id === 'hearthwick' ? 'lot:' : 'gate:')).length;
}

/** Reads places JSON through the schema, then the rules that span entries and files. */
export function validatePlaces(value: unknown, wilds: WildsData = loadWilds()): Places {
  const doc = decodeContent(PlacesSchema, value, 'places', ['fixed']) as unknown as Places;
  placesRules(doc, wilds);
  return doc;
}

export const PLACES = validatePlaces(raw);
