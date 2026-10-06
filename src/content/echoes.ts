/**
 * The outer Wilds' writing: the region's card, the Echoes of the Six, the
 * places where the deep drift gives a text back, and the Turning.
 *
 * Canon: docs/lore/chronicle.md Part V. Echoes are not ghosts: the woods
 * replaying a mundane, waiting moment of one of the Six. Settling one lets
 * the moment finish kindly and file itself away. Reveal order
 * (src/content/papers.ts): nothing here says who survived the Lull Run; the
 * twins' Echoes (Bett's song, Tam's ox-words) wait until the road is lit.
 */
import type { JournalEntry, LocationInfo } from './world.ts';

export const WILDS_OUTER: { id: 'outer-1'; location: LocationInfo } = {
  id: 'outer-1',
  location: {
    name: 'The Whitequiet',
    eyebrow: 'Past the Tangle crossing',
    tagline: 'The deep drift. It turns every wick and keeps what it is given.',
    description: 'Pale woods past the place where the bridge tore. The land here is never the same two wicks running: the Keeper posts the Turning a day ahead, and the cairn-walkers clear their stones.',
  },
};

/** The Six (docs/lore/chronicle.md Part IV). */
export type EchoMember = 'hollis' | 'tam' | 'bett' | 'dorrit' | 'joss' | 'nan';

/** What stands at the phantom camp. */
export type EchoProp = 'kettle' | 'yoke' | 'song' | 'stake' | 'whistle' | 'wick';

export interface EchoDef {
  member: EchoMember;
  /** Who the moment belongs to (shown once settled, never before). */
  name: string;
  prop: EchoProp;
  /** Walking up to the camp: what the woods are replaying. */
  scene: string;
  /** The prompt over the owed lamp. */
  verb: string;
  /** Settling: the moment finishes. */
  settle: string[];
  /** Waits until the road is lit (the reveal order). */
  late?: boolean;
  /** Only in the far east, toward Sallow Ford. */
  east?: boolean;
  /** The found text this Echo gives back. */
  paper?: string;
  /** A keepsake with no living owner that can be left at this camp. */
  keepsake?: EchoKeepsake;
}

/**
 * A keepsake with no living owner in the village, left at the person's Echo
 * camp (docs/items/overview.md, "Returning keepsakes"): the camp's
 * interaction offers to take it, the leave itself is the server's `return`
 * item op (`keep:return:<def>:<member>`), and the echo settles a little
 * softer for it. Only Bett's and Nan's keepsakes exist; Dorrit has none yet.
 */
export interface EchoKeepsake {
  /** The keepsake item (content/items.json `belongsTo`). */
  def: string;
  /** The prompt at the camp, and the leave choice ("Leave the … here"). */
  label: string;
  /** The camp's lines while you carry it and haven't left it yet. */
  offer: string[];
  /** The one short line for guests: the leave waits until they're signed in. */
  guest: string;
  /** When the keep is left (the server's yes): the echo's own register. */
  leave: string[];
  /** The settle adds this when the keep came before the settling. */
  softened: string;
  /** The journal entry written the first time you leave it. */
  journal: JournalEntry;
}

