/** Set to Rise: Hazel’s sponge (indoors.md 5.6). */
import type { QuestTalks } from './types.ts';

export const SET_TO_RISE_TALKS: QuestTalks = {
  'hear-hazel': {
    speaker: 'Hazel',
    lines: [
      'I’ve a sponge that wants feeding and not a pinch of fine sift in the house.',
      'Finn’s got it. Finn always has it, he just has to stop counting long enough to sell it.',
    ],
    offer: { text: 'I’ll fetch you some flour.', reply: ['Bless you. A sack, mind, not a pocketful. He’ll try and sell you the grist. Don’t let him.'] },
  },
  'set-sponge': {
    speaker: 'Hazel',
    lines: ['That’s the fine sift. Good. In it goes, with warm water and a pinch of yesterday’s.'],
    offer: {
      text: 'Set the sponge with her',
      note: '1 flour',
      reply: ['You stir until your arm aches. Hazel throws a cloth over the bowl and pats it like a dog.', '“Now we leave it be. A couple of hours. Come back and we’ll see what it thinks.”'],
    },
    short: ['Still no flour? Finn’s at the mill, or out by his door. A sack an ember.', 'Go on. The sponge is waiting, and so am I.'],
  },
  'let-it-rise': {
    speaker: 'Hazel',
    lines: ['Look at that. Domed like a loaf already. You can’t hurry a sponge. Only leave it somewhere warm and trust it.'],
    offer: {
      text: 'Lift the cloth',
      reply: ['Twists, still hot. Two for your trouble.', 'I burnt the ends of one on purpose. Don’t ask. Eat it.'],
    },
    notYet: (words) => ['Not yet. Look at it. It’s thinking.', `Give it ${words}.`],
  },
};

/** The sponge bowl in the kitchen, by how far the quest has got. */
export const SPONGE_BOWL = {
  speaker: 'Sponge Bowl',
  empty: ['A bowl on a stool under a clean cloth. Empty, and floured round the rim as if it’s waiting for something.'],
  rising: (words: string) => [`The cloth sits flat over the sponge. It’s thinking. Hazel says to give it ${words}.`],
  risen: ['The cloth has lifted into a dome. It’s risen. Better tell Hazel before it gets ideas.'],
  done: ['Hazel’s started another. The cloth has a burnt thumbprint on it now.'],
} as const;
