/**
 * Papers — the owner's found texts as collectible, readable things.
 *
 * The words live in docs/lore/texts (generated into papers-text.ts). This
 * file is the design layer on top: how each paper looks when you read it,
 * and where it is found. The reveal order follows docs/lore/chronicle.md —
 * early finds build the world and the Closure; nothing before the road is
 * lit says the Six survived; Aldo's linseed-box note, Joss's letter, the
 * Count House scrap and Nan's journal wait for systems that come later.
 *
 * A found paper is the story flag `paper:<id>` in GameState.flags.
 */
import type { AreaId, QuestStage } from '../lib/state.ts';
import { QUEST_STAGES } from '../lib/state.ts';
import { PAPER_COLLECTIONS, PAPER_TEXTS, type PaperTextRecord } from './papers-text.ts';

/** How the reading view dresses the page. */
export type PaperStyle =
  | 'ledger' // ruled account book, iron-gall ink
  | 'letter' // folded writing paper
  | 'broadside' // posted notice, block capitals, a seal
  | 'card' // index/recipe card
  | 'song' // verses, centred
  | 'page' // a printed book page
  | 'notebook' // field notes, journals, copybooks
  | 'scrap' // offcuts, slabs, charcoal on wood
  | 'record'; // clerks' forms, legal records, invoices

/** What a placed paper looks like lying in the world. */
export type PickupLook = 'folded' | 'scroll' | 'slate';

/** Sources the homestead/Wilds work will hook up (declared, not built yet). */
export type LaterKind = 'commons' | 'wilds-poi' | 'wilds-chest' | 'village-project' | 'turning';

export type QuestNpc = 'mara' | 'pip' | 'orrin';

export type FindSource =
  /** On the Hearthwick Library's shelves from day one: public, no spoilers. */
  | { kind: 'library-start' }
  /** A pickup on a tile; `after` hides it until the quest reaches that stage. */
  | { kind: 'placed'; area: AreaId; tx: number; ty: number; look: PickupLook; after?: QuestStage; spot: string }
  /**
   * A quest beat. With `from`, handed over by that NPC in any conversation
   * at or after `stage`; without, found the moment the quest reaches it.
   */
  | { kind: 'quest'; stage: QuestStage; from?: QuestNpc; spot: string }
  /** Given by an NPC once the main quest is done. */
  | { kind: 'gift'; from: QuestNpc; stage: QuestStage }
  /** Declared for later systems; `hook` says what should trigger it. */
  | { kind: LaterKind; hook: string };

export interface Paper extends PaperTextRecord {
  style: PaperStyle;
  source: FindSource;
  /** Where to look, shown while it is not yet found (never the text). */
  hint: string;
}

interface Design {
  style: PaperStyle;
  source: FindSource;
  hint?: string;
}

