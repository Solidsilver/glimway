/**
 * Silas's and Pell's talks at the Yard (docs/design/silas-yard.md 2.2, 2.6),
 * worked out without the scene: what each says and which choices you get,
 * from what the game knows about you. ./entities/homestead-talk.ts gathers
 * that and opens the conversation; tests read these directly.
 *
 * Silas's talk is short, like the residents': his line, then See the Yard,
 * the axe and the fox only when they apply, and a goodbye. The deeds are
 * Pell's: buy one, take one back, sign an invite, Manage your deed.
 */
import type { Dialogue, DialogueChoice } from '../content/world.ts'
import { BUILDER_NPC_DATA, SILAS_YARD } from '../content/expansion-writing.ts'
import { HEIRLOOM_GUEST_LINES } from '../content/heirlooms.ts'
import { PELL, PELL_DEED } from '../content/pell.ts'
import { lotName } from './homestead.ts'

/** The Yard's two rooms (content/rooms.json): the shop, and Pell's office through its side door. */
export const YARD_SHOP = 'in:commons:yard'
export const YARD_OFFICE = 'in:commons:yard:deeds'

/** Whether an area is one of the Yard's rooms. */
export function isYardRoom(area: string): boolean {
  return area === YARD_SHOP || area === YARD_OFFICE
}

/** The choice that opens the Yard panel on its default tab (silas-yard.md 2.5). */
export const SEE_THE_YARD = 'home:shop'
/** The choice that opens the Manage your deed panel (src/ui/DeedPanel.svelte). */
export const MANAGE_DEED = 'home:deed'

/** What Silas's talk is made from. */
export interface SilasTalkContext {
  /** The first time you've talked to him (his first meeting's lines). */
  first: boolean
  /** His idle line this time (his rotation, in turn). */
  idle: string
  /** A world to keep the books (a guest has none). */
  connected: boolean
  /** Whether you hold a deed; null while the plot book isn't read (loading, offline). */
  claimed: boolean | null
  /** The axe's beat while it applies (src/game/heirloom-beats.ts): his lines, and the take choice when he can hand it over. */
  axe: { lines: string[]; choice: DialogueChoice | null } | null
  /** A guest who knows Hollis's name: the axe waits for a world. */
  guestAxe: boolean
  /** Carrying Hollis's fox (src/game/keepsakes.ts keepsakeAsk): his line, then give it back / not yet. */
  fox: { line: string; choices: DialogueChoice[] } | null
}

/**
 * Silas: his line (the first meeting once, else his idle line), the axe's
 * lines when they apply, and with no deed yet the pointer to Pell; then See
 * the Yard, the axe and the fox only when they apply, and a single goodbye
 * (the fox's own "Not yet" while you carry it, else Just passing).
 */
export function silasTalk(c: SilasTalkContext): Dialogue & { pointsAtPell: boolean } {
  const lines = [...(c.first ? BUILDER_NPC_DATA.dialogue.firstMeeting.lines : [c.idle])]
  if (c.guestAxe) lines.push(HEIRLOOM_GUEST_LINES.silas)
  if (c.axe) lines.push(...c.axe.lines)
  const pointer = !c.connected ? SILAS_YARD.pellPointerGuest : c.claimed === false ? SILAS_YARD.pellPointer : null
  if (pointer) lines.push(pointer)
  if (c.fox) lines.push(c.fox.line)
  const choices: DialogueChoice[] = [{ text: SILAS_YARD.seeTheYard, action: SEE_THE_YARD }]
  if (c.axe?.choice) choices.push(c.axe.choice)
  const foxBye = c.fox?.choices.find((x) => !x.action) ?? null
  if (c.fox) choices.push(...c.fox.choices.filter((x) => x !== foxBye))
  choices.push(foxBye ?? { text: SILAS_YARD.justPassing })
  return { speaker: BUILDER_NPC_DATA.name, lines, choices, pointsAtPell: pointer !== null }
}

/** A gate on the lane as Pell's ledger has it. */
export interface PellGate {
  gate: number
  /** Its deed's price in glims (0: your first deed, on the Compact). */
  price: number
}

