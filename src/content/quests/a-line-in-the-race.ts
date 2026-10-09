/** A Line in the Race: Finn's rod, the mill race, Hazel's card (docs/design/crafts.md 5.8). */
import type { QuestTalks } from './types.ts';

export const A_LINE_IN_THE_RACE_TALKS: QuestTalks = {
  'hear-finn-line': {
    speaker: 'Finn',
    lines: [
      'Roach come up to the wheel for the meal dust. Race runs all year, even when the pond’s glass.',
      'There’s a rod on the hook by my door. Take it. It only gets looked at.',
    ],
    offer: {
      text: 'Take the rod',
      reply: [
        'Stand on the sand above the wheel and drop it down the race. When the float dips, that’s a roach saying yes.',
        'Hazel will know what to do with one. I just count them.',
      ],
    },
  },
  'show-hazel': {
    speaker: 'Hazel',
    lines: ['Is that a roach from Finn’s race? Let me see.'],
    offer: {
      text: 'Show her the roach',
      note: '1 mill roach',
      reply: [
        'Oh, that’s a good one. Flour, a hot pan, and don’t fuss it.',
        'Here, have the card. I’ll keep this one to check the card’s right.',
      ],
    },
    short: ['A roach, you say? Bring me one from the race and I’ll show you what it’s for.'],
  },
};