const DESIGN: Record<string, Design> = {
  // ---- Voices of the Drift
  'ashwatch-ledger-excerpts': {
    style: 'ledger',
    source: { kind: 'quest', stage: 'clue-found', from: 'mara', spot: 'Mara copies the pre-Closure pages once you bring back the closure mark' },
    hint: 'Mara keeps her grandmother’s ledger. Bring her news from Ashwatch.',
  },
  'to-the-bench-across': { style: 'scrap', source: { kind: 'commons', hook: 'Silas’s toolbox, on his Commons plot (the east edge of the Commons)' } },
  'oak-hall-edict-on-the-stealing-of-shade': { style: 'broadside', source: { kind: 'library-start' } },
  'elara-quill-field-notes-turncaps': {
    style: 'notebook',
    source: { kind: 'gift', from: 'mara', stage: 'complete' },
    hint: 'Someone in Hearthwick is holding these until the road is lit.',
  },
  'the-reed-and-roll-mill-chant': { style: 'song', source: { kind: 'library-start' } },
  'count-house-tally-book-scrap': { style: 'record', source: { kind: 'village-project', hook: 'Mending Orrin’s North Bridge: folded inside a copy of the Carters’ Compact under the span' } },
  'note-in-the-linseed-box': { style: 'letter', source: { kind: 'village-project', hook: 'The mill: Finn opens Aldo’s linseed box (late — after the eastern lanterns)' } },
  // ---- Vol. II
  'keepers-twists-recipe-card': {
    style: 'card',
    source: { kind: 'gift', from: 'pip', stage: 'complete' },
    hint: 'Pip runs errands for the bakery. Ask after the road is lit.',
  },
  'joss-penhallow-letter-map-case': { style: 'letter', source: { kind: 'turning', hook: 'The finale: the Sallow Ford lamp answers, and the map case comes west' } },
  'annotated-flora-of-the-eastern-reaches': {
    style: 'page',
    source: { kind: 'placed', area: 'woodland', tx: 24, ty: 10, look: 'folded', spot: 'Between the stream and the faded route marker, where the moss grows on old stones' },
  },
  'tarrow-requisition-reply-hinges': { style: 'record', source: { kind: 'village-project', hook: 'Orrin’s workshop project (the hinges): he finally lets you read the Hall’s reply' } },
  'silas-pine-offcut-scrap': { style: 'scrap', source: { kind: 'commons', hook: 'Silas’s firebox, after you help him hang a door-fox on a new lintel' } },
  'pip-copybook-warden-corrections': {
    style: 'notebook',
    source: { kind: 'placed', area: 'village', tx: 25, ty: 14, look: 'folded', spot: 'Inside the garden fence, in the far corner from the gap' },
  },
  // ---- Bedtime Stories
  'the-boy-who-ran-faster-than-the-wick': { style: 'page', source: { kind: 'library-start' } },
  'why-the-tide-fox-has-one-long-ear': {
    style: 'page',
    source: { kind: 'placed', area: 'village', tx: 39, ty: 2, look: 'folded', spot: 'Blown into the north-east corner, behind the houses' },
  },
  'the-mudrise-fleet-lullaby': { style: 'song', source: { kind: 'library-start' } },
  'the-ashwatch-skipping-game': {
    style: 'notebook',
    source: { kind: 'placed', area: 'ruin', tx: 15, ty: 19, look: 'slate', spot: 'A child’s slate in the lee of the south wall — someone dared to play here' },
  },
  'elaras-note-in-pips-copybook': {
    style: 'notebook',
    source: { kind: 'placed', area: 'village', tx: 40, ty: 22, look: 'folded', spot: 'Caught in the reeds on the pond’s far side' },
  },
  // ---- The Liar's Art
  'failed-grid-of-sector-4': { style: 'notebook', source: { kind: 'wilds-poi', hook: 'A surveyor’s abandoned camp beside a tight-ringed stump' } },
  'joss-penhallow-field-notes-pencil-map': { style: 'notebook', source: { kind: 'wilds-poi', hook: 'A roofed shrine deep east whose turncap leans toward Sallow Ford (late)' } },
  'log-of-the-bark-wind-hewn': { style: 'ledger', source: { kind: 'library-start' } },
  'guild-of-cartographers-invoice': { style: 'record', source: { kind: 'library-start' } },
  // ---- Blood, Ink, and Timber
  'wandering-orchard-magistrate-ruling': { style: 'record', source: { kind: 'library-start' } },
  'orrins-drift-slap-foundation-standard': { style: 'broadside', source: { kind: 'commons', hook: 'Orrin posts it when you lay your first homestead foundation' } },
  'will-of-elias-fenn': {
    style: 'record',
    source: { kind: 'placed', area: 'ruin', tx: 9, ty: 5, look: 'scroll', spot: 'The old waystation clerk’s corner, inside the walled room' },
  },
  'deed-of-sale-commons-plot': { style: 'record', source: { kind: 'commons', hook: 'The Commons ledger: shown when you claim a plot beside Silas' } },
  'the-blind-routes-smugglers-ledger': { style: 'notebook', source: { kind: 'wilds-chest', hook: 'A hollowed-out log in the Wilds, near the old ferry ruins' } },
  // ---- Blood, Sap, and Memory
  'remedies-of-the-oaker-hills': { style: 'page', source: { kind: 'library-start' } },
  'sallow-ford-chirurgeons-field-book': {
    style: 'notebook',
    source: { kind: 'placed', area: 'ruin', tx: 32, ty: 14, look: 'scroll', spot: 'East passage, where the waystation kept its medicine shelf' },
  },
  'dangers-of-the-white-quiet-pamphlet': { style: 'broadside', source: { kind: 'library-start' } },
  'nan-greer-trail-journal': { style: 'notebook', source: { kind: 'turning', hook: 'Given back by the outer Wilds at a Turning, near the Tangle crossing (late)' } },
  // ---- Scholarly Texts
  'principia-memoria-excerpt': {
    style: 'page',
    source: { kind: 'quest', stage: 'lantern-lit', spot: 'Left on the shrine ledge beside the flint and steel; found as the lantern catches' },
    hint: 'Someone left reading beside the hilltop lantern.',
  },
  'fauna-of-the-slack-water': {
    style: 'page',
    source: { kind: 'placed', area: 'woodland', tx: 50, ty: 3, look: 'folded', spot: 'Dropped from a satchel in the far north-east of Brackenwood' },
  },
  'barge-knee-yields-report': {
    style: 'record',
    source: { kind: 'placed', area: 'woodland', tx: 4, ty: 24, look: 'scroll', spot: 'A south-west glade where an old night-camp stood' },
  },
  'weir-effect-survey-draft': { style: 'page', source: { kind: 'turning', hook: 'The first Turning after the road is relit' } },
  // ---- The Builders and the Breakers
  'brackenwood-cutters-handbook': { style: 'page', source: { kind: 'library-start' } },
  'orrins-workshop-rules': {
    style: 'scrap',
    source: { kind: 'gift', from: 'orrin', stage: 'complete' },
    hint: 'Orrin might let you near his bench once the road is lit.',
  },
  'twoford-almanac-silas-copy': { style: 'page', source: { kind: 'library-start' } },
  'marens-notes-on-hubs-and-tyres': { style: 'notebook', source: { kind: 'village-project', hook: 'Reopening the Wheel & Wick guildhouse' } },
};

