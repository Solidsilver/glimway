/**
 * Esc in a conversation (the owner's playtest: "esc should just get you out
 * of any dialogue, unless it's crucial"). Leaving is the same as reading it
 * through, so nothing is lost: with no replies on offer the talk closes and
 * still delivers what closing delivers; with replies, Esc takes the goodbye
 * ("Not yet", "Be on my way"…) as if it were picked, without its reply. A
 * talk whose replies have no goodbye is a decision to make, and stays; so
 * does one under a story beat (a cinematic). No Svelte, no Phaser.
 */

/** The parts of a reply this reads (src/game/event-names.ts DialogueChoice). */
export interface EscapeChoice {
  text: string
  reply?: readonly string[]
  action?: string
  disabled?: boolean
  replay?: boolean
  dismiss?: boolean
}

/**
 * A reply that only ends the talk: flagged `dismiss`, or one with no action
 * and no reply ("Just passing", "Not yet", "Not now": picking it does
 * nothing but close; src/content/talk.ts reads goodbyes the same way).
 */
export function isGoodbye(c: EscapeChoice): boolean {
  if (c.disabled || c.replay) return false
  return !!c.dismiss || (!c.action && !c.reply?.length)
}

export type EscapeMove<C extends EscapeChoice> = { kind: 'close' } | { kind: 'goodbye'; choice: C } | { kind: 'stay' }

/**
 * What Esc does now. `choices` are the replies this talk offers (shown, or
 * still to come after the last line); `answered` once one was picked (its
 * reply is being read); `beat` while a story beat holds the screen.
 */
export function escapeMove<C extends EscapeChoice>(s: { choices: readonly C[] | null; answered: boolean; beat?: boolean }): EscapeMove<C> {
  if (s.beat) return { kind: 'stay' }
  if (!s.choices || s.choices.length === 0 || s.answered) return { kind: 'close' }
  const bye = s.choices.find(isGoodbye)
  return bye ? { kind: 'goodbye', choice: bye } : { kind: 'stay' }
}
