/**
 * The quest tree's words, game-facing (docs/design/indoors.md 5.8): the
 * HUD's road goal, the talks that take a step (`talk` and `use` triggers),
 * spot labels and markers, and rumours. The predictor (src/lib/quests.ts)
 * says which step is next and whether its gate holds; this file says it in
 * the speaker's voice: the step's talk when it would go, "not yet" with the
 * predicted wait, the offer shown disabled with why (short, needs a
 * connection).
 *
 * A dialogue's `event` here is a `quest:step` ref, taken when the talk
 * closes. A gated step is taken by its offer instead (choice action
 * `quest:<quest>:<step>`), so it can't be taken by walking away.
 */
import { itemDef } from '../../lib/items.ts';
import {
  checkGate,
  isDone,
  nextStep,
  parseRef,
  questById,
  QUESTS,
  questLine,
  questStatus,
  questTitle,
  reachedIndex,
  roadQuest,
  stepRef,
  stepsBy,
  trigger,
  waitOpensAt,
  waitWords,
  type GateContext,
  type NeedsContext,
  type QuestDef,
  type QuestRecord,
  type QuestStepDef,
} from '../../lib/quests.ts';
import type { Dialogue, DialogueChoice } from '../world.ts';
import { SEAT_BY_THE_LAMP_TALKS, READING_LAMP_LIT } from './seat-by-the-lamp.ts';
import { SET_TO_RISE_TALKS, SPONGE_BOWL } from './set-to-rise.ts';
import { SIGNPOST_TALKS } from './signpost.ts';
import { STUCK_HOIST_TALKS } from './stuck-hoist.ts';
import type { QuestTalks, StepTalk } from './types.ts';
import { YOUR_OWN_DAY_TALKS } from './your-own-day.ts';

export { SIGNPOST_BETWEEN } from './signpost.ts';
export { YOUR_OWN_DAY_LOCKED } from './your-own-day.ts';

/**
 * Each quest's step talks. The lantern road isn't here: its talks are the
 * dialogue rules in ../world.ts, and the scene fires its five events.
 */
const TALKS: Readonly<Record<string, QuestTalks>> = {
  signpost: SIGNPOST_TALKS,
  'set-to-rise': SET_TO_RISE_TALKS,
  'stuck-hoist': STUCK_HOIST_TALKS,
  'seat-by-the-lamp': SEAT_BY_THE_LAMP_TALKS,
  'your-own-day': YOUR_OWN_DAY_TALKS,
};

/** A choice's action that takes a step: `quest:<quest>:<step>`. */
export const QUEST_ACTION = 'quest:';

/** What the quest talks can see of the player now (built by src/game/guide-pin.ts `questContext`). */
export interface QuestTalkContext {
  quests: QuestRecord;
  needs: NeedsContext;
  gate: (quest: string) => GateContext;
  /** The pin slot: `quest:<id>`, `guide:<id>` or null. */
  pinned: string | null;
  /** A Habitica hero (Mara's line about your own day). */
  connected: boolean;
}

// ------------------------------------------------------------------ the HUD

const ROAD_DONE = {
  short: 'The road is lit. Wander as you like',
  objective: 'The lantern road glows again. Explore Hearthwick, Brackenwood, and the ruin at your own pace.',
};

/** The road's current goal (the HUD with nothing pinned; the title screen's Continue card). */
export function roadGoal(record: QuestRecord): { short: string; objective: string; quest: string | null } {
  const q = roadQuest(record);
  const s = q ? nextStep(q, record) : null;
  if (!q || !s) return { ...ROAD_DONE, quest: null };
  return { short: s.goal ?? questTitle(q), objective: s.objective ?? s.goal ?? q.blurb ?? '', quest: q.id };
}

/** A quest's next step in words (a pinned quest's goal line; the Quests page card). */
export function questGoal(quest: QuestDef, record: QuestRecord): { short: string; objective: string } | null {
  const s = nextStep(quest, record);
  return s ? { short: s.goal ?? questTitle(quest), objective: s.objective ?? s.goal ?? '' } : null;
}

// ------------------------------------------------------------------ talks

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function talkFor(quest: QuestDef, step: QuestStepDef): StepTalk | undefined {
  return TALKS[quest.id]?.[step.id];
}

