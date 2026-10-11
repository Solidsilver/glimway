/**
 * The carried materials are one server-owned balance with two mirrors: the
 * Home side's (Village's carried counts, which the shop, board, mail and
 * workshop read) and the Wilds store's. Both sides order their reads and
 * answers on this one clock, so a Home read and a Wilds answer compare, and
 * the balance has one mark for both mirrors.
 *
 * Only an adoption moves the mark: a read's balances (as of when it was
 * asked) or an answer's (as of when it landed). An adoption is handed to
 * every mirror as is, without a new mark, and a mirror never adopts what it
 * is handed. Re-publishing a mirror (a Wilds bump, a prediction, a roster
 * redraw) is not an adoption, so it never looks newer than a read in flight,
 * and the two mirrors can't feed each other marks.
 */

let clock = 0
/** The mark of the balance both mirrors hold. */
let heldAt = 0
let held: Record<string, number> | null = null
const mirrors = new Map<'home' | 'wilds', (m: Record<string, number>) => void>()

/** The next order mark (a read asked now, or an answer landing now). */
export function nextMark(): number {
  return ++clock
}

/** The latest mark handed out (what a read applied without one counts as). */
export function markNow(): number {
  return clock
}

/** A mirror follows every adoption (one per side: a new session's replaces the old). */
export function mirrorMaterials(side: 'home' | 'wilds', set: (m: Record<string, number>) => void): void {
  mirrors.set(side, set)
}

/**
 * Balances read or answered at `at`: adopted by both mirrors, unless a
 * balance from after `at` is held. True when adopted.
 */
export function adoptMaterials(m: Record<string, number>, at: number): boolean {
  if (at < heldAt) return false
  heldAt = at
  held = { ...m }
  for (const set of mirrors.values()) set({ ...held })
  return true
}

/** The balance held now (null before any adoption): a new mirror starts from it. */
export function heldMaterials(): Record<string, number> | null {
  return held ? { ...held } : null
}
