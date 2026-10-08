/**
 * Scene objects that follow a prediction back (design server-first 2.4): a
 * find, a curated defeat or the warden's settling shows at once, and when
 * the world refuses it the scene must show it again. These decide what to
 * restore from the state the game shows now; the scene modules apply them.
 * No Phaser here, so they run in tests.
 */
import type { QuestStage } from '../lib/state.ts'

/** Pickups to add (due again: a take that was refused) and to remove (taken, here or elsewhere). */
export function pickupChanges(lying: Iterable<string>, due: readonly string[]): { add: string[]; remove: string[] } {
  const here = new Set(lying)
  const want = new Set(due)
  return { add: due.filter((id) => !here.has(id)), remove: [...here].filter((id) => !want.has(id)) }
}

/**
 * Curated enemies to bring back: placed in this area, not defeated in the
 * state (a refused defeat), and not standing here now. The guardian follows
 * the quest instead, and Wilds camps their own cycle.
 */
export function curatedToRestore<S extends { id: string; type: string }>(spots: readonly S[], defeated: readonly string[], standing: ReadonlySet<string>): S[] {
  return spots.filter((s) => s.type !== 'guardian' && !s.id.startsWith('wilds:') && !defeated.includes(s.id) && !standing.has(s.id))
}

/**
 * The warden rests settled on screen, but its settling was refused: it
 * stands again. The `defeated:stone-warden` mark goes first (the step's
 * `defeat` trigger needs it), so a warden marked defeated has settled even
 * while the step that follows it is still on its way.
 */
export function wardenToRestore(quest: QuestStage, resting: 'dormant' | 'settled' | null, active: boolean, defeated = false): boolean {
  return quest === 'clue-found' && !defeated && !active && resting !== 'dormant'
}
