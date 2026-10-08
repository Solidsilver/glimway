/**
 * The journal's Quests page as data (docs/design/indoors.md 5.4): shelves
 * by line, each quest a card with its next step, the steps reached, and the
 * rest kept back (no spoilers). Pure, so the page's rules are tested.
 */
import { YOUR_OWN_DAY_LOCKED } from '../content/quests/index.ts';
import type { Paper } from '../content/papers.ts';
import { nextStep, QUESTS, questLine, questStatus, questTitle, reachedIndex, waitOpensAt, waitTurnings, waitWords, type GateContext, type NeedsContext, type QuestLine, type QuestRecord } from '../lib/quests.ts';

export interface QuestCard {
  id: string;
  title: string;
  blurb: string;
  status: 'open' | 'locked' | 'done';
  /** The next step's goal and objective (open quests). */
  goal: string | null;
  objective: string | null;
  /** Steps reached, by the goal that led to each. */
  reached: string[];
  /** Steps still to come after the next one (shown as `· · ·`). */
  later: number;
  /** "ready in about 1 h 20 m" while a wait is closed; "ready now" once it opens. */
  wait: string | null;
  /** Why a locked quest can't be taken. */
  locked: string | null;
  pinned: boolean;
}

export interface QuestShelf {
  line: QuestLine;
  title: string;
  open: QuestCard[];
  /** Done quests, folded to one line each at the bottom. */
  done: QuestCard[];
}

const SHELF_TITLES: Record<QuestLine, string> = { road: 'The Road', village: 'The Village', craft: 'Crafts' };
const LINES: QuestLine[] = ['road', 'village', 'craft'];

export interface PageContext {
  needs: NeedsContext;
  gate: (quest: string) => GateContext;
  /** The pin slot (`quest:<id>`…). */
  pinned: string | null;
  /** A quest to put at the top of its shelf (the opening while its note waits). */
  focus?: string | null;
}

/** The shelves with something on them, road first; Crafts stays hidden while empty. */
export function questShelves(record: QuestRecord, ctx: PageContext): QuestShelf[] {
  const shelves: QuestShelf[] = [];
  for (const line of LINES) {
    const quests = QUESTS.filter((q) => questLine(q) === line).sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0));
    const open: QuestCard[] = [];
    const done: QuestCard[] = [];
    for (const q of quests) {
      const status = questStatus(q, record, ctx.needs);
      if (status === 'hidden') continue;
      const at = reachedIndex(q, record);
      const next = status === 'open' ? nextStep(q, record) : null;
      let wait: string | null = null;
      if (next?.gate?.wait) {
        const g = ctx.gate(q.id);
        if (g.gateAt !== undefined) {
          const opensAt = waitOpensAt(next.gate.wait, g.gateAt, g.calendar);
          wait = g.now < opensAt ? `ready ${waitTurnings(next.gate.wait) ? waitWords(opensAt, g.now, next.gate.wait) : `in ${waitWords(opensAt, g.now)}`}` : 'ready now';
        }
      }
      const card: QuestCard = {
        id: q.id,
        title: questTitle(q),
        blurb: q.blurb ?? '',
        status,
        goal: next?.goal ?? null,
        objective: next?.objective ?? next?.goal ?? null,
        reached: q.steps.slice(0, at + 1).map((s) => s.goal ?? s.id),
        later: Math.max(0, q.steps.length - at - 2),
        wait,
        locked: status === 'locked' ? (q.needs === 'habitica' ? YOUR_OWN_DAY_LOCKED : 'Not yet') : null,
        pinned: ctx.pinned === `quest:${q.id}`,
      };
      (status === 'done' ? done : open).push(card);
    }
    if (ctx.focus) open.sort((a, b) => (a.id === ctx.focus ? -1 : b.id === ctx.focus ? 1 : 0));
    if (open.length || done.length) shelves.push({ line, title: SHELF_TITLES[line], open, done });
  }
  return shelves;
}

/** A step's note, written when the step was reached (5.4's Notes). */
export interface QuestNote {
  /** `note:<quest>:<step>`. */
  id: string;
  quest: string;
  questTitle: string;
  step: string;
  title: string;
  body: string;
}

/**
 * The notes of every step reached, newest first: quests by when their last
 * step was reached (the state's `questReachedAt`; unknown ones last, in the
 * tree's order), and within a quest its later steps first.
 */
export function questNotes(record: QuestRecord, reachedAt: Readonly<Record<string, number>> = {}): QuestNote[] {
  const quests = QUESTS.map((q, i) => ({ q, i, at: reachedAt[q.id] ?? -Infinity })).sort((a, b) => b.at - a.at || a.i - b.i);
  const out: QuestNote[] = [];
  for (const { q } of quests) {
    for (let i = reachedIndex(q, record); i >= 0; i--) {
      const s = q.steps[i];
      if (s.note) out.push({ id: `note:${q.id}:${s.id}`, quest: q.id, questTitle: questTitle(q), step: s.id, title: s.note.title, body: s.note.body });
    }
  }
  return out;
}

/** A note as the papers' reader shows it (src/ui/PaperReader.svelte): a pencilled page of your journal. */
export function noteAsPaper(note: QuestNote): Paper {
  return {
    id: note.id,
    title: note.title,
    description: note.questTitle,
    collection: 'Your journal',
    meta: [{ label: 'Quest', value: note.questTitle }],
    body: note.body,
    style: 'notebook',
    source: { kind: 'library-start' },
    hint: '',
    section: 'field-notes',
  };
}
