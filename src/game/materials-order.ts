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
 *
 * A balance is its link's (one account, in one world, in one session): each
 * link has its own, and an adoption reaches only the mirrors reading through
 * that link. A mirror that starts after the balance was adopted (the Home
 * side made after the Wilds read, on resuming in the Wilds) is set from it at
 * once, without a new mark; another account's or world's balance never is.
 */

let clock = 0

/** Adoptions with no link (a model without one, a test): their own balance. */
const UNLINKED = {}

type Owner = object | null | undefined
type Held = { at: number; m: Record<string, number> }

const balances = new WeakMap<object, Held>()
const mirrors = new Map<'home' | 'wilds', { owner: () => Owner; set: (m: Record<string, number>) => void }>()

const key = (owner: Owner): object => owner ?? UNLINKED

/** The next order mark (a read asked now, or an answer landing now). */
export function nextMark(): number {
  return ++clock
}

/** The latest mark handed out (what a read applied without one counts as). */
export function markNow(): number {
  return clock
}

/**
 * A mirror follows every adoption through the link `owner()` names now (one
 * per side: a new session's replaces the old), and starts from the balance
 * that link already holds, if any.
 */
export function mirrorMaterials(side: 'home' | 'wilds', owner: () => Owner, set: (m: Record<string, number>) => void): void {
  mirrors.set(side, { owner, set })
  const held = balances.get(key(owner()))
  if (held) set({ ...held.m })
}

/**
 * Balances read or answered at `at`, through `owner` (the link): adopted by
 * the mirrors reading through it, unless a balance from after `at` is held
 * for it. True when adopted.
 */
export function adoptMaterials(m: Record<string, number>, at: number, owner: Owner): boolean {
  const k = key(owner)
  const held = balances.get(k)
  if (held && at < held.at) return false
  balances.set(k, { at, m: { ...m } })
  for (const mirror of mirrors.values()) if (key(mirror.owner()) === k) mirror.set({ ...m })
  return true
}

/** The balance `owner` holds now (null before any adoption through it): a new view starts from it. */
export function heldMaterials(owner: Owner): Record<string, number> | null {
  const held = balances.get(key(owner))
  return held ? { ...held.m } : null
}