/** What Pell's talk is made from. */
export interface PellTalkContext {
  /** The first time you've talked to Pell (their first meeting's lines, with the first deed; a homeowner's short welcome). */
  first: boolean
  /** Pell's idle line this time (the rotation, in turn). */
  idle: string
  /** The plot book: 'guest' (no world), 'loading', 'offline', or 'ready'. */
  status: 'guest' | 'loading' | 'offline' | 'ready'
  /** Whether you hold a deed. */
  claimed: boolean
  /** Your own home is read (once you hold a deed). */
  homeRead: boolean
  /** Your glims (a deed you can't afford is shown, but not offered). */
  glims: number
  /** Someone's offer to put your name on their deed, waiting for your signature. */
  invite: { homeId: string; gate: number; from: string } | null
  /** Old deeds you gave up, still held for you (their gates). */
  reclaimable: number[]
  /** Unclaimed gates, the one whose sign you read first. */
  unclaimed: PellGate[]
  /** You've heard Pell's pitch (it plays once). */
  pitchHeard: boolean
  /** You stand at the deed table (src/game/deed-table.ts standsAtTable): an invite is signed there. */
  atTable: boolean
}

/** The longest name on a choice before it's cut short. */
const NAME_MAX = 14

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * Pell, at the desk: their line (the first meeting once, else an idle
 * line), then deed things only. With no deed: an invite to sign (offered
 * only at the table), old deeds to take back (two at most), the deeds on
 * offer (four at most; one you can't afford says what it needs), Not today.
 * On a deed: a short welcome the first time and an idle line, then Manage
 * your deed, Not today. A guest, or a plot book not read yet, gets the line
 * why (and the first meeting waits until Pell knows whether you hold a
 * deed). `met`: the first meeting was said this time.
 */
export function pellTalk(c: PellTalkContext): Dialogue & { needsRead: boolean; met: boolean } {
  const greet = c.first ? [...PELL.firstMeeting.lines] : [c.idle]
  const bye: DialogueChoice = { text: PELL_DEED.notToday }
  if (c.status === 'guest') return { speaker: PELL.name, lines: [...greet, PELL_DEED.guest], needsRead: false, met: c.first }
  if (c.status !== 'ready' || (c.claimed && !c.homeRead)) {
    return { speaker: PELL.name, lines: [c.idle, c.status === 'offline' ? PELL_DEED.offline : PELL_DEED.loading], needsRead: c.status !== 'loading' || c.claimed, met: false }
  }
  // A homeowner's first talk: a short welcome, no "choose a gate" pitch.
  if (c.claimed) return { speaker: PELL.name, lines: c.first ? [PELL.firstMeetingHomeowner, c.idle] : greet, choices: [{ text: PELL_DEED.manage, action: MANAGE_DEED }, bye], needsRead: false, met: c.first }
  const choices: DialogueChoice[] = []
  if (c.invite) {
    const text = PELL_DEED.signInvite(cut(c.invite.from, NAME_MAX))
    choices.push(c.atTable ? { text, note: PELL_DEED.signInviteNote(lotName(c.invite.gate)), action: `home:sign:${c.invite.homeId}` } : { text, note: PELL_DEED.standByTable, disabled: true })
  }
  for (const gate of c.reclaimable.slice(0, 2)) choices.push({ text: PELL_DEED.takeBack(lotName(gate)), note: PELL_DEED.takeBackNote, action: `home:claim:${gate}` })
  for (const g of c.unclaimed.slice(0, 4)) {
    const text = PELL_DEED.buy(lotName(g.gate))
    choices.push(g.price > c.glims ? { text, note: PELL_DEED.buyShort(g.price), disabled: true } : { text, note: PELL_DEED.buyNote(g.price), action: `home:claim:${g.gate}` })
  }
  choices.push(bye)
  // An invite or an old page is news every time; the pitch plays once.
  const news = c.invite ? PELL_DEED.invite(c.invite.from, lotName(c.invite.gate)) : c.reclaimable.length ? PELL_DEED.takeBackPitch(lotName(c.reclaimable[0])) : c.pitchHeard || c.first ? null : PELL_DEED.pitch
  return { speaker: PELL.name, lines: news ? [...greet, news] : greet, choices, needsRead: false, met: c.first }
}