const AREA_HINT: Record<AreaId, string> = {
  village: 'Somewhere in Hearthwick, off the beaten path.',
  woodland: 'Somewhere in Brackenwood, away from the road.',
  ruin: 'Somewhere in Ashwatch Ruin.',
};

const LATER_HINT: Record<LaterKind, string> = {
  commons: 'On the Commons, once it opens.',
  'wilds-poi': 'Out in the Wilds, past where the maps give out.',
  'wilds-chest': 'Hidden in the Wilds.',
  'village-project': 'Part of a village project still to come.',
  turning: 'When the outer Wilds turn and give things back.',
};

function hintFor(source: FindSource): string {
  switch (source.kind) {
    case 'library-start':
      return 'On the shelves of the Hearthwick Library.';
    case 'placed':
      return AREA_HINT[source.area];
    case 'quest':
      return 'Part of the Lantern Road story.';
    case 'gift':
      return 'Someone in Hearthwick may share it, in time.';
    default:
      return LATER_HINT[source.kind];
  }
}

export const PAPERS: readonly Paper[] = PAPER_TEXTS.map((t) => {
  const d = DESIGN[t.id];
  if (!d) throw new Error(`[papers] no find source for ${t.id}`);
  return { ...t, style: d.style, source: d.source, hint: d.hint ?? hintFor(d.source) };
});

export { PAPER_COLLECTIONS };

const BY_ID = new Map(PAPERS.map((p) => [p.id, p]));

export function paperById(id: string): Paper | undefined {
  return BY_ID.get(id);
}

export const PAPER_FLAG_PREFIX = 'paper:';

export function paperFlag(id: string): string {
  return PAPER_FLAG_PREFIX + id;
}

