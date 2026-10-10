/**
 * The Wardrobe's words (purse-and-wardrobe.md 4.1): the tab, the picker,
 * Check for new gear, and every refusal the wardrobe can meet. Short and
 * plain; the wardrobe never changes Habitica, and the copy says so.
 */
import { errorText } from './errors.ts'

export const wardrobeCopy = {
  title: 'What you wear',
  habiticaLook: 'Wear Habitica’s look',
  asOnHabitica: 'As on Habitica',
  nothing: 'Nothing',
  nothingHint: 'Leave this slot bare',
  change: 'Change',
  foot: 'Only how you look here. Your stats come from your battle gear on Habitica, and Habitica stays as it is.',
  check: 'Check for new gear',
  checking: 'Checking…',
  connectFirst: 'Connect first',
  connectHint: 'Checking needs your Habitica token in this tab. Connect in the Menu.',
  neverChecked: 'Check for new gear to see what you own.',
  nothingElse: 'Nothing else for this slot yet. Gear you earn on Habitica turns up here when you check for new gear.',
  unread: 'Your gear couldn’t be read just now. You can still wear Habitica’s look or nothing.',
  noLink: 'The wardrobe opens once you’re in the world.'
} as const

/** "Found 2 new pieces." or "Nothing new on Habitica." */
export function foundLine(newPieces: number): string {
  if (newPieces <= 0) return 'Nothing new on Habitica.'
  return newPieces === 1 ? 'Found 1 new piece.' : `Found ${newPieces} new pieces.`
}

/** "Gear checked with Habitica 3 days ago." (`checkedAt`, `now`: Unix seconds). */
export function checkedLine(checkedAt: number, now: number): string {
  const s = Math.max(0, now - checkedAt)
  const when =
    s < 90 ? 'just now'
    : s < 3600 ? `${Math.round(s / 60)} minutes ago`
    : s < 2 * 3600 ? 'an hour ago'
    : s < 86400 ? `${Math.floor(s / 3600)} hours ago`
    : s < 2 * 86400 ? 'yesterday'
    : `${Math.floor(s / 86400)} days ago`
  return `Gear checked with Habitica ${when}.`
}

/** Each "Wear the whole set" line: how many pieces it puts on, with the one just picked. */
export function wholeSetLine(pieces: number): string {
  return `Wear the whole set (${pieces} pieces)`
}

/** The wardrobe's refusals: its choice and Check for new gear. Every refusal changes nothing. */
export const WARDROBE_ERRORS: Readonly<Record<string, string>> = {
  'needs-habitica': 'The wardrobe dresses your Habitica hero. Connect it in the Menu.',
  'invalid-slot': 'That isn’t a slot the wardrobe dresses.',
  'gear-not-owned': 'That piece isn’t among your Habitica gear now. Check for new gear and look again.',
  'habitica-auth': 'Habitica didn’t accept your token. Connect again in the Menu.',
  'habitica-unavailable': 'Habitica didn’t answer just now. Try again in a little while.',
  'habitica-rate-limited': 'Habitica asked us to slow down. Try again in a minute.',
  'login-rate-limited': 'Too many checks with Habitica just now. Try again in a few minutes.',
  'login-user-rate-limited': 'Too many checks with Habitica just now. Try again in a few minutes.',
  'login-busy': 'Another check with Habitica is still running. Try again in a moment.'
}

export const wardrobeErrorText = (code: string): string => errorText(WARDROBE_ERRORS, code)
