/**
 * The states the rooms' signature pieces take from the story (docs/design/
 * indoors.md 2.8: a state changes only when something happens, never by
 * idling). Pure choices over the save and the clock, so the unit tests run
 * them without a scene; WorldScene.pieceState applies them to a room prop.
 *
 * The 0.4 wire (assets/generated/indoors-pass/README.md): the sponge bowl's
 * risen dome, the hoist's working loop, and Elara's desk drawn with her
 * writing at it.
 */
import { questById, reachedIndex, type GateContext, type QuestRecord } from '../lib/quests.ts'
import { waitLeft } from '../content/quests/index.ts'

/**
 * The sponge bowl (Set to Rise): `risen` once the sponge has risen — the
 * step after `set-sponge` reached and its wait has run out — null (its
 * default, the flat bowl) before it's set and once Hazel has taken it out.
 */
export function spongeBowlState(quests: QuestRecord, gate: GateContext): 'risen' | null {
  const q = questById('set-to-rise')
  if (!q) return null
  const at = reachedIndex(q, quests)
  const set = q.steps.findIndex((s) => s.id === 'set-sponge')
  if (at < set || at >= q.steps.length - 1) return null // not set yet, or done (Hazel's started another)
  return waitLeft(q.steps[at + 1], gate) ? null : 'risen'
}

/**
 * The hoist (The Stuck Hoist): `working` while the quest's step points at
 * it — from the moment it's greased until Finn has been told — `seized`
 * (its default, the still frame) otherwise.
 */
export function hoistState(quests: QuestRecord): 'working' | 'seized' {
  const at = quests['stuck-hoist']
  return at === 'grease-hoist' || at === 'tell-finn' ? 'working' : 'seized'
}

/**
 * Elara's desk: `writing` while the residents' cycle has her at it (her
 * seated spot), `empty` while she's out. The `writing` frames draw her
 * seated at the desk herself, so her own sprite stands down while they show.
 */
export function elaraDeskState(elara: { area: string; spot: string } | null, areaId: string): 'writing' | 'empty' {
  return !!elara && elara.area === areaId && elara.spot === 'desk' ? 'writing' : 'empty'
}