export const ECHOES: readonly EchoDef[] = [
  {
    member: 'hollis',
    name: 'Hollis Brack',
    prop: 'kettle',
    scene: 'A kettle on cold stones, a half-whittled fox beside it. Somewhere a man laughs with his whole back, at a joke nobody here can hear. The kettle never boils.',
    verb: 'Light the owed lamp',
    settle: [
      'You hang the lamp on the camp’s bent hook and strike it. The flame takes.',
      'The kettle starts to tick, then sing. Beside it, the knife finishes the fox’s second ear.',
      'The laugh comes once more, softer, and the camp is only a camp. The moment has gone where moments go.',
    ],
  },
  {
    member: 'tam',
    name: 'Tam Cooley',
    prop: 'yoke',
    scene: 'A yoke peg in the moss, and a low voice talking a frightened ox through mud that isn’t there. The words come and go with the wind.',
    verb: 'Light the owed lamp',
    settle: [
      'The lamp catches, and the voice steadies: “Easy now. Find the bottom.”',
      'Something heavy settles in the dark, the way a beast does when it trusts the hand on its neck. The voice goes quiet, satisfied.',
      'The yoke peg is still there when the light steadies. Words are scratched into it.',
    ],
    late: true,
    east: true,
    paper: 'tams-ox-words',
  },
  {
    member: 'bett',
    name: 'Bett Cooley',
    prop: 'song',
    scene: 'Someone is singing, deliberately flat, to the rhythm of a walking ox. The verse breaks off in the same place every time, and starts again.',
    verb: 'Light the owed lamp',
    settle: [
      'You light the lamp. The voice reaches the place where it always stops, and does not stop.',
      'It finds the true note at last, and sings the verse out to its end.',
      'The woods hold the last line a moment longer than they need to. Then it is only birdsong.',
    ],
    late: true,
    paper: 'betts-flat-verse',
    keepsake: {
      def: 'beeswax-candle',
      label: 'Leave the beeswax candle here',
      offer: [
        'Someone kept this bedroll, and keeps it still. In your pocket, the beeswax candle sits warm as a held hand, red yarn round its middle.',
        'Never lit, saved for a birthday. It has come the long way round, and this is where it was going.',
      ],
      guest: 'The candle will keep in your pocket until you’re signed in to your world.',
      leave: [
        'You set the candle by the bedroll, wick towards the lamp, and the red yarn round its middle catches the light.',
        'The song hums on, flat and content, and somewhere it is a birthday after all. The candle got where it was going.',
      ],
      softened: 'And by the bedroll, the candle stands where you left it — saved for a birthday, and the birthday kept.',
      journal: {
        title: 'Bett’s Candle',
        body: 'Left at Bett Cooley’s camp in the Whitequiet: a beeswax candle saved for a birthday and never lit, red yarn round its middle. The verse hummed on, flat and content, and the camp felt less like waiting.',
      },
    },
  },
  {
    member: 'dorrit',
    name: 'Dorrit Venn',
    prop: 'stake',
    scene: 'Chalk lines on a plank: one joint, drawn and redrawn. A surveyor’s stake keeps leaning crooked, straightening, leaning crooked again.',
    verb: 'Light the owed lamp',
    settle: [
      'In the lamplight the stake is left as it was: crooked, exactly.',
      'Whoever was measuring is content with it. The chalk stops moving. The joint is drawn the flexing way, with oak pegs.',
    ],
  },
  {
    member: 'joss',
    name: 'Joss Penhallow',
    prop: 'whistle',
    scene: 'One dented note from a tin whistle, cut off before it finishes. It tries again. And again, a little further each time.',
    verb: 'Light the owed lamp',
    settle: [
      'The lamp catches, and the note runs out long and clear across the trees, all the way to its end.',
      'For a moment you could swear it carried west.',
    ],
  },
  {
    member: 'nan',
    name: 'Nan Greer',
    prop: 'wick',
    scene: 'A lamplighter’s pole leans on a stump beside an unlit lamp, its wick trimmed and waiting. Someone keeps reaching for the flint and not quite finding it.',
    verb: 'Strike the light she was reaching for',
    settle: [
      'You strike the flint. The trimmed wick takes at the first spark, the way a well-kept wick does.',
      'Close by, someone lets out a breath they have held a long time. A route mark in the bark beside the lamp reads, plainly: this way.',
    ],
    keepsake: {
      def: 'road-nails',
      label: 'Leave the eleven road-nails here',
      offer: [
        'The wick is trimmed and the flint lies ready by the lamp. In your pack: eleven road-nails, stamped wheel and wave, lantern-post nails.',
        'Nails for the posts of a road that still wants its posts. They could rest here, where the mending would start.',
      ],
      guest: 'The road-nails will keep in your pack until you’re signed in to your world.',
      leave: [
        'You lay the eleven road-nails out by the lamp, stamps up where the light can find them: wheel and wave, eleven times over.',
        'The reaching hand stills. There is mending in the world again, and it knows where the nails are.',
      ],
      softened: 'By the lamp, the eleven road-nails lie counted and kept. Her stretch will hold, every post of it.',
      journal: {
        title: 'Nan’s Road-Nails',
        body: 'Left at Nan Greer’s camp in the Whitequiet: eleven stamped road-nails, wheel and wave, laid by the lamp with the trimmed wick. The reaching hand stilled, as if the mending were promised.',
      },
    },
  },
];

