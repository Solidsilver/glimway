/**
 * The quest tree's predictor (docs/design/indoors.md 5): pure, like
 * ./guides.ts. A save keeps one record per quest, the last step it
 * **reached** (0.3's model: no row means not started, the last step means
 * done). A step entry is what you do to get there: its `goal`, `objective`,
 * `where` and `do` show while the step before it is your record, and its
 * `gate` and grants are checked and paid on arrival.
 *
 * Everything here is a copy of a server rule kept to draw the game before
 * the answer comes (src/lib/api/predict.ts): the server checks the gates
 * again in `quest-step`, and its state fixes any wrong guess.
 */
import { calendarAt, cycleSpotsNear, type Calendar } from './clock.ts';
import { CALENDAR } from './clock.ts';
import type { GameState, QuestEvent, QuestStage } from './state.ts';
import { QUESTS as TREE, type Quest } from './story-tables.ts';
import type { QuestGate, QuestStep, QuestTrigger, QuestWhere } from './api/ports.ts';
import { RESIDENTS, residentById } from './residents.ts';

export type { QuestGate, QuestTrigger, QuestWhere };

export type QuestLine = 'road' | 'village' | 'craft';
/** A quest as `content/quests.json` holds it (A's loader, ./story-tables.ts). */
export type QuestDef = Quest;
export type QuestStepDef = QuestStep;

/** A trigger's target for one kind (`talk` → `hazel`), or undefined when it's another kind. */
export function trigger(t: QuestTrigger | { new: true } | undefined, kind: 'talk' | 'use' | 'reach' | 'defeat' | 'carry' | 'flag' | 'open' | 'sync'): string | undefined {
  const v = t ? (t as Record<string, unknown>)[kind] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/** The shelf a quest sits on (village when the file doesn't say). */
export function questLine(q: QuestDef): QuestLine {
  return q.line ?? 'village';
}

export function questTitle(q: QuestDef): string {
  return q.title ?? q.id;
}

/** Quest id → the step reached. */
export type QuestRecord = Readonly<Record<string, string>>;

export const LANTERN_ROAD = 'lantern-road';
export const SIGNPOST = 'signpost';

export const QUESTS: readonly QuestDef[] = TREE;

const BY_ID = new Map(QUESTS.map((q) => [q.id, q]));

export function questById(id: string): QuestDef | undefined {
  return BY_ID.get(id);
}

/** `quest:step`, the one way quests and steps are named in dialogue rules and events. */
export function stepRef(quest: string, step: string): string {
  return `${quest}:${step}`;
}

/** A `quest:step` ref, or null when `ref` isn't one of the tree's. */
export function parseRef(ref: string): { quest: QuestDef; step: QuestStepDef; index: number } | null {
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  const quest = BY_ID.get(ref.slice(0, i));
  const index = quest ? quest.steps.findIndex((s) => s.id === ref.slice(i + 1)) : -1;
  return quest && index >= 0 ? { quest, step: quest.steps[index], index } : null;
}

/** How far a quest has got: the index of the step reached (-1: not started). */
export function reachedIndex(quest: QuestDef, record: QuestRecord): number {
  const at = record[quest.id];
  return at === undefined ? -1 : quest.steps.findIndex((s) => s.id === at);
}

export function isDone(quest: QuestDef, record: QuestRecord): boolean {
  return reachedIndex(quest, record) === quest.steps.length - 1;
}

/** The step you're heading for (null: done). */
export function nextStep(quest: QuestDef, record: QuestRecord): QuestStepDef | null {
  return quest.steps[reachedIndex(quest, record) + 1] ?? null;
}

/** `"quest"` holds when it's done; `"quest:step"` when that step (or a later one) is reached. */
export function refHolds(ref: string, record: QuestRecord): boolean {
  const i = ref.indexOf(':');
  if (i < 0) {
    const q = BY_ID.get(ref);
    return !!q && isDone(q, record);
  }
  const p = parseRef(ref);
  return !!p && reachedIndex(p.quest, record) >= p.index;
}

export function afterHolds(quest: QuestDef, record: QuestRecord): boolean {
  return (quest.after ?? []).every((r) => refHolds(r, record));
}

/** What the save can see of the player for `needs` (connected heroes only, for `habitica`). */
export interface NeedsContext {
  habitica: boolean;
}

export function needsHold(quest: QuestDef, ctx: NeedsContext): boolean {
  return quest.needs !== 'habitica' || ctx.habitica;
}

/**
 * Where a quest stands for this save (the Quests page, 5.4):
 * - `hidden`: not come across (no row, and not `start: new`), or `after` doesn't hold;
 * - `locked`: its `after` holds but its `needs` doesn't (shown, never hidden);
 * - `open`: in the record (or listed from the start) and not done;
 * - `done`.
 */
export type QuestStatus = 'hidden' | 'locked' | 'open' | 'done';

export function questStatus(quest: QuestDef, record: QuestRecord, ctx: NeedsContext): QuestStatus {
  if (record[quest.id] !== undefined) return isDone(quest, record) ? 'done' : needsHold(quest, ctx) ? 'open' : 'locked';
  if (!afterHolds(quest, record)) return 'hidden';
  if (!needsHold(quest, ctx)) return 'locked';
  return quest.start && 'new' in quest.start ? 'open' : 'hidden';
}

/** Can this save take the quest's next step at all (started, or startable now)? */
export function inPlay(quest: QuestDef, record: QuestRecord, ctx: NeedsContext): boolean {
  if (!needsHold(quest, ctx) || isDone(quest, record)) return false;
  return record[quest.id] !== undefined || afterHolds(quest, record);
}

/**
 * The road's current quest (the HUD follows it with nothing pinned): the
 * first road quest by chapter that isn't done and whose `after` holds.
 */
export function roadQuest(record: QuestRecord): QuestDef | null {
  const road = QUESTS.filter((q) => questLine(q) === 'road').sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0));
  return road.find((q) => !isDone(q, record) && afterHolds(q, record)) ?? null;
}

