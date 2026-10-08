/**
 * The residents: Elara Quill, Finn Tolley, Hazel Penhallow and Ada Cooley
 * (canon: docs/lore/chronicle.md, Part VI). Unlike Mara, Pip and Orrin they
 * never move the quest on; they talk around it. A conversation is:
 *
 *   - the first time: who they are (and a journal entry), else a line or two
 *     for the quest stage, like the quest NPCs in ./world.ts;
 *   - then one line about the day: a festival, Elara's Turning notice, a
 *     village project, your homestead, or failing those the Mark (season).
 *
 * Reveal order (./papers.ts): nothing before the road is lit says the Six
 * survived. The late hints (Elara's turncaps and Bryony's light, Finn's
 * linseed box and hopper tally, Ada's oil receipts, Hazel's card) wait for
 * the quest to be complete, and the strongest wait for their papers.
 */
import type { QuestStage } from '../lib/state.ts';
import type { Dialogue, JournalEntry } from './world.ts';
import { TALK_COPY } from './talk.ts';

export type ResidentId = 'elara' | 'finn' | 'hazel' | 'ada';

export const RESIDENT_IDS: readonly ResidentId[] = ['elara', 'finn', 'hazel', 'ada'];

export function isResident(id: string): id is ResidentId {
  return (RESIDENT_IDS as readonly string[]).includes(id);
}

/** What a resident can see of the world when you talk to them. */
export interface ResidentContext {
  stage: QuestStage;
  flags: readonly string[];
  /** Today in Hearthwick (null when not known yet); `day` is the day of the wick. */
  calendar: { wick: string; day: number; mark: string; festival: string | null; notice: string | null } | null;
  /** The world's village projects by id (empty when the ledger wasn't read: guests, offline). */
  projects: Readonly<Record<string, 'open' | 'in-progress' | 'complete'>>;
  /** Your Commons plot: claimed at all, its tier when known, and whether you could claim one (a world). */
  home: { claimed: boolean; tier: number | null; connected: boolean };
}

type StageLines = Record<QuestStage, string[]>;

/** One line about the day; `{wick}` is the month (e.g. "Amber"). */
interface Topics {
  festival: Partial<Record<string, string>>;
  /** The day before a Turning (Elara posts it). */
  notice?: string;
  mark: Record<string, string>;
  /** By project id, then stage. */
  projects?: Partial<Record<string, Partial<Record<'open' | 'in-progress' | 'complete', string>>>>;
  home?: { unclaimed?: string; camp?: string; roofed?: string };
}

interface ResidentDef {
  /** The dialogue speaker (and the prompt's name). */
  name: string;
  fullName: string;
  intro: string[];
  stages: StageLines;
  /**
   * Late lines that take a stage line's place once their paper is in hand,
   * strongest first (only from `complete`).
   */
  papers?: { paper: string; lines: string[] }[];
  topics: Topics;
  journal: JournalEntry;
}

