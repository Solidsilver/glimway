/** Three Fingers off Plumb, the opening (quests.md 3). */
import type { QuestTalks } from './types.ts';

export const SIGNPOST_TALKS: QuestTalks = {
  'meet-orrin': {
    speaker: 'Orrin',
    lines: [
      'Mind the ladder. No. Mind the post. Look at it.',
      'Frost came up under it in the night and stood it straight. Plumb. Like a Hall clerk.',
      'It’s meant to lean. Three fingers off, east. Don’t ask why. Frost.',
      'And the east finger’s gone. Wind took it past the east gate, into the bracken. My back says I’m not going after it.',
    ],
    choices: [
      { text: 'I’ll fetch it.', reply: ['East gate, left of the path. If there’s a wisp sat on it, and there will be, give it a smack. They don’t mind. They go off and sulk.'] },
      { text: 'Why does it lean?', reply: ['Frost.', 'He looks at you until you go.'] },
    ],
  },
  'bring-finger': {
    speaker: 'Orrin',
    lines: [
      'That’s it. Paint held, mostly.',
      'He rubs a thumb over the old letters under ASHWATCH. “Old paint. Leave it.”',
      'Right. Before I set it, you write it down. Three fingers off plumb, east. I’m sixty-odd and the ground’s worse at remembering than I am.',
    ],
  },
  'set-post': {
    speaker: 'Orrin',
    lines: ['Read it back.'],
    choices: [
      { text: 'Three fingers off plumb, east.', reply: ['Good. Hold it there.', 'Two knocks with the mallet. “There. Crooked as the day it was set.”', 'He doesn’t say who set it.'] },
    ],
  },
  'see-mara': {
    speaker: 'Mara',
    lines: ({ connected }) => [
      'You’re the one off the Low Road. And Orrin’s had you on the signpost, so you’ve done a job for the village. That goes in the ledger.',
      '“East finger recovered, lean set. Traveller’s hand.” There.',
      'Gran’s rule. Work done and written down is warmth you carry. Here we call it embers.',
      connected
        ? 'It doesn’t have to be done here, either. Whatever you get done in your own day counts. Bring it back and I’ll write it in.'
        : 'Where you come from, folk carry their own day’s work in with them. Pip can tell you how, at the gate.',
      'Two embers buys a rest by the well if that wisp knocked you about. Three lights a lamp.',
      'The first one past the east gate has been dark thirty years. Never two dark in a row, Gran said. Go on. I want to see it from here.',
    ],
  },
};

/** Orrin and Mara between the opening's talks (dialogue rules in ../world.ts, keyed by `signpost:<step>`). */
export const SIGNPOST_BETWEEN = {
  orrinFetching: [
    'East gate, left of the path. Bracken, a wisp, a finger. In that order.',
    'I’d go myself. My back wouldn’t.',
  ],
  orrinNoting: ['Written it down yet? Three fingers off plumb, east. Your journal, not your head. Heads leak.'],
  maraOpening: [
    'You came up the Low Road? Then the carters weren’t fibbing. Welcome to Hearthwick. I’m Mara Hale.',
    'Mind the ladder by the signpost. Orrin’s been arguing with it since dawn, and it’s winning. He could use a hand.',
  ],
  maraLamp: [
    'The first lamp’s just past the east gate, by the bracken. Three embers lights it.',
    'Go on. I’ll be watching from here.',
  ],
} as const;
