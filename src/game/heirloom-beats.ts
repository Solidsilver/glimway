/**
 * The heirloom beats as the world offers them (Silas, Orrin, Ada, Nan's
 * camp): offered only when the server will grant the heirloom, with the
 * same checks and the same reach (src/content/heirlooms.ts). When it won't,
 * the giver says why in their own reply, inside the conversation.
 *
 * The server measures reach from the progress that rides along with the
 * grant, so where the hero stands is written into the save first: the frame
 * loop notes it once a second and not at all while a conversation is open,
 * and a stale spot is what made Silas refuse twice before handing over the
 * axe (playtest 1).
 */
import { bus, EV, type DialogueChoice } from './events'
import type { Session } from './session'
import { itemsFor } from './items'
import { HEIRLOOMS, heirloomReadiness, heirloomRefusalFor, heirloomRefusalLine, type HeirloomContext, type HeirloomId } from '../content/heirlooms'
import { openDialogue } from './dialogue'

/** What the server will see for a grant now: the save, with where the hero stands written in. */
export function heirloomContext(session: Session, id: HeirloomId, worldFlags: readonly string[] = []): HeirloomContext {
  bus.emit(EV.notePosition)
  const s = session.state
  return {
    area: s.area,
    x: s.position.x,
    y: s.position.y,
    flags: s.flags,
    worldFlags,
    online: !!session.link?.online,
    inFlight: itemsFor(session).isGrantInFlight(id)
  }
}

export interface HeirloomBeat {
  lines: string[]
  /** The take choice when offered; empty when the giver holds it back. */
  choices: DialogueChoice[]
}

/**
 * A connected player's beat: the giver's lines and the take choice, or the
 * giver's reason instead. Null when there is no beat (not earned yet, or
 * already given).
 */
export function heirloomBeat(session: Session, id: HeirloomId, take: string, worldFlags: readonly string[] = []): HeirloomBeat | null {
  const ready = heirloomReadiness(id, heirloomContext(session, id, worldFlags))
  if (!ready) return null
  if (ready.ok) return { lines: [...HEIRLOOMS[id].dialogueLines], choices: [{ text: take, action: `heirloom:grant:${id}` }] }
  return { lines: [heirloomRefusalLine(id, ready.why).line], choices: [] }
}

/** The giver answers a refused grant in the conversation (not a toast). */
export function sayHeirloomRefusal(id: HeirloomId, code: string): void {
  const { speaker, line } = heirloomRefusalLine(id, heirloomRefusalFor(code))
  openDialogue({ id: `heirloom-refused:${id}`, speaker, lines: [line] }, { sound: null })
}