const RESIDENTS: Record<ResidentId, ResidentDef> = {
  elara: {
    name: 'Elara',
    fullName: 'Elara Quill',
    intro: [
      'Mind the jars. Elara Quill: forager, by trade. I am doing fieldwork on the drift. Two summers of it, so far.',
      'I came up from the Merrow Saltings on the spring flood. “On the flood,” we say. Up here they say “fast drift” and look worried.',
      'I read the outer Wilds for the Keeper’s notices. If you see E. Quill on the board, that’s me being right a day early.',
    ],
    stages: {
      new: ['You’ve only just come up the Low Road. Walk the village first. Wilds data is wasted on anyone who can’t find the well.'],
      accepted: [
        'Brackenwood, is it? Read the route stones. Keeper’s moss only grows where a lamp burned for years. It’s the best data in the Reaches.',
        'And use pencil. The ground forgets. Paper shouldn’t.',
      ],
      'clue-found': [
        'A closure mark. So the road was shut on purpose, and told to stay shut. Hearthwick nails the tablecloth down, then forgets why.',
        '…That was unkind. Noted, as Mara would say.',
      ],
      'guardian-defeated': [
        'You settled the warden with a naming? It isn’t a spell, you know. You corrected its data. I’d like the exact words, for my tables.',
      ],
      'lantern-lit': [
        'One anchored light on Ashwatch. The drift leans toward it, like a boat swinging on its line at slack water.',
      ],
      complete: [
        'The Wilds are quieter around your lamp. Slack water, we’d call it at home: the turn of the tide, when nothing pulls.',
        'My sister keeps a light on the Saltings. Bryony. She’d keep it whether I came home or not. …That isn’t data. Forget I said it.',
      ],
    },
    papers: [
      {
        paper: 'a-salting-drift-table',
        lines: [
          'You found a Salting table in the reeds. That’s Bryony’s hand. “The door is exactly where it was.” Of course it is. She pinned it.',
          'The flood brought her table up. It will bring her light up too, one spring. I am not waiting. I am calibrating.',
        ],
      },
      {
        paper: 'elara-quill-field-notes-turncaps',
        lines: [
          'Mara gave you my turncap notes. They still tilt east past the third stone, all of them, in agreement. I’ve stopped arguing with mushrooms.',
          'My tables have a column for every light I’ve fed them. There is no column for that one. I’m leaving room.',
        ],
      },
    ],
    topics: {
      festival: {
        'The Breaking':
          'The ice is off the Wend. Everything loose goes downhill on the flood. Or, very occasionally, up it. I would know.',
        'Carting Day':
          'Carting Day. They hang a collar on the gate for a cart. In the Saltings we leave a lamp at the tide line. Same sum, different shore.',
        Amberwake:
          'Amberwake: the first night of the sap tide. Maps go wrong fastest now. Anything I drew before Sap-wick is fiction.',
        'Closure Night':
          'Every lamp lit, and the road left dark on purpose. In the Saltings we’d never pin so much. Still. It is very beautiful.',
      },
      notice:
        'Dark of {wick}-wick tomorrow: the outer Wilds turn. I’ve posted it. Clear your cairns tonight. Charts start fresh after.',
      mark: {
        Mudrise: '{wick}-wick, Mudrise. Paths sink and come up somewhere new. On the flood, we’d say. The outer Wilds turn at the dark of it.',
        Carting: '{wick}-wick, the Green Hush. The drift slows almost to slack water; my tables are bored. The Turning still comes at the dark.',
        Amberfall: '{wick}-wick, Amberfall. The Wilds are shedding what they’re done with. I recalibrate daily, and still lose a stone a week.',
        Quiet: '{wick}-wick. The White Quiet: cold is stillness, and even the outer Wilds hold their breath. A good season for sums.',
      },
      home: {
        unclaimed: 'Silas has plots chalked along the lane. Take one. A house on skids rides the drift instead of fighting it. Very Saltings.',
        camp: 'Your camp is on my transect now. Keep the cot off the ground. The pamphlets are right about that, annoyingly.',
        roofed: 'A cottage on skids. Good. It will creak in Amberfall. That is the house noticing the ground, not falling down.',
      },
    },
    journal: {
      title: 'Elara Quill',
      body: 'A forager camped by the Wilds arch on the Commons, who calls it fieldwork. She came up from the Merrow Saltings on a spring flood, speaks of the drift in tide words, and signs the Turning notices on the board.',
    },
  },

  finn: {
    name: 'Finn',
    fullName: 'Finn Tolley',
    intro: [
      'Oh! Sorry. I was counting. Finn Tolley, the miller. This is the mill: Dad’s, then mine. The pond’s fed off the Wend, and the wheel turns on it.',
      'Forty-one. That’s how many turns the wheel makes while a stick floats from the upper bend to the grate. Dad timed it. I keep checking.',
    ],
    stages: {
      new: ['Mara needs flour, Hazel needs flour, and the wheel needs watching. I’m fine. I’m holding.'],
      accepted: [
        'The old road? Mind the stream in Brackenwood. The bridge on it is older than Orrin, and less cheerful.',
      ],
      'clue-found': [
        'A closure mark. Dad said Wenna shut the road the way you drop a sluice gate: you don’t, unless the water’s coming. …Don’t know why I said that.',
      ],
      'guardian-defeated': [
        'You sat the warden down? With words? I’d like to try that on the wheel. It never listens either.',
      ],
      'lantern-lit': [
        'There’s a light on Ashwatch. The pond has it in it, look. Forty-one ripples between me and it. Probably. I lost count.',
      ],
      complete: [
        'The road’s lit and the wheel’s still turning. Two good things at once. I keep waiting for the third one. The bad one.',
        'This is Dad’s box. Linseed. He left it me two winters gone. It was meant for somebody else. I don’t open it. I just hold it.',
      ],
    },
    papers: [
      {
        paper: 'note-in-the-linseed-box',
        lines: [
          'You’ve read Dad’s note. “Decide what a river owes a road.” Two winters, and I’ve only got as far as counting.',
          'Mara should see the box. Soon. I’ll take it to her. I’m holding till then, but I’m holding it out, now. That’s different.',
        ],
      },
      {
        paper: 'forty-one-and-holding',
        lines: [
          'You saw the scratches on the hopper. One for every… for everything off the grate. The first twenty-seven are Dad’s. I kept it up.',
        ],
      },
    ],
    topics: {
      festival: {
        'The Breaking': 'Ice is out and the Wend’s running fast. I lose count when it’s fast, so I don’t count. I just stand here. Somehow that’s worse.',
        'Carting Day': 'Carting Day. Hazel wants the fine sift for the twists, not the grist. I sifted it twice. Three times. It’s fine.',
        Amberwake: 'Amberwake. Every house sets a lamp in the window. Dad always set two at the mill. I still do. I never asked him why.',
        'Closure Night': 'Closure Night. I count the lamps lit in the village. Same number every year. Good. Same is good.',
      },
      notice: 'The outer Wilds turn tomorrow, Elara’s posted it. The Wend runs strange after a Turning. I’ll count twice.',
      mark: {
        Mudrise: 'Mudrise. The Wend is high and the wheel groans. Forty-one, forty-one, forty… it’s fine. It’s holding.',
        Carting: 'The Green Hush. Low water, slow wheel, long light. Best season for flour. Worst for counting: nothing changes.',
        Amberfall: 'Amberfall. First frost is coming. I clean the grate before it, every year. Dad’s rule.',
        Quiet: 'The White Quiet. The Wend goes slow under the ice, and so does the wheel. I can hear myself think. Not sure I like it.',
      },
      projects: {
        'mill-wheel': {
          open: 'Hear that? The wheel’s groaning. There’s a notice on the board: timber and fiber to lash the paddles. No pressure. Some pressure.',
          'in-progress': 'Half the paddles are lashed! I’m down to counting every other turn. Hazel calls that progress.',
          complete: 'Listen. No groan. New paddles, lashed tight, and she turns smooth. Forty-one and holding. For once I mean the wheel.',
        },
        'cooley-window-fund': {
          'in-progress': 'The mill pays toward Ada’s amber. Dad did, before me. We don’t talk about it, so I’d be grateful if you didn’t either.',
          complete: 'Ada’s lamp is paid in full. Mara wrote it down. I still left two drops at her door. Old ways of the mill. Of Dad.',
        },
      },
      home: {
        camp: 'A plot on the Commons, on skids, Silas says? Good. A thing that can move doesn’t crack. I read that somewhere. I think.',
        roofed: 'You’ve a roof now. I’ll send flour up. A house wants bread on its first night, Hazel says, and Hazel’s never wrong about bread.',
      },
    },
    journal: {
      title: 'Finn Tolley',
      body: 'The miller, at the door of the Tolley mill on the pond’s edge, where the wheel turns on water the Wend brings in. He counts its turns under his breath, and carries a small box that smells of linseed. He doesn’t open it.',
    },
  },

  hazel: {
    name: 'Hazel',
    fullName: 'Hazel Penhallow',
    intro: [
      'There you are. Pip has told me all about you, twice, at a run. I’m Hazel Penhallow. The bakery’s the one with the basket out front.',
      'Take a twist. No, take it. Anyone working for the village gets fed. Mara does soup and I do bread, and between us nobody wilts.',
      '…and if you’ve a minute after, I’ve a sponge that wants feeding.',
    ],
    stages: {
      new: ['Mara will have a job for you. She always does. Go on, then. Come back hungry.'],
      accepted: [
        'Brackenwood! Wash anything you pick, foxes walk on it. And if Pip tries to follow you, send them home with a message for me.',
      ],
      'clue-found': [
        'A closure mark. My mother said Wenna shut the road like shutting an oven door: too soon and it falls, too late and it burns.',
      ],
      'guardian-defeated': [
        'You sat that stone thing down? Pip will never stop talking about it. Thank you. Also, I’m going to need earplugs.',
      ],
      'lantern-lit': [
        'A light on the hill. I stood in the doorway with flour to my elbows and just looked. Pip’s on the mill roof. Of course they are.',
      ],
      complete: [
        'Pip says every fork in Brackenwood has a notch cut in it, all the same height. My brother Joss was a runner. He cut a notch at every fork.',
        'Joss liked the ends burnt. I still burn one tray a week, and the birds get the ends. Don’t look at me like that.',
      ],
    },
    papers: [
      {
        paper: 'keepers-twists-recipe-card',
        lines: [
          'You’ve read the back of my card, then. Thirty years and I still knead them until they fight back. Somebody has to remember the salt.',
        ],
      },
    ],
    topics: {
      festival: {
        'The Breaking': 'The ice is out! Candle hulls on the pond tonight. I’ve cracked walnuts since noon, and Pip has eaten half the boats.',
        'Carting Day': 'Carting Day: twists for the stalls, and one for the Commons gate, beside the hame. For luck, I tell the market women.',
        Amberwake: 'Amberwake. A lamp in every window, and a chair kept at the Long Table. I bake for the chair too. Somebody should.',
        'Closure Night': 'Closure Night. Every lamp lit, the road left dark. I keep the oven warm till morning. Don’t ask me why. I don’t know either.',
      },
      notice: 'Elara’s posted a Turning for tomorrow. Pip will be out at dawn to see what the Wilds give back. I’ll pack them extra.',
      mark: {
        Mudrise: 'Mudrise. Mud to the knees, and every child in Hearthwick tracking it through my shop. Mostly mine.',
        Carting: 'Long light and the Green Hush. Bread rises fast in Carting. So do tempers, in the queue.',
        Amberfall: 'Amberfall, and honey’s cheap. Sallow Ford oil hasn’t come up the road in thirty years, so it’s butter. The twists sit heavy.',
        Quiet: 'The White Quiet. The oven is the warmest place in Hearthwick. Pip does their copybook on the flour sacks.',
      },
      projects: {
        'well-canopy': {
          open: 'Leaves in the well again. Mara wants a canopy before Amber-wick. I want one before my next batch.',
          complete: 'The well has its canopy! No more leaf in the bread water. Orrin cut a mark on the lintel that means “here.” Sweet man.',
        },
      },
      home: {
        camp: 'Pip says you’ve a plot on the Commons. I’ll send twists up with the next errand. Pip will eat one on the way. Allow for it.',
        roofed: 'A roof of your own! A house wants bread on its first night. There’s a loaf in Pip’s satchel with your name on. In flour.',
      },
    },
    journal: {
      title: 'Hazel Penhallow',
      body: 'Pip’s mother, the baker, out in the square with a basket of Keeper’s twists. She feeds anyone who stands still long enough. Her brother Joss was the runner who went out with the Six.',
    },
  },

  ada: {
    name: 'Ada',
    fullName: 'Ada Cooley',
    intro: ['Ada Cooley.', 'The lamp is for my twins. Tam and Bett. They’re late.'],
    stages: {
      new: ['You came up the Low Road. Most go down it.'],
      accepted: ['East road. Keep to the stones.'],
      'clue-found': ['Wenna shut the road. She had to.', 'I keep my window lit. I have to.'],
      'guardian-defeated': ['The stone’s sat down. Good. It stood long enough.'],
      'lantern-lit': ['A light on the hill.', 'Good company.'],
      complete: ['Yours on the hill. Mine in the window.', '“Leave one for Ada,” they say. I leave one for them.'],
    },
    papers: [
      {
        paper: 'adas-oil-receipts',
        lines: ['Mara’s leaf. Wenna’s before her.', 'I know who pays. I trim it anyway.'],
      },
    ],
    topics: {
      festival: {
        'The Breaking': 'Ice is out. Bett floats the best hulls. Flat bottoms. Like her singing.',
        'Carting Day': 'They’ve hung the collar on the gate. Tam’s oxen never liked that gate.',
        Amberwake: 'Every window tonight. Mine every night.',
        'Closure Night': 'All the lamps lit. Mine’s no brighter. Doesn’t need to be.',
      },
      mark: {
        Mudrise: 'Wet season. Boots by the door.',
        Carting: 'Long light. I light it anyway.',
        Amberfall: 'Leaf-fall. The wick wants trimming twice.',
        Quiet: 'Cold. Trim it short in the Quiet. It lasts.',
      },
      projects: {
        'cooley-window-fund': {
          open: 'Mara put my lamp on the board. I said no. She wrote “Noted.”',
          'in-progress': 'People keep bringing wicks. I’ve wicks for a hundred years. I’ll need them.',
          complete: 'Paid in full, Mara says. I’d have trimmed it anyway.',
        },
      },
      home: {
        roofed: 'You’ve a door now. Put a lamp in the window. Then they know which one.',
      },
    },
    journal: {
      title: 'Ada Cooley',
      body: 'Eighty-eight, by her window on the east side of Hearthwick. Her twins, Tam and Bett, went out with the Six. She has kept a lamp in that window every night since, and trims it every twilight. She says very little.',
    },
  },
};

