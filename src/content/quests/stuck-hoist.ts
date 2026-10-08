/** The Stuck Hoist: Finn’s mill and the sack loft (indoors.md 5.6). */
import type { QuestTalks } from './types.ts';

export const STUCK_HOIST_TALKS: QuestTalks = {
  'hear-finn': {
    speaker: 'Finn',
    lines: [
      'The hoist’s seized. I’ve sacks up there and none down here, and Hazel needs flour, and Mara needs flour, and I’m counting the wrong thing again.',
      'Would you look? Stairs are at the back. Mind the third one.',
    ],
    offer: { text: 'I’ll look at it.', reply: ['Third one. I counted. It’s the third.'] },
  },
  'look-hoist': {
    speaker: 'Sack Hoist',
    lines: [
      'The hoist’s pulley hangs over the hatch on a beam gone grey with flour. The rope is kinked where it jammed.',
      'You lean on the handle. Nothing, not even a creak. The axle is dry as a bone. It wants grease, and Hazel renders tallow.',
    ],
  },
  'grease-hoist': {
    speaker: 'Sack Hoist',
    lines: ['The axle is dry as a bone. A lump of tallow, worked in warm, should free it.'],
    offer: {
      text: 'Work the tallow in',
      note: '1 tallow',
      reply: ['You warm the tallow in your hands and work it into the axle. The handle gives, then turns. Somewhere below, a sack thumps onto the mill floor.'],
    },
    short: ['The axle is dry as a bone. You’d want a lump of tallow. Hazel sells it, an ember a lump.'],
  },
  'tell-finn': {
    speaker: 'Finn',
    lines: [
      'It turns? It turns. I heard it. Forty turns to the floor and a squeak at the top.',
      'The squeak’s fine. The squeak was always there. I’d miss it.',
    ],
    offer: { text: 'Tell him it runs', reply: ['Here. Oatcakes. One. I’d give you five but then I’d have four, and four’s a bad number for oatcakes.'] },
  },
};