export const ECHO_UNSETTLED_EYEBROW = 'An Echo';
export const ECHO_SETTLED_LINE = 'A settled camp. The owed lamp burns steady on its hook; nothing here is waiting any more.';

/** Story flag for a settled Echo (one per member, kept forever). */
export function echoFlag(member: EchoMember): string {
  return `echo:${member}`;
}

/** Story flag for a keepsake left at the person's camp (the server sets it with `returned:`). */
export function echoSoftenedFlag(member: EchoMember): string {
  return `echo:${member}:softened`;
}

// ------------------------------------------------------------ left keepsakes

/** The keep that can be left at this member's camp, if any (Dorrit has none yet). */
export function echoKeepsakeOf(member: EchoMember): EchoKeepsake | null {
  return ECHOES.find((e) => e.member === member)?.keepsake ?? null;
}

/** The echo and its keep, by item def (null for the living owners' keepsakes). */
export function echoForKeepsake(def: string): { echo: EchoDef; keep: EchoKeepsake } | null {
  for (const e of ECHOES) if (e.keepsake && e.keepsake.def === def) return { echo: e, keep: e.keepsake };
  return null;
}

/** Who speaks when a keep is left: the echo while it still waits, the camp after. */
export function echoCampSpeaker(member: EchoMember, settled: boolean): string {
  const name = ECHOES.find((e) => e.member === member)?.name ?? member;
  return settled ? `${name}’s Echo Camp` : `An Echo — ${name}`;
}

/**
 * Journal entries for keepsakes already left (the `returned:<def>` flags;
 * one per keep, and leaving is one-time). Pure: callers pass the save's flags.
 */
export function echoKeepsakeJournalEntries(flags: readonly string[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const e of ECHOES) {
    if (e.keepsake && flags.includes(`returned:${e.keepsake.def}`)) out.push({ ...e.keepsake.journal });
  }
  return out;
}

/** Every line authored for the camps' keepsakes (tests: canon voice, length, in-world). */
export function allEchoKeepsakeLines(): string[] {
  return ECHOES.flatMap((e) => {
    const k = e.keepsake;
    return k ? [k.label, ...k.offer, k.guest, ...k.leave, k.softened] : [];
  });
}

/** Every keepsake journal entry (tests). */
export function allEchoKeepsakeJournal(): JournalEntry[] {
  return ECHOES.flatMap((e) => (e.keepsake ? [{ ...e.keepsake.journal }] : []));
}

// ------------------------------------------------------------ given-back places

/** Lines for the places where the deep drift gives a text back. */
export const SITE_TEXT = {
  given: {
    name: 'Drift-Caught Bundle',
    look: 'Something oiled and bound, left where the land gave it up beside the crossing.',
    verb: 'Pick up the bundle',
  },
  cairn: {
    name: 'The Amberwash Cairn',
    look: 'A forage cairn of river-stones, three of them white, topped and tended.',
    verb: 'Lift the third white stone',
  },
  nest: {
    name: 'Dead Iron-Oak',
    look: 'A dead iron-oak, bare as bone. High in its crotch, a jackdaw’s nest of dry grass and drift-twigs.',
    verb: 'Look into the nest',
  },
  reeds: {
    name: 'A Backwater of the Wend',
    look: 'Still water and reeds. The flood-drift leaves things here, caught in the stems.',
    verb: 'Free what’s caught in the reeds',
  },
  plank: {
    name: 'Half-Buried Plank',
    look: 'A heavy iron-oak plank, half-buried where the bridge tore. Chalk still shows on it.',
    verb: 'Brush off the plank',
  },
} as const;

// ------------------------------------------------------------ the Turning

/** The moment itself, over the screen. */
export const TURNING_TITLE = 'The Wilds shift.';

/** Entering after a Turning you weren't there for. */
export const TURNED_SINCE_LINE = 'The outer Wilds have turned since you were last here. None of it is where you left it.';
