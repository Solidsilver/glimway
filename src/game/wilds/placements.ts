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
 * opened), so the find is tied to the personal claim either way.
 */

export interface WildsPlacement {
  paperId: string;
  /** POI definition id (the generated `poi` field). */
  poi?: string;
  /** Restrict to the region's easternmost chunk column. */
  eastOnly?: boolean;
  /** Generated chest tier (1–3). */
  chestTier?: number;
}

export const WILDS_PAPER_PLACEMENTS: readonly WildsPlacement[] = [
  { paperId: 'failed-grid-of-sector-4', poi: 'old-shrine' },
  { paperId: 'joss-penhallow-field-notes-pencil-map', poi: 'mossy-arch', eastOnly: true },
  { paperId: 'the-blind-routes-smugglers-ledger', chestTier: 3 },
];

/** The paper a claimed entity carries, if any. */
export function wildsPaperFor(
  entity: { kind: string; poi: string; tier: string | number },
  chunkCx: number,
  regionColumns: number
): string | null {
  for (const p of WILDS_PAPER_PLACEMENTS) {
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