/**
 * Whether the signpost's east finger still lies in the bracken past the
 * east gate (the scene draws it): from the start of the opening until the
 * finger-wisp is shooed off it and the finger is picked up (`fetch-finger`).
 */
export function fingerInBracken(record: QuestRecord): boolean {
  const q = BY_ID.get(SIGNPOST);
  return !!q && reachedIndex(q, record) < q.steps.findIndex((s) => s.id === 'fetch-finger');
}

/** The step each of the lantern road's scene events reaches (step ids are the old stage names). */
export const ROAD_EVENT_STEP: Record<QuestEvent, string> = {
  accept: 'accepted',
  'find-clue': 'clue-found',
  'defeat-guardian': 'guardian-defeated',
  'light-lantern': 'lantern-lit',
  'return-village': 'complete',
};

/** The lantern road's step, as the game's older reads want it (`'new'` before Mara). */
export function roadStep(state: Pick<GameState, 'quests'>): QuestStage {
  return (state.quests[LANTERN_ROAD] ?? 'new') as QuestStage;
}

// ------------------------------------------------------------------ gates

/** What a gate check can see (5.3). `now` is the server's clock as the client knows it. */
export interface GateContext {
  now: number;
  /** The `where.area` the step would be sent with. */
  area: string;
  embers: number;
  /** How many of a server item (or a keepsake) you carry. */
  carrying: (def: string) => number;
  /** When this quest last reached a gated step, or its first (Unix seconds; undefined: not known). */
  gateAt: number | undefined;
  /** Connected and online (gated steps need the server). */
  online: boolean;
  calendar?: Calendar;
}

export type GateResult =
  | { ok: true }
  | { ok: false; why: 'not-here' }
  | { ok: false; why: 'not-yet'; opensAt: number }
  | { ok: false; why: 'short'; def: string; need: number }
  | { ok: false; why: 'short-embers'; need: number }
  | { ok: false; why: 'needs-connection' };

/** The areas a person can be met in near `now`: a resident's spots near now (with the grace), else the step's own `at`. */
export function personAreas(id: string, now: number, at: string): string[] {
  const r = residentById(id);
  if (r) return [...new Set(cycleSpotsNear(r, now, RESIDENTS.graceSeconds).map((spot) => r.spots[spot]!.area))];
  return at ? [at] : ['village'];
}

export type QuestWait = NonNullable<QuestGate['wait']>;

/** How many turnings a wait is (0: it's in hours). */
export function waitTurnings(wait: QuestWait | undefined): number {
  return wait && 'turnings' in wait ? wait.turnings : 0;
}

/** When a `wait` opens, counting from `since`. Turnings are wicks (`content/calendar.json`). */
export function waitOpensAt(wait: QuestWait, since: number, calendar: Calendar = CALENDAR): number {
  let t = since + ('hours' in wait ? wait.hours : 0) * 3600;
  for (let n = 0; n < waitTurnings(wait); n++) t = calendarAt(t, calendar).nextTurning;
  return t;
}

/** The gate on `step`, checked in the server's order (with, wait, item, embers); then the connection. */
export function checkGate(step: QuestStepDef, ctx: GateContext): GateResult {
  const g = step.gate;
  if (!g) return { ok: true };
  if (g.with && !personAreas(g.with, ctx.now, step.at).includes(ctx.area)) return { ok: false, why: 'not-here' };
  if (g.wait && ctx.gateAt !== undefined) {
    const opensAt = waitOpensAt(g.wait, ctx.gateAt, ctx.calendar);
    if (ctx.now < opensAt) return { ok: false, why: 'not-yet', opensAt };
  }
  if (g.item && ctx.carrying(g.item.def) < g.item.qty) return { ok: false, why: 'short', def: g.item.def, need: g.item.qty };
  if (g.embers && ctx.embers < g.embers) return { ok: false, why: 'short-embers', need: g.embers };
  if (!ctx.online) return { ok: false, why: 'needs-connection' };
  return { ok: true };
}

