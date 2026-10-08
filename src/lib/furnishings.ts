import raw from '../../content/furnishings.json' with { type: 'json' };

/**
 * The one furnishings catalogue (design 2.8): every placeable piece, the
 * village's rooms and players' houses alike. Home goods in homestead.json
 * keep only what is homestead-specific (category, where, prices, materials)
 * and refer to these ids for name and footprint.
 */
export interface FurnishBase { x: number; y: number; w: number; h: number }
/** One named state of a piece that changes only by something that happens, never by idling. Exactly one state is the default. */
export interface FurnishState { frames: string[]; loop?: boolean; default?: boolean }
/** The surfaces a piece provides for other pieces, sized in small-item slots (a small piece takes one, a medium two). */
export interface FurnishOffers { top?: number; shelves?: number }
export interface Furnishing {
  id: string;
  name: string;
  facings: Partial<Record<'front' | 'left' | 'right' | 'diag', string>>;
  footprint: [number, number];
  /** The part that touches what the piece stands on; collision uses only this. */
  base: FurnishBase;
  mount: 'floor' | 'wall' | 'surface';
  offers?: FurnishOffers;
  /** A rug (layer "under") may omit it. */
  size?: 'small' | 'medium' | 'large';
  /** Rugs lie on the floor, under everything, and never block. */
  layer?: 'under';
  states?: Record<string, FurnishState>;
  /** Game-internal labels ("seat", "light", "section:stories"), never placement rules. */
  tags: string[];
}
export interface Furnishings { pieces: Furnishing[] }
const FACINGS = ['front', 'left', 'right', 'diag'];
const MOUNTS = ['floor', 'wall', 'surface'];
const SIZES = ['small', 'medium', 'large'];
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100 && /^[a-z0-9-]+$/.test(v);
const int = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
/** A tag is a game-internal label, never a placement rule. */
const tag = (v: unknown): v is string => typeof v === 'string' && v.split(':').every(part => id(part));
function validateStates(states: Record<string, FurnishState> | undefined): boolean {
  if (states === undefined) return true; // absent means none; an explicit null is refused
  if (!obj(states)) return false;
  const names = Object.keys(states);
  if (!names.length) return false;
  return names.every(name => id(name) && obj(states[name]) && keys(states[name]!, ['frames', 'loop', 'default'])
    && Array.isArray(states[name]!.frames) && states[name]!.frames.length > 0
    && states[name]!.frames.every((f: unknown) => typeof f === 'string' && (f === '' || id(f)))
    && (states[name]!.loop === undefined || typeof states[name]!.loop === 'boolean')
    && (states[name]!.default === undefined || typeof states[name]!.default === 'boolean'))
    && names.filter(name => states[name]!.default).length === 1;
}
export function validateFurnishings(value: unknown): Furnishings {
  const bad = (s: string): never => { throw new Error(`invalid furnishings: ${s}`); };
  if (!obj(value) || !Array.isArray(value.pieces) || !value.pieces.length) return bad('empty');
  const doc = value as unknown as Furnishings, seen = new Set<string>();
  for (const p of doc.pieces) {
    if (!obj(p) || !keys(p, ['id', 'name', 'facings', 'footprint', 'base', 'mount', 'offers', 'size', 'layer', 'states', 'tags'])
      || !id(p.id) || seen.has(p.id)) return bad(`id ${p.id}`);
    seen.add(p.id);
    if (typeof p.name !== 'string' || !p.name) return bad(`${p.id} name`);
    if (!Array.isArray(p.footprint) || p.footprint.length !== 2 || !int(p.footprint[0], 1) || p.footprint[0] > 12 || !int(p.footprint[1], 1) || p.footprint[1] > 10) return bad(`${p.id} footprint`);
    if (!MOUNTS.includes(p.mount)) return bad(`${p.id} mount`);
    // A rug (layer "under") may omit its size; nothing else may.
    if (!(SIZES as unknown[]).includes(p.size) && !(p.layer === 'under' && p.size === undefined)) return bad(`${p.id} size`);
    if (p.layer !== undefined && p.layer !== 'under') return bad(`${p.id} layer`);
    if (!Array.isArray(p.tags)) return bad(`${p.id} tags`);
    if (!obj(p.facings) || !Object.keys(p.facings).length || !Object.entries(p.facings).every(([f, art]) => FACINGS.includes(f) && typeof art === 'string' && (art === '' || id(art)))) return bad(`${p.id} facings`);
    if (!obj(p.base) || !keys(p.base, ['x', 'y', 'w', 'h']) || !int(p.base.x) || !int(p.base.y) || !int(p.base.w, 1) || !int(p.base.h, 1)
      || p.base.x + p.base.w > p.footprint[0] || p.base.y + p.base.h > p.footprint[1]) return bad(`${p.id} base`);
    const offers = p.offers as unknown as Record<string, unknown> | undefined;
    const offerSlots = (v: unknown): v is number => int(v, 1) && (v as number) <= 12;
    if (offers !== undefined && (!obj(offers) || !keys(offers, ['top', 'shelves'])
      || offers.top !== undefined && !offerSlots(offers.top)
      || offers.shelves !== undefined && !offerSlots(offers.shelves)
      || !offers.top && !offers.shelves)) return bad(`${p.id} offers`);
    // A rug lies on the floor, under everything, and never blocks.
    if (p.layer === 'under' && (p.mount !== 'floor' || p.offers !== undefined)) return bad(`${p.id} rug`);
    if (!validateStates(p.states)) return bad(`${p.id} states`);
    const seenTags = new Set<string>();
    for (const t of p.tags) { if (!tag(t) || seenTags.has(t)) return bad(`${p.id} tag ${t}`); seenTags.add(t); }
  }
  return doc;
}
export const FURNISHINGS = validateFurnishings(raw);
export function furnishingFor(id: string): Furnishing | null { return FURNISHINGS.pieces.find(p => p.id === id) ?? null; }

/**
 * What a piece is placed onto: the floor, a wall, a rug, or another piece's
 * surface (its top or one shelf row).
 */
export type PlaceOn = { kind: 'floor' | 'wall' | 'rug' } | { kind: 'surface'; host: Furnishing; offer: 'top' | 'shelves' };
/** How many small-item slots a piece fills on a surface, or 0 when it can never fit one (large pieces are floor-only). */
function slotsFor(size: Furnishing['size'] | undefined): number { return size === 'small' ? 1 : size === 'medium' ? 2 : 0; }
/**
 * Design 2.8's one placement table, for any piece onto the floor, a wall, a
 * rug or another piece's surface. `at` is the 0-based slot on a surface
 * (ignored elsewhere). No per-item exceptions: size, mount and layer decide.
 * A state never changes where a piece can go.
 */
export function canPlace(piece: Furnishing, onto: PlaceOn, at = 0): boolean {
  if (piece.layer === 'under') return onto.kind === 'floor'; // a rug: only on the floor, under everything
  if (piece.mount === 'wall') return onto.kind === 'wall'; // wall pieces only on walls
  if (onto.kind === 'floor') return true;
  if (onto.kind === 'rug') return true; // a rug counts as the floor for every piece but walls and other rugs
  if (onto.kind !== 'surface') return false;
  const slots = onto.offer === 'top' ? onto.host.offers?.top ?? 0 : onto.offer === 'shelves' ? onto.host.offers?.shelves ?? 0 : 0;
  const needed = slotsFor(piece.size);
  // A medium piece goes on a top that's big enough, never shelves; a large
  // piece never fits a surface.
  if (!needed || (piece.size === 'medium' && onto.offer !== 'top')) return false;
  return at >= 0 && at + needed <= slots;
}