/** The speaker name for a resident ("Elara"). */
export function residentName(id: ResidentId): string {
  return RESIDENTS[id].name;
}

/** Full names, for portraits and tests ("Elara Quill"). */
export function residentFullName(id: ResidentId): string {
  return RESIDENTS[id].fullName;
}

// ------------------------------------------------------------ the mill

/**
 * What the Tolley mill's hopper shows you. The tally on its side is a
 * mystery until Finn's own paper (forty-one-and-holding) says what it counts.
 */
export function millHopperLines(flags: readonly string[]): string[] {
  if (flags.includes('paper:forty-one-and-holding')) {
    return [
      'The hopper. Tallies in fives down its side, and the first twenty-seven cut in a heavier hand: Aldo’s.',
      'The rest are Finn’s. One for every fox cleaned off the grate since. He hasn’t missed an autumn.',
    ];
  }
  return [
    'A grain hopper on splayed legs, flour in every seam. Its side is scratched with tallies in clusters of five, a good many of them.',
    'Not grain sacks. Not turns of the wheel. Whatever they count, someone has kept count for years.',
  ];
}

// ------------------------------------------------------------ meeting

const MET_PREFIX = 'met:';

/**
 * What a resident calls out when you knock and they're elsewhere
 * (docs/design/indoors.md 2.6): one line per spot away from home, keyed by
 * the cycle's spot (`content/residents.json`), with where they call from.
 * Doors never latch: after the line you go in to an empty room.
 */