/** The open/unmet wait of a gated step, for words like "about 1 h 20 m" (null: no wait, or it's open). */
export function waitLeft(step: QuestStepDef, gate: GateContext): string | null {
  const w = step.gate?.wait;
  if (!w || gate.gateAt === undefined) return null;
  const opensAt = waitOpensAt(w, gate.gateAt, gate.calendar);
  return gate.now < opensAt ? waitWords(opensAt, gate.now, w) : null;
}

/** One step's talk, as its gate stands now. Null: it isn't for here (someone you're not with). */
function stepDialogue(quest: QuestDef, step: QuestStepDef, talk: StepTalk, ctx: QuestTalkContext): Dialogue | null {
  const ref = stepRef(quest.id, step.id);
  let lines = typeof talk.lines === 'function' ? talk.lines({ connected: ctx.connected }) : [...talk.lines];
  const g = checkGate(step, ctx.gate(quest.id));
  const key = `quest:${ref}`;
  if (!g.ok && g.why === 'not-here') return null;
  if (!g.ok && g.why === 'not-yet') {
    const words = waitWords(g.opensAt, ctx.gate(quest.id).now, step.gate?.wait);
    return { speaker: talk.speaker, lines: talk.notYet ? talk.notYet(words) : lines, key };
  }
  const offer = talk.offer;
  if (!g.ok) {
    if (g.why === 'short' && talk.short) lines = [...talk.short];
    const note =
      g.why === 'short'
        ? `Needs ${plural(g.need, itemDef(g.def)?.name.toLowerCase() ?? g.def)}`
        : g.why === 'short-embers'
          ? `Needs ${plural(g.need, 'ember')}`
          : 'Needs a connection';
    const choices: DialogueChoice[] = offer ? [{ text: offer.text, note, disabled: true }, { text: 'Not yet', dismiss: true }] : [];
    return { speaker: talk.speaker, lines, key, ...(choices.length ? { choices } : {}) };
  }
  if (offer) {
    return {
      speaker: talk.speaker,
      lines,
      key,
      choices: [{ text: offer.text, ...(offer.note ? { note: offer.note } : {}), ...(offer.reply ? { reply: [...offer.reply] } : {}), action: `${QUEST_ACTION}${ref}` }, { text: 'Not yet', dismiss: true }],
    };
  }
  return { speaker: talk.speaker, lines, key, event: ref, ...(talk.choices ? { choices: talk.choices.map((c) => ({ ...c, reply: c.reply ? [...c.reply] : undefined })) } : {}) };
}

/** The first next step of this kind with words for `id`, as a dialogue (null: none wants it). */
function triggerTalk(kind: 'talk' | 'use', id: string, ctx: QuestTalkContext): Dialogue | null {
  for (const { quest, step } of stepsBy(kind, id, ctx.quests, ctx.needs)) {
    const talk = talkFor(quest, step);
    if (!talk) continue;
    const d = stepDialogue(quest, step, talk, ctx);
    if (d) return d;
  }
  return null;
}

/**
 * Talking to a person: the talk of a quest step that finishes by talking to
 * them (the opening's Orrin and Mara, Hazel's sponge, Finn's hoist, Mara's
 * own-day). Null: their usual talk.
 */
export function questTalk(npc: string, ctx: QuestTalkContext): Dialogue | null {
  return triggerTalk('talk', npc, ctx);
}

/**
 * Who speaks first (docs/design/indoors.md 5.9): whether a quest's talk
 * takes the whole of a person's talk. The main story's does (the opening,
 * the lantern road), and so does a step the player is mid-way through
 * there: its quest started and the step ready to take now (its gate holds).
 * Anything else, a quest's start, a "not yet", a "still no flour?", follows
 * the person's own lines (`afterTheirTalk`).
 */
export function takesTheTalk(step: Dialogue, ctx: QuestTalkContext): boolean {
  const p = step.key?.startsWith('quest:') ? parseRef(step.key.slice('quest:'.length)) : null;
  if (!p) return false;
  if (questLine(p.quest) === 'road') return true;
  if (ctx.quests[p.quest.id] === undefined) return false;
  return checkGate(p.step, ctx.gate(p.quest.id)).ok;
}

/**
 * A person's own talk with a quest's talk after it: their words first
 * (quests never stop people being themselves), then the quest's lines and
 * its offer. Their choices stay, after the offer, with one "Not yet" at the
 * end.
 */
