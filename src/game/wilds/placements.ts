/**
 * Deterministic placements for the Wilds' found texts (papers.ts sources
 * `wilds-poi` / `wilds-chest`), chosen to match each text's hook:
 *
 * - "A surveyor's abandoned camp beside a tight-ringed stump" — the Old
 *   Shrine POI (tight-ringed iron-oak grows around it).
 * - "A roofed shrine deep east whose turncap leans toward Sallow Ford" —
 *   the Mossy Arch POI, in the region's easternmost chunk column only.
 * - "A hollowed-out log in the Wilds" — tier-3 chests, the deepest caches.
 *
 * A paper is granted when its entity is claimed (a POI charted, a chest
 * opened), so the find is tied to the personal claim either way. "Late"
 * finds (the Pencil Map is written from Sallow Ford: it would tell you who
 * made it) wait for the road to be lit, like the late project papers.
 *
 * The outer Wilds' finds that are not generated entities (the Amberwash
 * cairn, the jackdaw's nest, the reeds, the crossing) are story sites:
 * src/lib/wilds/stories.ts.
 */

export interface WildsPlacement {
  paperId: string;
  /** POI definition id (the generated `poi` field). */
  poi?: string;
  /** Restrict to the region's easternmost chunk column. */
  eastOnly?: boolean;
  /** Generated chest tier (1–3). */
  chestTier?: number;
  /** Waits until the road is lit (quest complete). */
  late?: boolean;
}

export const WILDS_PAPER_PLACEMENTS: readonly WildsPlacement[] = [
  { paperId: 'failed-grid-of-sector-4', poi: 'old-shrine' },
  { paperId: 'joss-penhallow-field-notes-pencil-map', poi: 'mossy-arch', eastOnly: true, late: true },
  { paperId: 'the-blind-routes-smugglers-ledger', chestTier: 3 },
];

/** The paper a claimed entity carries, if any. */
export function wildsPaperFor(
  entity: { kind: string; poi: string; tier: string | number },
  chunkCx: number,
  regionColumns: number,
  roadLit = true
): string | null {
  for (const p of WILDS_PAPER_PLACEMENTS) {
    if (p.late && !roadLit) continue;
    if (p.poi !== undefined) {
      if (entity.kind !== 'poi' || entity.poi !== p.poi) continue;
      if (p.eastOnly && chunkCx !== regionColumns - 1) continue;
      return p.paperId;
    }
    if (p.chestTier !== undefined) {
      if (entity.kind !== 'chest' || Number(entity.tier) !== p.chestTier) continue;
      return p.paperId;
    }
  }
  return null;
}