export const KNOCK_LINES: Readonly<Record<string, Readonly<Record<string, { from: string; line: string }>>>> = {
  hazel: {
    square: { from: 'from the square', line: 'Out with the basket. Shop’s open, mind the oven.' },
  },
  finn: {
    door: { from: 'round the front', line: 'Wheel’s turning, I’m round the front.' },
  },
  // TODO(A): the spot key must match Elara's out-of-library spot in `content/residents.json`.
  elara: {
    square: { from: 'from the square', line: 'Out taking readings. The shelves are open; donations wait for me.' },
  },
};

/** A choice's action that opens the library panel: `library:shelf` (the whole collection) or `library:donate`. */
export const LIBRARY_ACTION = 'library:';

/**
 * Elara keeps the library half of each hour (docs/design/indoors.md 3.3,
 * revised): she says she's studying the drift, and the library is where she
 * does it. Talking to her there opens the shelves, and donating goes through
 * her. (Canon: she's stranded, not studying; nothing here says so.)
 */
export const KEEPER = {
  lines: [
    'The reading room is the quietest instrument in Hearthwick. Paper holds still, so I can see what the drift does around it.',
    'I keep the room while I take readings. Every page here was written by someone the ground was busy forgetting. Comparative data.',
  ],
  /** After her introduction, the first time you meet her here. */
  firstLine: 'I keep the library while I read the drift. Half the hour, anyway. The rest I’m out checking my sums against the square.',
  shelves: { text: 'Show me the shelves', reply: ['Help yourself. Put things back where you found them. The drift won’t, so we have to.'] },
  donate: { text: 'I’ve a paper for the shelves', reply: ['Let me see it. If it’s new to the room, it goes in the ledger and on a shelf. If it’s wet, it goes by the stove first.'] },
  /** A donation refused because she'd stepped out (the server's `not-here`). */
  away: 'A note on Elara’s desk: “Out taking readings on the square. Back on the half hour. Donations wait for me. E. Q.”',
} as const;

