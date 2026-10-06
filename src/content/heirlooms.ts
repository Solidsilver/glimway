/**
 * The four heirloom tools, given through story beats (docs/items/catalogue.md):
 *  1. Brack felling axe — Silas (Wheel & Wick guildhouse, knowing Hollis's name)
 *  2. Orrin's mason pick — Orrin (after north bridge is mended)
 *  3. Ada's garden spade — Ada (after bringing window oil three times)
 *  4. Nan's lamplighter pole — Nan's echo camp (once Nan's echo is settled)
 *
 * Each heirloom is given once, ever, by a person with a reason.
 * Lines ≤160 chars, in canon voice (docs/lore/chronicle.md), in-world only.
 */
import type { JournalEntry } from './world.ts';
import type { QuestStage } from '../lib/state.ts';

export type HeirloomId =
  | 'brack-felling-axe'
  | 'orrins-mason-pick'
  | 'ada-garden-spade'
  | 'nans-lamplighter-pole';

export const HEIRLOOM_IDS: readonly HeirloomId[] = [
  'brack-felling-axe',
  'orrins-mason-pick',
  'ada-garden-spade',
  'nans-lamplighter-pole',
];

export interface HeirloomDef {
  id: HeirloomId;
  name: string;
  giver: string;
  speaker: string;
  dialogueLines: string[];
  journal: JournalEntry;
  toast: string;
}

export const HEIRLOOMS: Record<HeirloomId, HeirloomDef> = {
  'brack-felling-axe': {
    id: 'brack-felling-axe',
    name: 'Brack felling axe',
    giver: 'silas',
    speaker: 'Silas',
    dialogueLines: [
      'You know Hollis’s name. Most folk around here don’t say it aloud any more, like a name could wear out.',
      'Found this in the old Wheel & Wick guildhouse, tucked behind the spoke-bench. Maren forged the head; Orrin trunnelled the haft.',
      'A Brack felling axe. Keep the bit oiled and the wedge tight. It’s got more miles in it yet.',
    ],
    journal: {
      title: 'The Brack Felling Axe',
      body: 'Silas brought an axe out from the old Wheel & Wick guildhouse. Iron head forged by Hollis’s sister Maren, ash haft pegged by Orrin. It cut timber for the road thirty years ago; it will cut again.',
    },
    toast: 'Silas gave you the Brack felling axe.',
  },
  'orrins-mason-pick': {
    id: 'orrins-mason-pick',
    name: 'Orrin’s mason pick',
    giver: 'orrin',
    speaker: 'Orrin',
    dialogueLines: [
      'Bridge looks straight enough. Walked it twice; didn’t groan. High praise, for me.',
      'Here. My old mason pick. Dressed the north bridge’s footings with it, the year the span went up.',
      'Ash haft, notched every three fingers. And mind what’s cut on the wood: drift-stone for foundations, NOT for walls.',
    ],
    journal: {
      title: 'Orrin’s Mason Pick',
      body: 'Orrin handed over the pick he used on the north bridge footings. The haft is notched every three fingers, with a mason’s rule cut into the ash: drift-stone for foundations, not for walls.',
    },
    toast: 'Orrin gave you his mason pick.',
  },
  'ada-garden-spade': {
    id: 'ada-garden-spade',
    name: 'Ada’s garden spade',
    giver: 'ada',
    speaker: 'Ada',
    dialogueLines: [
      'Three flasks. The window’s kept a good while.',
      'I dug the twins’ first garden with this. Small. Good dark soil.',
      'Take it. A spade wants hands.',
    ],
    journal: {
      title: 'Ada’s Garden Spade',
      body: 'Ada Cooley gave me the small spade she used to dig her twins’ first garden. The ash grip is dark and polished smooth by eighty years of hands. She says a spade wants hands.',
    },
    toast: 'Ada gave you her garden spade.',
  },
  'nans-lamplighter-pole': {
    id: 'nans-lamplighter-pole',
    name: 'Nan’s lamplighter pole',
    giver: 'nan',
    speaker: 'The Lamplighter’s Camp',
    dialogueLines: [
      'The owed lamp burns quiet above the stump. Leaning beside it, untouched: Nan’s lamplighter pole.',
      'Long ash haft, brass hook at the top, a wick-trimmer set into the side. Worn dark where two hands held it along the chain.',
      'She walked her stretch to the end. The lamp is held now; the pole can walk the road again.',
    ],
    journal: {
      title: 'Nan’s Lamplighter Pole',
      body: 'Found Nan Greer’s lamplighter pole leaning at her settled camp in the Whitequiet. Long ash with a brass hook and wick-trimmer, worn dark from years on the Lantern Road. The owed lamp burns above it.',
    },
    toast: 'You found Nan’s lamplighter pole.',
  },
};

/** Ada's dialogue replies for window oil gifts 1 and 2. */
export const ADA_OIL_REPLIES: Record<number, string[]> = {
  1: ['Good oil. Clean burn. The window won’t gutter tonight.'],
  2: ['For the window. Thank you.'],
};

/** All lines authored for heirlooms (for tests/world.test.ts text rules). */
export function allHeirloomLines(): string[] {
  const lines: string[] = [];
  for (const h of Object.values(HEIRLOOMS)) {
    lines.push(...h.dialogueLines);
  }
  lines.push(...ADA_OIL_REPLIES[1], ...ADA_OIL_REPLIES[2]);
  return lines;
}

/** All journal entries for heirlooms (for tests/world.test.ts prose checks). */
export function allHeirloomJournal(): JournalEntry[] {
  return Object.values(HEIRLOOMS).map((h) => ({ ...h.journal }));
}

/**
 * The flags that mean Silas trusts you with Hollis's name: his fox handed
 * back, Hollis's Echo settled, or a paper in Silas's hand or the Ashwatch
 * ledger that names him. The server checks the same list.
 */
export const HOLLIS_NAME_FLAGS = [
  'returned:whittled-fox',
  'echo:hollis',
  'paper:ashwatch-ledger-excerpts',
  'paper:silas-pine-offcut-scrap',
] as const;

/** Check if player knows Hollis's name. */
export function knowsHollisName(flags: readonly string[], _stage?: QuestStage): boolean {
  return HOLLIS_NAME_FLAGS.some((f) => flags.includes(f));
}

/** How many times oil has been given to Ada. */
export function countAdaOilGifts(flags: readonly string[]): number {
  let count = 0;
  for (const f of flags) {
    if (f.startsWith('ada-oil-gifts:')) {
      const n = parseInt(f.slice('ada-oil-gifts:'.length), 10);
      if (!Number.isNaN(n) && n > count) count = n;
    }
  }
  return count;
}

/** Heirlooms that have been granted on this save (flag `heirloom:<id>`). */
export function grantedHeirlooms(flags: readonly string[]): HeirloomId[] {
  const out: HeirloomId[] = [];
  for (const id of HEIRLOOM_IDS) {
    if (flags.includes(`heirloom:${id}`)) out.push(id);
  }
  return out;
}

/** Heirloom journal entries unlocked on this save. */
export function heirloomJournalEntries(flags: readonly string[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const id of HEIRLOOM_IDS) {
    if (flags.includes(`heirloom:${id}`)) {
      out.push({ ...HEIRLOOMS[id].journal });
    }
  }
  return out;
}