export function afterTheirTalk(own: Dialogue, step: Dialogue): Dialogue {
  const offers = (step.choices ?? []).filter((c) => !c.dismiss && c.text !== 'Not yet');
  const theirs = (own.choices ?? []).filter((c) => !c.dismiss && c.text !== 'Not yet');
  const choices = [...offers, ...theirs];
  return {
    ...own,
    lines: [...own.lines, ...step.lines],
    ...(step.event ? { event: step.event } : {}),
    ...(choices.length ? { choices: [...choices, { text: 'Not yet', dismiss: true }] } : {}),
  };
}

/** A room spot's quest talk, or its quest-aware look (the sponge bowl, the lit lamp). Null: the spot's default. */
export function questSpotTalk(spot: string, ctx: QuestTalkContext): Dialogue | null {
  const step = triggerTalk('use', spot, ctx);
  if (step) return step;
  if (spot === 'sponge-bowl') {
    const q = questById('set-to-rise')!;
    const at = reachedIndex(q, ctx.quests);
    const lines = isDone(q, ctx.quests)
      ? SPONGE_BOWL.done
      : at < q.steps.findIndex((s) => s.id === 'set-sponge')
        ? SPONGE_BOWL.empty
        : (() => {
          const left = waitLeft(q.steps[at + 1], ctx.gate(q.id));
          return left ? SPONGE_BOWL.rising(left) : SPONGE_BOWL.risen;
        })();
    return { speaker: SPONGE_BOWL.speaker, lines: [...lines] };
  }
  if (spot === 'reading-lamp' && reachedIndex(questById('seat-by-the-lamp')!, ctx.quests) >= 2) return { speaker: 'Reading Lamp', lines: [...READING_LAMP_LIT] };
  return null;
}

/** What pressing at a spot does, while a quest step wants it (null: the spot's own label). */
export function questSpotLabel(spot: string, ctx: QuestTalkContext): string | null {
  for (const { quest, step } of stepsBy('use', spot, ctx.quests, ctx.needs)) {
    if (!talkFor(quest, step)) continue;
    const cost = step.gate?.embers ? ` · ${plural(step.gate.embers, 'ember')}` : '';
    return `${step.goal ?? talkFor(quest, step)!.speaker}${cost}`;
  }
  return spot === 'sponge-bowl' ? 'Look in the bowl' : null;
}

/** "!" over a person or spot when talking (or using it) would take a quest step now. */
export function questMarker(id: string, ctx: QuestTalkContext): 'quest' | null {
  for (const kind of ['talk', 'use'] as const) {
    for (const { quest, step } of stepsBy(kind, id, ctx.quests, ctx.needs)) {
      if (talkFor(quest, step) && checkGate(step, ctx.gate(quest.id)).ok) return 'quest';
    }
  }
  return null;
}

// ------------------------------------------------------------------ rumours

/** How each resident passes on what the village says you're up to (`{goal}`: the step's goal, lower-cased). */
const RUMOUR_VOICE: Readonly<Record<string, string>> = {
  hazel: 'Pip says you’re off to {goal}. Take a twist for the road.',
  finn: 'Heard you’ve to {goal}. I counted how long it’d take. Don’t worry about the number.',
  elara: 'The village says you mean to {goal}. Noted, as Mara would say.',
  ada: 'Somebody at the well said you’re meant to {goal}. I said you would. Don’t make me a liar.',
};

export const RUMOUR_ASK = 'Heard anything?';

/**
 * "Heard anything?" (quests.md 5, rumours): a resident names the next step
 * of an open quest you haven't pinned, in their own voice. Never their own
 * errand, and never the road's (the HUD already says it).
 */
export function rumourChoice(resident: string, ctx: QuestTalkContext): DialogueChoice | null {
  const voice = RUMOUR_VOICE[resident];
  if (!voice) return null;
  for (const q of QUESTS) {
    if (questLine(q) === 'road' || trigger(q.start, 'talk') === resident || ctx.pinned === `quest:${q.id}` || questStatus(q, ctx.quests, ctx.needs) !== 'open' || ctx.quests[q.id] === undefined) continue;
    const s = nextStep(q, ctx.quests);
    if (!s?.goal || s.where?.npc === resident || trigger(s.do, 'talk') === resident) continue;
    const goal = s.goal.charAt(0).toLowerCase() + s.goal.slice(1);
    return { text: RUMOUR_ASK, reply: [voice.replace('{goal}', goal)], replay: true };
  }
  return null;
}
