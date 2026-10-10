/**
 * Returning keepsakes (docs/items/overview.md, "Returning keepsakes"):
 * carrying one that belongs to a living resident adds a quiet line to their
 * dialogue — *give it back* or *not yet* — and "not yet" never closes the
 * door. Giving back is one-time and returns a piece of the story, never
 * something better than the keepsake: Ada's oil receipts leaf, Hazel's
 * recipe card, and with Silas just the conversation. Keepsakes with no
 * living owner (Bett's, Nan's) are left at their Echo camp in the deep
 * Wilds, which is the Wilds side's work.
 *
 * Pure data and a pure builder, so the words are unit-testable; the caller
 * (the residents' talk, Silas's table) reads what's carried from the items
 * model and what's already been returned from the save's flags. The give
 * itself is the server's `return` item op, wired through the dialogue
 * action `keep:return:<def>:<target>`.
 *
 * The keepsakes with no living owner (Bett's candle, Nan's road-nails) are
 * offered to their Echo camps here too: `echoKeepsakeOffer` builds the
 * camp's leave offer (docs/items/overview.md, "Returning keepsakes"); the
 * camp's own words live with the echoes (src/content/echoes.ts) and the
 * Wilds side's prompts and dialogues are the Wilds layer's work
 * (src/game/wilds/sites.ts).
 */
import { echoKeepsakeOf, type EchoMember } from '../content/echoes.ts'
import type { DialogueChoice } from './events'

interface Ask {
  /** The keepsake that belongs to them (content/items.json `belongsTo`). */
  def: string
  /** What they say when they spot it in your pocket. */
  line: string
  /** Their thanks when it's given back (the story piece rides as a flag). */
  giveReply: string[]
  /** "Not yet" never closes the door. */
  notYetReply: string[]
}

/** The three keepsakes whose owners are still in the village. */
const ASKS: Record<string, Ask> = {
  ada: {
    def: 'knotted-halter',
    line: '…That halter. Tam knotted every splice his own way, so the oxen would know his hands. May I see it?',
    giveReply: [
      'Every knot holding. He talked to his oxen more than to people, but he tied a careful knot.',
      'Keep this leaf of my oil receipts. And — the twins’ birthday is at The Breaking. I light two nights for it.'
    ],
    notYetReply: ['Not yet. That’s a fair answer. It waited thirty years; it can wait its turn.']
  },
  hazel: {
    def: 'tin-whistle',
    line: 'That’s Joss’s whistle. One dent, and the note carried clear across the square. May I hold it a moment?',
    giveReply: [
      'Same dent. Same note, if you breathe right. Pip will want to hear it — later, when they’re home.',
      'Here, my recipe card off the wall. The twists are on the front, and Joss is on the back.'
    ],
    notYetReply: ['Mind the dent, then. It’s the dent that makes the note.']
  },
  silas: {
    def: 'whittled-fox',
    line: 'That’s Hollis’s work. Long ear right — he carved his looking in a mirror, the daft man. May I?',
    giveReply: [
      'Thirty years I’ve carved the long ear left. One fox, looking right. Thank you.',
      'Keep your glim. Hearing that ear the right way round is worth more than the shop holds.'
    ],
    notYetReply: ['Keep him, then. He’s seen more road than I have.']
  }
}

/** The dialogue action that gives a keepsake back (WorldScene applies it). */
export function keepsakeReturnAction(def: string, target: string): string {
  return `keep:return:${def}:${target}`
}

/** The parts of a `keep:return:…` action, or null. */
export function parseKeepsakeAction(action: string): { def: string; target: string } | null {
  const m = /^keep:return:([a-z0-9-]+):([a-z]+)$/.exec(action)
  return m ? { def: m[1], target: m[2] } : null
}

/** The speaker's name for a return's thanks (the target of the return). */
export function keepsakeSpeaker(target: string): string {
  return ({ ada: 'Ada', hazel: 'Hazel', silas: 'Silas' })[target] ?? target
}

/** What they say when the return has gone through (never before). */
export function keepsakeThanks(def: string): string[] {
  for (const ask of Object.values(ASKS)) if (ask.def === def) return ask.giveReply
  return []
}

export interface KeepsakeAsk {
  /** The quiet line, said after everything else. */
  line: string
  choices: DialogueChoice[]
}

/**
 * What the resident adds to their talk while you carry their keepsake and
 * haven't given it back yet: the spotting line, then *give it back* / *not
 * yet*. Null when nothing is carried, it's already home, or they own
 * nothing in the village.
 */
export function keepsakeAsk(resident: string, flags: readonly string[], carried: readonly string[]): KeepsakeAsk | null {
  const ask = ASKS[resident]
  if (!ask) return null
  if (!carried.includes(ask.def)) return null
  if (flags.includes(`returned:${ask.def}`)) return null
  // "Give it back" closes on a neutral line; their thanks wait for the
  // server's yes (the return is a keyed mutation, shown after it lands).
  const choices: DialogueChoice[] = [
    { text: 'Give it back', reply: ['You hold it out.'], action: keepsakeReturnAction(ask.def, resident) },
    { text: 'Not yet', reply: ask.notYetReply }
  ]
  return { line: ask.line, choices }
}

/** Every keepsake line (tests: canon voice, length, no real-life words). */
export function allKeepsakeLines(): string[] {
  return Object.values(ASKS).flatMap((a) => [a.line, ...a.giveReply, ...a.notYetReply])
}

// ------------------------------------------------------------ the Echo camps

/** What an Echo camp offers while you carry its person's keepsake. */
export interface EchoKeepsakeOffer {
  member: EchoMember
  /** The keepsake item def (content/items.json `belongsTo`). */
  def: string
  /** The prompt at the camp, and the leave choice's text ("Leave the … here"). */
  label: string
  /** The camp's lines while you carry it and haven't left it yet. */
  lines: string[]
  /** The one short line for guests: the leave waits until they're signed in. TODO(D): drop with the guest branches in wilds/sites.ts. */
  guest: string
  /** The leave choice's action (the server's `return` item op). */
  action: string
}

/**
 * What an Echo camp offers while you carry its person's keepsake and
 * haven't left it yet: the leave choice and "not yet", which never closes
 * the door. Null when nothing is carried, it has been left already
 * (`returned:<def>`), or the camp keeps no keepsake (Dorrit has none).
 * Guests get the offer's words but not the leave itself: the caller answers
 * with `guest` instead of the choices, like the heirloom beats. (The Wilds
 * sites are D's; this guest line goes when they read the server only.)
 */
export function echoKeepsakeOffer(member: EchoMember, flags: readonly string[], carried: readonly string[]): EchoKeepsakeOffer | null {
  const keep = echoKeepsakeOf(member)
  if (!keep) return null
  if (!carried.includes(keep.def)) return null
  if (flags.includes(`returned:${keep.def}`)) return null
  return {
    member,
    def: keep.def,
    label: keep.label,
    lines: keep.offer,
    guest: keep.guest,
    action: keepsakeReturnAction(keep.def, member)
  }
}