/** Ids of papers this save has found (unknown ids are ignored). */
export function foundPapers(flags: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of flags) {
    if (!f.startsWith(PAPER_FLAG_PREFIX)) continue;
    const id = f.slice(PAPER_FLAG_PREFIX.length);
    if (BY_ID.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function stageAtLeast(stage: QuestStage, needed: QuestStage): boolean {
  return QUEST_STAGES.indexOf(stage) >= QUEST_STAGES.indexOf(needed);
}

export type PlacedPaper = Paper & { source: Extract<FindSource, { kind: 'placed' }> };

/** Pickups lying in an area right now: placed there, unfound, and unlocked. */
export function placedPapersIn(area: string, stage: QuestStage, flags: readonly string[]): PlacedPaper[] {
  return PAPERS.filter(
    (p): p is PlacedPaper =>
      p.source.kind === 'placed' &&
      p.source.area === area &&
      !flags.includes(paperFlag(p.id)) &&
      (!p.source.after || stageAtLeast(stage, p.source.after)),
  );
}

/** Every placement, regardless of state (for layout tests). */
export function allPlacements(): PlacedPaper[] {
  return PAPERS.filter((p): p is PlacedPaper => p.source.kind === 'placed');
}

export const LOOK_LABEL: Record<PickupLook, string> = {
  folded: 'Pick up the folded paper',
  scroll: 'Pick up the tied scroll',
  slate: 'Pick up the slate',
};

// ------------------------------------------------------------ handed over

/**
 * What an NPC says when handing a paper over. Appended to their usual lines
 * (this module never edits src/content/world.ts dialogue), so it reads as
 * the end of the same conversation.
 */
const HANDOVER: Record<string, { lines: string[]; laterLines?: string[] }> = {
  'ashwatch-ledger-excerpts': {
    lines: [
      'Wait — take these. I copied out Grandmother’s pages from before the Closure, the night you left. She was writing about the warden before there was a warden.',
      'Read them before you climb. Then tell me I’m wrong about what they mean. I would like to be wrong.',
    ],
    laterLines: [
      'One more thing. I copied out Grandmother’s pages from before the Closure, the night you left. I meant to give them to you before the shrine.',
      'You should have them. You have walked further on her road than anyone since. Noted — by me, this time.',
    ],
  },
  'keepers-twists-recipe-card': {
    lines: [
      'Oh! Before I forget — Mum says you can have this. It’s the card off the bakery wall. She says she knows it by heart and it’s about time someone used it.',
      'There’s a note on the back about my uncle. I’m not supposed to have read it. I have read it eleven times.',
    ],
  },
  'orrins-workshop-rules': {
    lines: [
      'Since you are going to keep turning up at my bench, you had better learn the rules. I pried the old slabs off the lintel. New ones are going up. Same rules.',
      'Read rule seven twice. And the chalk underneath is none of your business.',
    ],
  },
  'elara-quill-field-notes-turncaps': {
    lines: [
      'The forager left these with me at midsummer. Turncaps, she says. Mushrooms that point at lamps.',
      'There is a strip of my own ledger paper tucked inside. I wrote it before you came. Read it, and then please don’t ask me about it yet.',
    ],
  },
};

/**
 * The paper an NPC hands over in this conversation, if one is due.
 * Quest beats with a `from` come before after-quest gifts.
 */
export function handoverFor(npc: string, stage: QuestStage, flags: readonly string[]): { paperId: string; lines: string[] } | null {
  for (const p of PAPERS) {
    const s = p.source;
    if ((s.kind !== 'quest' && s.kind !== 'gift') || s.from !== npc) continue;
    if (!stageAtLeast(stage, s.stage) || flags.includes(paperFlag(p.id))) continue;
    const h = HANDOVER[p.id];
    if (!h) continue;
    // Quest beats read differently once the beat has passed (warden beaten).
    const late = s.kind === 'quest' && h.laterLines && stageAtLeast(stage, 'guardian-defeated');
    return { paperId: p.id, lines: late ? h.laterLines! : h.lines };
  }
  return null;
}

/** Quest beats found without a conversation, due at this stage. */
export function beatsDue(stage: QuestStage, flags: readonly string[]): Paper[] {
  return PAPERS.filter((p) => p.source.kind === 'quest' && !p.source.from && stageAtLeast(stage, p.source.stage) && !flags.includes(paperFlag(p.id)));
}

/** Toast copy for a find. */
export function foundToast(p: Paper): string {
  return `Found: ${p.title} — it’s in your journal.`;
}
