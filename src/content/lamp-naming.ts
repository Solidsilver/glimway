/**
 * The Keeper's hand and naming a lamp from parts (roadmap 0.13;
 * docs/design/lamps.md §2.8, §2.9): the cut on the quest's stone, the
 * naming panel's words, and what a Keeper hears when they see to a lamp.
 * Plain and short; the ledger's own voice is Wenna's, copied out by Mara.
 */
import type { NamingSlot } from '../lib/lamp-naming.ts'

/** The cut on the first stone north of the Whitequiet: Wenna's, the form's own example. */
export const THE_CUT = 'You are the first lamp past the Whitequiet. Behind you the road; ahead the old shrine. Hold fast.'

export const LAMP_NAMING = {
  /** Looking at the quest's stone. */
  cutLines: ['Words are cut into the stone’s side, worn shallow but still sharp at the corners:', `“${THE_CUT}”`, 'Under it, smaller: W.H.'],
  copy: { text: 'Copy the cut', note: 'For Mara’s ledger' },
  copied: 'You copy the cut out, letter for letter. Mara will want it beside the ledger.',
  name: { text: 'Give it a naming', note: 'The form from Wenna’s ledger' },
  read: { text: 'Read its naming', note: 'Out loud, the way a Keeper would' },
  readDone: 'You read the naming out to nobody in particular. It still holds.',
  named: 'Named. A pinch of ash comes away from the wick, still warm. Keep it.',

  // The panel.
  title: 'Name this lamp',
  body: 'So a stranger can find their way by it. Say where it stands, what it stands by, what’s behind and what’s ahead.',
  once: 'A lamp is named once, and keeps it.',
  slots: {
    ordinal: 'Which lamp',
    relation: 'Where it stands',
    landmark: 'By what',
    behind: 'Behind you',
    ahead: 'Ahead',
    closing: 'Close it'
  } satisfies Record<NamingSlot, string>,
  short: (name: string) => `Short name: ${name}`,
  confirm: 'Name it',
  cancel: 'Not yet',
  loading: 'Looking about for landmarks…'
} as const
