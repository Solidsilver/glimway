/** Your Own Day: the guided-task loop (quests.md 3). */
import type { QuestTalks } from './types.ts';

export const YOUR_OWN_DAY_TALKS: QuestTalks = {
  'hear-mara': {
    speaker: 'Mara',
    lines: [
      'Your own day, I said. Anything you finish out there counts: a job done, a chore, a promise kept.',
      'Bring it back and I’ll write it in. The embers find their own way here.',
    ],
  },
  'show-mara': {
    speaker: 'Mara',
    lines: [
      'You’ve done something. I can tell, you’ve the look. I don’t need to know what, only that it’s done.',
      'She punches an old wheel-tax token and hands it over. “Receipted. The Count House would’ve wanted it.”',
    ],
  },
};

/** The Quests page’s line for a hero who can’t take it yet. */
export const YOUR_OWN_DAY_LOCKED = 'Connect Habitica in the Menu to take this one';
