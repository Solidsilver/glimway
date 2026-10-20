/**
 * A Keeper’s Hand: Mara, the ledger and the first stone past the Whitequiet
 * (roadmap 0.13; docs/design/lamps.md §2.8, §2.9). Copying the cut and
 * seeing to a lamp happen out in the Wilds, on marks the server writes
 * (src/game/wilds/communal-lamps.ts); only Mara's two talks are here.
 */
import type { QuestTalks } from './types.ts';

export const KEEPERS_HAND_TALKS: QuestTalks = {
  'hear-mara': {
    speaker: 'Mara',
    lines: [
      'The road’s held, you said. It isn’t. Not out there.',
      'Past the Whitequiet it runs on north, and every lamp on it is dark. Grandmother cut a naming into the first stone. I’ve read it in the ledger a hundred times. I’ve never seen it.',
      'Copy it out for me? Exactly as it’s cut. I’ll know if you tidy it.',
    ],
    offer: { text: 'I’ll copy it.', reply: ['North out of the Whitequiet, first stone you come to. Mind the drift.'] },
  },
  'check-ledger': {
    speaker: 'Mara',
    lines: [
      'Let me see.',
      'She opens the ledger to the middle without looking for the page, and lays your copy beside it. Her finger goes along both lines at once.',
      'Same words. Same order. She even cut the W.H. smaller, as if she minded being seen.',
    ],
    offer: {
      text: 'Give her the copy',
      reply: [
        'Noted.',
        'She writes your name under the cut, and blows on the ink.',
        'That’s a Keeper’s hand. It doesn’t make you anyone’s. It means you may name a lamp so a stranger can find their way by it, and set a way-lamp of your own out there.',
        'Here: a lamp head from the Count House, a wick for that stone, and the form, copied out. Grandmother’s two leaves for getting home are tucked in the back. Don’t lose them. I copied those twice.',
      ],
    },
  },
};
