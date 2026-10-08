/**
 * What the player reads when a write to their world doesn't go through: the
 * link's own answers (shared by every feature), and the ember spends' (a
 * lantern, the chest, a rest).
 */

/** The link's answers, the same words wherever the write came from. */
export const LINK_REFUSAL = {
  offline: 'Needs a connection. Nothing changed — try again when you’re back online.',
  superseded: 'Another device took over this journey.',
  busy: 'Hold on — the last one is still on its way.',
  resolved: 'Your last request went through after all. Check what you have before trying again.',
  pending: 'No answer yet — it may have gone through. We’ll find out when the connection is back; nothing will be taken twice.'
} as const

/** A refusal code in the link's words, or null when it isn't one of the link's. */
export function linkRefusalText(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(LINK_REFUSAL, code) ? LINK_REFUSAL[code as keyof typeof LINK_REFUSAL] : null
}

/** An ember spend that didn't happen (nothing was spent). */
const SPEND_REFUSAL: Record<string, string> = {
  short: 'The flame gutters — not enough embers after all.',
  full: 'You’re already rested. Keep your embers.',
  done: 'That’s already done.',
  'needs-earned': 'Only embers earned on Habitica can get you back on your feet.',
  unsafe: 'Resting only works in Hearthwick.',
  'not-home': 'You can only rest at your own place.',
  /** A guest's spend while a Habitica sync owns the save. */
  syncing: 'Hold on — your hero is still syncing. Try again in a moment.',
  offline: 'Needs a connection. Your embers are safe — try again when you’re back online.',
  superseded: LINK_REFUSAL.superseded,
  busy: LINK_REFUSAL.busy
}

/** Why an ember spend was refused, in words. */
export function spendRefusalText(code: string): string {
  return SPEND_REFUSAL[code] ?? 'The lantern didn’t answer. Nothing was spent — try again in a moment.'
}
