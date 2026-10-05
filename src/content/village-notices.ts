/**
 * Notice-board words: village projects at each stage, and Elara's postings.
 * The first three projects use the writing pack (expansion-writing.ts,
 * VILLAGE_PROJECTS); the other three are written here in the same voice,
 * from the canon (docs/lore/chronicle.md: Maren's guildhouse, Orrin and the
 * Hall price of hinges, Ada's window).
 */
import { VILLAGE_PROJECTS } from './expansion-writing.ts';

export interface ProjectNotice {
  open: string;
  inProgress: string;
  complete: string;
  /** Who posted it. */
  by: string;
}

const MORE: Record<string, ProjectNotice> = {
  'wheel-wick-guildhouse': {
    by: 'Mara',
    open: 'The Wheel & Wick has stood shuttered since the Closure. Timber for the floor, stone for the forge, fiber for the bellows, and the carters could meet under a roof again.',
    inProgress: 'The shutters are off and the floor is half down. Somebody found Maren’s old bench under a dust sheet. Nobody has sat at it yet.',
    complete: 'The Wheel & Wick is open. There is a fire in the forge and a tally on the wall, and the bench by the window is left clear.',
  },
  'orrins-hinges': {
    by: 'Orrin',
    open: 'WANTED: timber, stone, and good amber for a workshop door that doesn’t need the Hall price of hinges. Pegged. Obviously. — O.',
    inProgress: 'The frame is up. Orrin says the amber is for the latch-light and not to ask. Bring a little more and he’ll stop complaining. Probably.',
    complete: 'Orrin’s workshop door swings on oak, no iron, and closes with a sound he calls “acceptable”. There is a letter from Tarrow pinned inside it.',
  },
  'cooley-window-fund': {
    by: 'Mara',
    open: 'Ada Cooley has kept a lamp in her window every night for thirty years. The village pays for her oil. Fiber for wicks and amber for the lamp keep it lit through the Quiet.',
    inProgress: 'The fund’s leaf in the ledger is filling up. Ada says she doesn’t need it. Mara writes “Noted.”',
    complete: 'Ada’s window is lit through the Quiet and beyond, paid in full. She waits correctly, and now she needn’t count the oil.',
  },
};

export function projectNotice(id: string): ProjectNotice {
  const writ = VILLAGE_PROJECTS.find((p) => p.id === id);
  if (writ) return { by: id === 'north-bridge' ? 'Orrin' : id === 'mill-wheel' ? 'Finn' : 'Mara', open: writ.open, inProgress: writ.inProgress, complete: writ.complete };
  return MORE[id] ?? { by: 'Mara', open: 'Materials wanted.', inProgress: 'Under way.', complete: 'Done.' };
}

/** Elara Quill signs the Turning notices (she reads the drift). */
export const ELARA_SIGNATURE = '— E. Quill, for the Keeper';

/** What the board says when it can't reach the world (guests, offline). */
export const PROJECTS_NEED_WORLD = 'Village projects are kept by your world. Sign in to your world from the Menu to lend a hand.';
export const PROJECTS_OFFLINE = 'The project ledger is at Mara’s. Come back when the road to your world is clear.';