/**
 * Elara's talk while she keeps the library: her lines (her introduction the
 * first time), then the shelves and Donate, keeping anything else on offer.
 */
export function keeperTalk(base: Dialogue, first: boolean): Dialogue {
  const lines = first ? [...base.lines, KEEPER.firstLine] : [...KEEPER.lines];
  // Her story lines are the stage's, not the room's: "Hear it again" waits for the square.
  const rest = (base.choices ?? []).filter((c) => !c.dismiss && c.text !== 'Not yet' && c.text !== TALK_COPY.again);
  return {
    ...base,
    lines,
    choices: [
      { text: KEEPER.shelves.text, reply: [...KEEPER.shelves.reply], action: `${LIBRARY_ACTION}shelf` },
      { text: KEEPER.donate.text, reply: [...KEEPER.donate.reply], action: `${LIBRARY_ACTION}donate` },
      ...rest,
      { text: 'Not yet', dismiss: true },
    ],
  };
}

/** The story flag recording that you met a resident, and at which quest stage. */
export function metFlag(id: ResidentId, stage: QuestStage): string {
  return `${MET_PREFIX}${id}@${stage}`;
}

/** The quest stage you met this resident at, or null if you haven't. */
export function metAt(flags: readonly string[], id: ResidentId): QuestStage | null {
  const prefix = `${MET_PREFIX}${id}@`;
  const f = flags.find((x) => x.startsWith(prefix));
  return f ? (f.slice(prefix.length) as QuestStage) : null;
}

