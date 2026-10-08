/**
 * Names for the Tangle's decor art (drawn by ./tangle-art.ts into one atlas
 * texture, so the woods draw in a single batch). Kept apart from the art so
 * the generator's WorldData adapter can name frames without canvas code.
 */
import type { DecorKind } from './decor.ts'

/** Variants drawn per decor kind. */
export const TANGLE_VARIANTS = 4

/** The atlas frame for one decor piece (`<kind>-<n>`). */
export function tangleFrame(kind: DecorKind, variant: number): string {
  return `${kind}-${variant % TANGLE_VARIANTS}`
}
