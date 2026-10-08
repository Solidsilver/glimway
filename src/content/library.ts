/**
 * The library's sections (docs/design/indoors.md 3.3, revised after the
 * owner's first playtest): small painted signs on the shelves. Each paper
 * has its section (`section` in `content/papers.json`, from
 * src/content/papers.ts): its kind's (`PaperStyle`) below, unless the
 * design shelves it elsewhere. A section's shelves open the library panel
 * on it; a section with nothing shelved yet opens the whole collection.
 */
import type { Paper, PaperStyle } from './papers.ts';

export type LibrarySection = 'stories' | 'histories' | 'recipes' | 'field-notes';

export interface SectionDef {
  id: LibrarySection;
  /** The shelf sign and the panel's filter. */
  label: string;
  styles: readonly PaperStyle[];
}

export const LIBRARY_SECTIONS: readonly SectionDef[] = [
  // Printed pages and songs: the tales, lullabies, primers and almanacs.
  { id: 'stories', label: 'Stories', styles: ['page', 'song'] },
  // The village's documents: ledgers, clerks' records, posted notices, letters.
  { id: 'histories', label: 'Histories', styles: ['ledger', 'record', 'broadside', 'letter'] },
  { id: 'recipes', label: 'Recipes', styles: ['card'] },
  // Notebooks and the scraps people wrote on whatever was to hand.
  { id: 'field-notes', label: 'Field notes', styles: ['notebook', 'scrap'] },
];

export function sectionById(id: string): SectionDef | undefined {
  return LIBRARY_SECTIONS.find((s) => s.id === id);
}

/** The section a kind of paper goes in by default. */
export function sectionForStyle(style: PaperStyle): LibrarySection {
  return LIBRARY_SECTIONS.find((s) => s.styles.includes(style))!.id;
}

/** The section a paper is shelved in. */
export function sectionOf(paper: Pick<Paper, 'section'>): LibrarySection {
  return paper.section;
}

/**
 * The section the panel opens on: the asked-for one, unless nothing in it
 * is on the shelves yet (then the whole collection, null).
 */
export function openingSection(asked: string | null | undefined, shelved: readonly Pick<Paper, 'section'>[]): LibrarySection | null {
  const s = asked ? sectionById(asked) : undefined;
  return s && shelved.some((p) => p.section === s.id) ? s.id : null;
}
