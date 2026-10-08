/**
 * The way into the library panel from the game (docs/design/indoors.md 3.3,
 * revised): a section's shelves open it on that section, Elara on the whole
 * collection or on donating, the reading table on the reader. The panel
 * (src/ui/LibraryPanel.svelte) decides what a section with nothing shelved
 * yet shows (the whole collection).
 */
import { bus, EV, type LibraryOpenPayload } from './events'
import type { LibrarySection } from '../content/library'

export function openLibrary(p: LibraryOpenPayload & { section?: LibrarySection } = {}): void {
  bus.emit(EV.libraryOpen, p)
}

/** A section's shelves (B's room shelves call this with their sign's section). */
export function openLibrarySection(section: LibrarySection): void {
  openLibrary({ focus: 'shelf', section })
}