/** A wait in plain words: "about 1 h 20 m", "a few minutes", "after the turning". */
export function waitWords(opensAt: number, now: number, wait?: QuestWait): string {
  const turnings = waitTurnings(wait);
  if (turnings) return turnings === 1 ? 'after the turning' : `after ${turnings} turnings`;
  const left = Math.max(0, opensAt - now);
  if (left < 5 * 60) return 'a few minutes';
  const mins = Math.round(left / 60 / 5) * 5;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `about ${h ? `${h} h` : ''}${h && m ? ' ' : ''}${m ? `${m} m` : ''}`;
}

// ------------------------------------------------------------- triggers

/** What the automatic triggers (`reach`, `carry`, `flag`, `defeat`) can see now. */
export interface TriggerContext {
  area: string;
  flags: readonly string[];
  defeated: readonly string[];
  carrying: (def: string) => number;
}

function autoMet(t: QuestTrigger, ctx: TriggerContext): boolean {
  const reach = trigger(t, 'reach');
  const carry = trigger(t, 'carry');
  const flag = trigger(t, 'flag');
  const defeat = trigger(t, 'defeat');
  if (reach) return ctx.area === reach;
  if (carry) return ctx.carrying(carry) > 0;
  if (flag) return ctx.flags.includes(flag);
  if (defeat) return ctx.defeated.includes(defeat);
  return false;
}

/** Steps whose automatic trigger is met now, at most one per quest (`reach`, `carry`, `flag`, `defeat`). */
export function autoSteps(record: QuestRecord, needs: NeedsContext, ctx: TriggerContext): { quest: string; step: string }[] {
  const out: { quest: string; step: string }[] = [];
  for (const q of QUESTS) {
    if (!inPlay(q, record, needs)) continue;
    const s = nextStep(q, record);
    // A started quest only, or the first step of one that starts by itself (the library's `reach`).
    // A step `at` an area is only taken there (the world refuses it elsewhere: wrong-area).
    if (s && autoMet(s.do, ctx) && !s.gate && (!s.at || s.at === ctx.area) && (record[q.id] !== undefined || !q.start || 'new' in q.start)) out.push({ quest: q.id, step: s.id });
  }
  return out;
}

/** The next step that a manual trigger of this kind finishes (talk to `id`, use spot `id`, open `id`). */
export function stepsBy(kind: 'talk' | 'use' | 'open' | 'sync', id: string, record: QuestRecord, needs: NeedsContext): { quest: QuestDef; step: QuestStepDef }[] {
  const out: { quest: QuestDef; step: QuestStepDef }[] = [];
  for (const q of QUESTS) {
    if (!inPlay(q, record, needs)) continue;
    const s = nextStep(q, record);
    if (s && trigger(s.do, kind) === id) out.push({ quest: q, step: s });
  }
  // The road first, then by the tree's order.
  const road = (q: QuestDef) => (questLine(q) === 'road' ? 0 : 1);
  return out.sort((a, b) => road(a.quest) - road(b.quest));
}

// ------------------------------------------------------------- prediction

const FOUND = 'found:';
const DEFEATED = 'defeated:';
const unique = (list: readonly string[], item: string): string[] => (list.includes(item) ? [...list] : [...list, item]);

/**
 * Reach `to` on `quest` (the predicted `quest-step`): the record, the
 * step's keepsakes and marks, and an `embers` gate's spend. Grants of
 * embers and server items arrive with the answer. Null when `to` isn't the
 * next step.
 */
export function reachStep(state: GameState, quest: string, to: string, now: number): GameState | null {
  const q = BY_ID.get(quest);
  if (!q) return null;
  const i = reachedIndex(q, state.quests) + 1;
  const s = q.steps[i];
  if (!s || s.id !== to) return null;
  let next: GameState = { ...state, quests: { ...state.quests, [quest]: to } };
  if (s.gate || i === 0) next.questGateAt = { ...state.questGateAt, [quest]: now };
  for (const item of s.items) next = { ...next, inventory: unique(next.inventory, item) };
  for (const mark of s.marks) {
    if (mark.startsWith(FOUND)) next = { ...next, discoveries: unique(next.discoveries, mark.slice(FOUND.length)) };
    else if (mark.startsWith(DEFEATED)) next = { ...next, defeatedEnemies: unique(next.defeatedEnemies, mark.slice(DEFEATED.length)) };
    else next = { ...next, flags: unique(next.flags, mark) };
  }
  if (s.gate?.embers) next = { ...next, embers: Math.max(0, next.embers - s.gate.embers), xpEmbers: Math.min(next.xpEmbers, Math.max(0, next.embers - s.gate.embers)) };
  return next;
}

/** Whether a step must go to the server online (a gate, or server items given): never queued offline. */
export function needsServer(step: QuestStepDef): boolean {
  return !!step.gate || !!step.give?.length;
}
