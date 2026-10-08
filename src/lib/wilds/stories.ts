/**
 * Story finds of the outer Wilds — pure, so they can be tested: which found
 * text a story site gives back, and the calendar-driven finds (the notice
 * board, the hame, the Turning itself). The client uses them to predict what
 * a place offers; the server's story rules decide (server-first.md 2.2).
 * Finds are `paper:<id>` marks, settled Echoes `echo:<member>` marks.
 *
 * Reveal order (src/content/papers.ts): "late" finds wait for the road to be
 * lit (quest complete), the same gate the late project papers use.
 */
import { echoFlag, type EchoMember } from '../../content/echoes.ts';
import type { SiteKind } from './outer.ts';

/** One-way story flag: this player has seen the outer Wilds turn. */
export const TURNED_FLAG = 'wilds:turned';

const paperFlag = (id: string) => `paper:${id}`;

export interface StoryContext {
  flags: readonly string[];
  /** The road is lit (quest complete): late finds are due. */
  late: boolean;
  /** The Mark of the outer epoch (Mudrise, Carting, Amberfall, Quiet). */
  mark: string | null;
}

// ------------------------------------------------------------ Echoes

/** Who waits at each Echo camp is the server's (the region read's `echoes`). */
export function echoSettled(flags: readonly string[], member: EchoMember): boolean {
  return flags.includes(echoFlag(member));
}

// ------------------------------------------------------------ finds

export interface FindRule {
  paper: string;
  /** Due now? */
  due: (ctx: StoryContext) => boolean;
  /** Where/why, for docs and tests. */
  hook: string;
}

/** The text each story site gives back, and when. */
export const SITE_PAPERS: Partial<Record<SiteKind, FindRule>> = {
  given: {
    paper: 'nan-greer-trail-journal',
    hook: 'Given back at a Turning beside the Tangle crossing, once the road is lit and you have seen the outer Wilds turn',
    due: (c) => c.late && c.flags.includes(TURNED_FLAG),
  },
  cairn: {
    paper: 'mary-fenns-cairn-slip',
    hook: 'Under the third white river-stone of the Amberwash cairn, once you have read Elias Fenn’s will',
    due: (c) => c.flags.includes(paperFlag('will-of-elias-fenn')),
  },
  nest: {
    paper: 'the-jackdaws-display',
    hook: 'In a jackdaw’s nest in a dead iron-oak in the Whitequiet, once the road is lit',
    due: (c) => c.late,
  },
  reeds: {
    paper: 'a-salting-drift-table',
    hook: 'Caught in the reeds of a Wend backwater on a Mudrise flood-drift, once Mara has given you Elara’s notes',
    due: (c) => c.mark === 'Mudrise' && c.flags.includes(paperFlag('elara-quill-field-notes-turncaps')),
  },
  plank: {
    paper: 'dorrits-second-span',
    hook: 'A plank half-buried at the Tangle crossing, where the bridge tore',
    due: () => true,
  },
};

/** The found text a site holds for this player right now, if any. */
export function siteFind(kind: SiteKind, ctx: StoryContext): string | null {
  const rule = SITE_PAPERS[kind];
  if (!rule || ctx.flags.includes(paperFlag(rule.paper)) || !rule.due(ctx)) return null;
  return rule.paper;
}

/** Finds that ride the calendar rather than a place in the Wilds. */
export const CALENDAR_PAPERS = {
  /** Witnessing a Turning (in the outer Wilds as it turns, or coming back to a turned one). */
  turning: {
    paper: 'weir-effect-survey-draft',
    hook: 'The first Turning you see after the road is lit',
    due: (c: StoryContext) => c.late,
  },
  /** Reading a notice board (the village or the Commons). */
  board: {
    paper: 'notices-from-the-board',
    hook: 'A notice board, the first time you read it after seeing a Turning with the road lit',
    due: (c: StoryContext) => c.late && c.flags.includes(TURNED_FLAG),
  },
  /** The hame on the Commons gate, on Carting Day. */
  hame: {
    paper: 'the-hame-polishers-list',
    hook: 'The polishers’ roll inside the Commons gate, on Carting Day',
    due: () => true,
  },
} as const;

/** Papers that need a system this build does not have yet (see the report). */
export const UNBUILT_PAPERS: Record<string, string> = {
  'joss-penhallow-letter-map-case': 'The finale: relighting the eastern chain until the Sallow Ford lamp answers and the map case comes west. There is no eastern lantern chain or Sallow Ford yet.',
};

/** Due now and not yet held. */
export function calendarFind(kind: keyof typeof CALENDAR_PAPERS, ctx: StoryContext): string | null {
  const rule = CALENDAR_PAPERS[kind];
  if (ctx.flags.includes(paperFlag(rule.paper)) || !rule.due(ctx)) return null;
  return rule.paper;
}