/** Residents' journal entries met at `stage`, in the order they were met. */
export function residentJournal(flags: readonly string[], stage: QuestStage): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const f of flags) {
    if (!f.startsWith(MET_PREFIX)) continue;
    const [id, at] = f.slice(MET_PREFIX.length).split('@');
    if (at !== stage || !isResident(id)) continue;
    const e = RESIDENTS[id].journal;
    if (!out.some((o) => o.title === e.title)) out.push({ title: e.title, body: e.body });
  }
  return out;
}

/** Every resident's journal entry (tests). */
export function allResidentJournal(): JournalEntry[] {
  return RESIDENT_IDS.map((id) => ({ ...RESIDENTS[id].journal }));
}

// ------------------------------------------------------------ talking

export interface ResidentTalk {
  dialogue: Dialogue;
  /** What the day's line was about ('festival:Amberwake', 'notice', …), for "has news" markers. */
  topic: string;
  /** True when this is the first meeting (the caller records `metFlag`). */
  first: boolean;
  /** The story part (an introduction or the stage's lines) and what it is ('intro', a stage, 'complete:paper:<id>'). */
  story: { key: string; lines: string[] };
  /** The line about the day, if any, and what it's about ('festival:…', 'mark:Bud', …). */
  day: { topic: string; line: string } | null;
}

function stageLines(def: ResidentDef, ctx: ResidentContext): string[] {
  if (ctx.stage === 'complete') {
    for (const p of def.papers ?? []) if (ctx.flags.includes(`paper:${p.paper}`)) return [...p.lines];
  }
  return [...def.stages[ctx.stage]];
}

/**
 * The line about the day. A festival comes first, then the day before a
 * Turning; otherwise a village project, your plot and the season take turns
 * by the day of the wick, so the same few lines don't crowd out the rest.
 */
