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
import { ITEM_RULES } from '../lib/items.ts';

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

/** Canon lines spoken to guests (without a link) when an heirloom beat would otherwise trigger. */
export const HEIRLOOM_GUEST_LINES = {
  silas: 'Brack’s felling axe will keep on the wall. Sign in to your world and I’ll put it in your hands.',
  orrin: 'The mason pick will keep on the bench. Sign in to your world and come take it.',
  adaSpade: 'The garden spade will keep by the door. Sign in to your world and it’s yours.',
  adaOil: 'Hearth oil will keep in the flask. Sign in to your world before you spare it.',
  nan: 'The pole will keep by the stump until you’re signed in to your world.',
} as const;

/** All lines authored for heirlooms (for tests/world.test.ts text rules). */
export function allHeirloomLines(): string[] {
  const lines: string[] = [];
  for (const h of Object.values(HEIRLOOMS)) {
    lines.push(...h.dialogueLines);
  }
  lines.push(...ADA_OIL_REPLIES[1], ...ADA_OIL_REPLIES[2]);
  lines.push(...Object.values(HEIRLOOM_GUEST_LINES));
  for (const r of Object.values(HEIRLOOM_REFUSALS)) lines.push(...Object.values(r));
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
const HOLLIS_NAME_FLAGS = [
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

// ------------------------------------------------------------ offering a beat

/**
 * How near a named resident (Ada) you must stand: the server's
 * `residentReachTiles` (server/internal/api/items.go). Silas and Orrin use
 * their mender rows' own radius.
 */
export const RESIDENT_REACH_TILES = 4;

/** The world flag the north bridge's completion sets (Orrin's beat). */
export const NORTH_BRIDGE_DONE = 'project:north-bridge:complete';

/** Why a giver holds an heirloom back (the speaker says it in their own words). */
export type HeirloomRefusal = 'too-far' | 'not-yet' | 'granted' | 'offline' | 'busy' | 'failed';

/** What the client knows when deciding whether to offer (the server checks the same). */
export interface HeirloomContext {
  /** The save's area ("commons", "village", "wilds"), as progress carries it. */
  area: string;
  /** Where the hero stands now, in the save's pixels (as progress carries it). */
  x: number;
  y: number;
  flags: readonly string[];
  /** World flags (the north bridge), when loaded. */
  worldFlags: readonly string[];
  online: boolean;
  /** A grant for this heirloom is already on its way. */
  inFlight: boolean;
}

function within(c: Pick<HeirloomContext, 'area' | 'x' | 'y'>, area: string, tx: number, ty: number, r: number, tile = 16): boolean {
  if (c.area !== area) return false;
  const dx = c.x - (tx * tile + tile / 2);
  const dy = c.y - (ty * tile + tile / 2);
  return dx * dx + dy * dy <= (r * tile) * (r * tile);
}

/**
 * The server's story condition for each heirloom (grantHeirloom): Hollis's
 * name known; the north bridge mended; three flasks of window oil; Nan's
 * echo settled.
 */
function heirloomConditionMet(id: HeirloomId, c: Pick<HeirloomContext, 'flags' | 'worldFlags'>): boolean {
  switch (id) {
    case 'brack-felling-axe':
      return knowsHollisName(c.flags);
    case 'orrins-mason-pick':
      return c.worldFlags.includes(NORTH_BRIDGE_DONE);
    case 'ada-garden-spade':
      return countAdaOilGifts(c.flags) >= 3;
    case 'nans-lamplighter-pole':
      return c.flags.includes('echo:nan');
  }
}

/** The server's reach check for each heirloom: the same rows, the same radius. */
function heirloomInReach(id: HeirloomId, c: Pick<HeirloomContext, 'area' | 'x' | 'y'>): boolean {
  switch (id) {
    case 'brack-felling-axe':
    case 'orrins-mason-pick': {
      const m = ITEM_RULES.menders.find((r) => r.npc === HEIRLOOMS[id].giver);
      return !!m && within(c, m.area, m.tx, m.ty, m.radiusTiles);
    }
    case 'ada-garden-spade': {
      const r = ITEM_RULES.residents.find((v) => v.id === 'ada');
      return !!r && within(c, r.area, r.tx, r.ty, RESIDENT_REACH_TILES);
    }
    case 'nans-lamplighter-pole':
      return c.area === 'wilds';
  }
}

/**
 * Whether the server will grant this heirloom now: the beat is offered only
 * then. `null` means there is no beat at all (not earned, or already given);
 * a refusal means the giver says why instead of offering.
 */
export function heirloomReadiness(id: HeirloomId, c: HeirloomContext): { ok: true } | { ok: false; why: HeirloomRefusal } | null {
  if (c.flags.includes(`heirloom:${id}`)) return null;
  if (!heirloomConditionMet(id, c)) return null;
  if (c.inFlight) return { ok: false, why: 'busy' };
  if (!c.online) return { ok: false, why: 'offline' };
  if (!heirloomInReach(id, c)) return { ok: false, why: 'too-far' };
  return { ok: true };
}

/** A server refusal (or link failure) code, as the giver hears it. */
export function heirloomRefusalFor(code: string): HeirloomRefusal {
  switch (code) {
    case 'too-far-away':
      return 'too-far';
    case 'condition-unmet':
      return 'not-yet';
    case 'already-granted':
      return 'granted';
    case 'offline':
    case 'guest':
      return 'offline';
    case 'busy':
      return 'busy';
    default:
      return 'failed';
  }
}

/** Each giver's reply when they hold the heirloom back, in their own voice. */
export const HEIRLOOM_REFUSALS: Record<HeirloomId, Record<HeirloomRefusal, string>> = {
  'brack-felling-axe': {
    'too-far': 'Come round to the sawhorse first. I don’t hand an axe across a yard.',
    'not-yet': 'That axe goes to someone who can say whose it was. Not yet, neighbour.',
    granted: 'You’ve got Brack’s axe already. Keep the bit oiled and the wedge tight.',
    offline: 'Can’t write it in the plot book with the road to your world shut. The axe will keep on the wall.',
    busy: 'Hold on, I’m still getting it down off the wall.',
    failed: 'Hm. The plot book won’t take it just now. Ask me again in a moment; the axe isn’t going anywhere.',
  },
  'orrins-mason-pick': {
    'too-far': 'Come here, then. I’m not throwing a mason pick across the square.',
    'not-yet': 'Not till the north bridge stands. A pick’s for someone who’s seen one finished.',
    granted: 'You’ve got my pick already. Use it, or I’ll want it back.',
    offline: 'Not with the road to your world shut. The pick will keep on the bench.',
    busy: 'Patience. I’m finding the thing.',
    failed: 'Didn’t take. Ask me again in a moment. It isn’t going anywhere.',
  },
  'ada-garden-spade': {
    'too-far': 'Closer. I don’t hand a spade across a lane.',
    'not-yet': 'The window first. Three flasks.',
    granted: 'You have it already. A spade wants hands.',
    offline: 'The spade will keep by the door till the road to your world is clear.',
    busy: 'A moment.',
    failed: 'Not just now. Ask me again in a moment.',
  },
  'nans-lamplighter-pole': {
    'too-far': 'The pole leans just out of reach. Step in closer to the stump.',
    'not-yet': 'The owed lamp is still dark. The pole stays where she left it.',
    granted: 'The pole is already walking the road with you.',
    offline: 'The pole will keep by the stump until the road to your world is clear.',
    busy: 'Your hand is already on the pole.',
    failed: 'The pole won’t come free just now. Try again in a moment.',
  },
};

/** The giver's reply for a refusal, with who says it. */
export function heirloomRefusalLine(id: HeirloomId, why: HeirloomRefusal): { speaker: string; line: string } {
  return { speaker: HEIRLOOMS[id].speaker, line: HEIRLOOM_REFUSALS[id][why] };
}
