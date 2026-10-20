/**
 * Naming a lamp from parts (roadmap 0.13; docs/design/lamps.md §2.8): never
 * free text. A naming is six parts in order: ordinal, relation, a landmark
 * the server found near the lamp (or a fallback: the road, the
 * Whitequiet), what is behind and what is ahead (a side phrase or one of
 * those landmarks), and a closing. The sentence and the short name both
 * come from the parts:
 *
 *   “You are the first lamp past the Whitequiet. Behind you the road; ahead
 *   the old shrine. Hold fast.” · First lamp past the Whitequiet
 *
 * This renders the preview; the server renders the same words again from
 * the same content (api/lamp_naming.go) and keeps its own.
 */
import { HOMESTEAD_DATA, type NamingWord } from './homestead.ts'

/** A landmark on offer for one lamp (GET /api/lamp-landmarks/<lamp>). */
export interface NamingLandmark {
  id: string
  phrase: string
}

/** The six parts, in the order the server takes them. */
export const NAMING_SLOTS = ['ordinal', 'relation', 'landmark', 'behind', 'ahead', 'closing'] as const
export type NamingSlot = (typeof NAMING_SLOTS)[number]

/** One choice for a part: its id and the words it puts in the sentence. */
export interface NamingChoice {
  id: string
  words: string
}

const rules = () => HOMESTEAD_DATA.lampNaming

const choices = (list: readonly NamingWord[]): NamingChoice[] => list.map((w) => ({ id: w.id, words: w.words }))
const marks = (landmarks: readonly NamingLandmark[]): NamingChoice[] => landmarks.map((m) => ({ id: m.id, words: m.phrase }))

/** What each part may be, for a lamp with these landmarks on offer. */
export function namingChoices(landmarks: readonly NamingLandmark[]): Record<NamingSlot, NamingChoice[]> {
  const r = rules()
  const sides = [...choices(r.sides), ...marks(landmarks)]
  return {
    ordinal: choices(r.ordinals),
    relation: choices(r.relations),
    landmark: marks(landmarks),
    behind: sides,
    ahead: sides,
    closing: choices(r.closings)
  }
}

/** A first pick for each part: the first of each, behind the road and ahead the next side along. */
export function defaultParts(landmarks: readonly NamingLandmark[]): string[] {
  const c = namingChoices(landmarks)
  const road = c.behind.find((x) => x.id === 'road') ?? c.behind[0]
  const ahead = c.ahead.find((x) => x.id !== road?.id) ?? c.ahead[0]
  return [c.ordinal[0]?.id ?? '', c.relation[0]?.id ?? '', c.landmark[0]?.id ?? '', road?.id ?? '', ahead?.id ?? '', c.closing[0]?.id ?? '']
}

/** The words a part puts in, or null when it isn't one on offer. */
function wordsFor(slot: NamingSlot, id: string | undefined, all: Record<NamingSlot, NamingChoice[]>): string | null {
  return all[slot].find((x) => x.id === id)?.words ?? null
}

/** The sentence and short name from six parts; null if any part isn't on offer. */
export function renderNaming(parts: readonly string[], landmarks: readonly NamingLandmark[]): { text: string; shortName: string } | null {
  if (parts.length !== NAMING_SLOTS.length) return null
  const all = namingChoices(landmarks)
  // A side's own phrase comes before a landmark of the same id, as on the server.
  const [ord, rel, mark, behind, ahead, closing] = NAMING_SLOTS.map((slot, i) => wordsFor(slot, parts[i], all))
  if (!ord || !rel || !mark || !behind || !ahead || !closing) return null
  const short = `${ord} lamp ${rel} ${mark}`
  return {
    text: `You are the ${ord} lamp ${rel} ${mark}. Behind you ${behind}; ahead ${ahead}. ${closing}`,
    shortName: short.charAt(0).toUpperCase() + short.slice(1)
  }
}


/** Asking the player to name a lamp: which lamp, communal or a camp's, and the landmarks on offer. */
export interface LampNamingAsk {
  lamp: string
  kind: 'communal' | 'camp'
  landmarks: NamingLandmark[]
}

/** The Keeper's hand (Mara's ledger, quest keepers-hand): names lamps and sets way-lamps. */
export const KEEPER_HAND = 'keeper:hand'

/** Whether these story flags hold the Keeper's hand. */
export function isKeeper(flags: readonly string[]): boolean {
  return flags.includes(KEEPER_HAND)
}