function topicLine(def: ResidentDef, ctx: ResidentContext): { topic: string; line: string } | null {
  const t = def.topics;
  const cal = ctx.calendar;
  const fill = (s: string) => (cal ? s.replace(/\{wick\}/g, cal.wick) : s);
  if (cal?.festival && t.festival[cal.festival]) return { topic: `festival:${cal.festival}`, line: fill(t.festival[cal.festival]!) };
  if (cal?.notice && t.notice) return { topic: `notice:${cal.wick}`, line: fill(t.notice) };
  const turns: { topic: string; line: string }[] = [];
  for (const [id, byStage] of Object.entries(t.projects ?? {})) {
    const st = ctx.projects[id];
    const line = st && byStage?.[st];
    if (line) {
      turns.push({ topic: `project:${id}:${st}`, line });
      break;
    }
  }
  if (t.home) {
    const { claimed, tier, connected } = ctx.home;
    const line = !claimed ? (connected ? t.home.unclaimed : undefined) : (tier ?? 0) >= 1 ? t.home.roofed ?? t.home.camp : t.home.camp;
    if (line) turns.push({ topic: `home:${claimed ? (tier ?? 0) : 'none'}`, line });
  }
  if (cal && t.mark[cal.mark]) turns.push({ topic: `mark:${cal.wick}`, line: fill(t.mark[cal.mark]) });
  if (turns.length === 0) return null;
  const pick = turns[((cal?.day ?? 1) - 1) % turns.length];
  return pick;
}

/**
 * What a resident says right now. Pure: the caller records the meeting
 * (`metFlag`) and hands any paper over (./papers.ts handoverFor).
 * Throws for ids that aren't residents.
 */
export function residentTalk(id: string, ctx: ResidentContext): ResidentTalk {
  if (!isResident(id)) throw new Error(`Unknown resident id ${JSON.stringify(id)}`);
  const def = RESIDENTS[id];
  const first = metAt(ctx.flags, id) === null;
  const story = first ? [...def.intro] : stageLines(def, ctx);
  const paper = !first && ctx.stage === 'complete' ? (def.papers ?? []).find((p) => ctx.flags.includes(`paper:${p.paper}`)) : undefined;
  const topic = topicLine(def, ctx);
  const lines = [...story];
  if (topic) lines.push(topic.line);
  return {
    dialogue: { speaker: def.name, lines },
    topic: `${first ? 'first' : ctx.stage}:${topic?.topic ?? 'none'}`,
    first,
    story: { key: first ? 'intro' : paper ? `complete:paper:${paper.paper}` : ctx.stage, lines: story },
    day: topic,
  };
}

/** Every line a resident can say, for the text rules in tests (wick filled in). */
export function allResidentLines(): string[] {
  const out: string[] = [];
  for (const id of RESIDENT_IDS) {
    const d = RESIDENTS[id];
    out.push(...d.intro, ...Object.values(d.stages).flat(), ...(d.papers ?? []).flatMap((p) => p.lines), ...topicalLines(d));
    if (id === 'finn') out.push(...millHopperLines([]), ...millHopperLines(['paper:forty-one-and-holding']));
    out.push(...Object.values(KNOCK_LINES[id] ?? {}).map((k) => k.line));
    if (id === 'elara') out.push(...KEEPER.lines, KEEPER.firstLine, KEEPER.shelves.text, ...KEEPER.shelves.reply, KEEPER.donate.text, ...KEEPER.donate.reply, KEEPER.away);
  }
  return out;
}

function topicalLines(d: ResidentDef): string[] {
  const t = d.topics;
  return [
    ...Object.values(t.festival),
    t.notice,
    ...Object.values(t.mark),
    ...Object.values(t.projects ?? {}).flatMap((p) => Object.values(p ?? {})),
    ...Object.values(t.home ?? {}),
  ]
    .filter((s): s is string => !!s)
    .map((s) => s.replace(/\{wick\}/g, 'Amber'));
}

/**
 * Lines a resident can say before the road is lit (reveal-order tests):
 * the introductions, the early stages, and every line about the day (those
 * can come up at any stage).
 */
export function earlyResidentLines(): string[] {
  const out: string[] = [];
  for (const id of RESIDENT_IDS) {
    const d = RESIDENTS[id];
    out.push(...d.intro, ...topicalLines(d));
    for (const s of ['new', 'accepted', 'clue-found', 'guardian-defeated', 'lantern-lit'] as const) out.push(...d.stages[s]);
  }
  return out;
}
