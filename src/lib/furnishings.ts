import raw from '../../content/furnishings.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import {
  FurnishingsSchema,
  type FurnishingValid,
  type FurnishingsValid,
} from './gen/glimway/content/v1/furnishings_pb.js';

/** The generated messages (proto/glimway/content/v1/furnishings.proto), with the schema's required fields non-optional. */
export type Furnishings = FurnishingsValid;
export type Furnishing = FurnishingValid;

/**
 * The one furnishings catalogue (design 2.8): every placeable piece, the
 * village's rooms and players' houses alike. Home goods in homestead.json
 * keep only what is homestead-specific (category, where, prices, materials)
 * and refer to these ids for name and footprint. The schema and its field
 * rules live in the proto; there are no rules left in code here.
 */
export function validateFurnishings(value: unknown): Furnishings {
  const doc = decodeContent(FurnishingsSchema, value, 'furnishings', ['pieces']) as Furnishings;
  // One id per piece: the loader's own rule, naming the duplicate (the
  // schema's CEL can't cheaply, and the old loaders named it).
  const seen = new Set<string>();
  for (const p of doc.pieces) {
    if (seen.has(p.id)) throw new Error(`invalid furnishings: duplicate id ${p.id}`);
    seen.add(p.id);
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
