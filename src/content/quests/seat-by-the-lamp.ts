/** A Seat by the Lamp: the library reading room (indoors.md 5.6). */
import type { QuestTalks } from './types.ts';

export const SEAT_BY_THE_LAMP_TALKS: QuestTalks = {
  'browse-shelf': {
    speaker: 'Tall Shelves',
    lines: [
      'The village’s papers, shelved by whoever last had them: ledgers, almanacs, a recipe card tucked into a book of knots.',
      'On the reading table behind you, a brass lamp sits dry, a tin tag tied to its handle.',
    ],
  },
  'oil-lamp': {
    speaker: 'Reading Lamp',
    lines: ['A brass reading lamp, dry as old bread. The tin tag on its handle says, in Mara’s hand: “One ember the oil. Ledger. M.H.”'],
    offer: { text: 'Pay for the oil', note: '1 ember', reply: ['You fill the lamp from the stores jug and trim the wick. It catches gold and steady, and the reading table glows.'] },
  },
  'read-awhile': {
    speaker: 'Reading Table',
    lines: [
      'You pull out a chair under the lamp and open the nearest paper. The light goes gold on the page.',
      'Under Mara’s tag, in a different hand: “Worth it.”',
    ],
  },
};

export const READING_LAMP_LIT = ['The reading lamp burns steady on the table. The oil’s paid for, and the ledger says so.'] as const;
