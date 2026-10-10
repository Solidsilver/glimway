/**
 * Village life, pure logic (no Phaser, no network): how the calendar reads
 * in words, what a notice board says, how much of a project you can still
 * give, how many of a recipe you can make, what in your pack can move, and
 * how a mailbox sorts. The game layer (src/game/village.ts) and the panels
 * use these; tests run them directly.
 */
import { CALENDAR, calendarAt, type CalendarDay } from './calendar.ts';
import { HOMESTEAD_DATA, homeItem } from './homestead.ts';
import { CRAFTING, PROJECTS, type Recipe } from './workshop.ts';
import { giftPhrase, giveable, itemDef, itemName } from './items.ts';
import type { Asset, AssetCounts, AssetView, Mail, ProjectView } from './api/types.ts';

export type { CalendarDay };

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** "Sap-wick, 3rd day" */
export function dateLine(d: Pick<CalendarDay, 'wick' | 'day'>): string {
  return `${d.wick}-wick, ${ordinal(d.day)} day`;
}

/** "Sap-wick, 3rd day — Amberfall" (the brief's example), with the festival if any. */
export function calendarLine(d: Pick<CalendarDay, 'wick' | 'day' | 'mark' | 'festival'>): string {
  return `${dateLine(d)} — ${d.mark}${d.festival ? ` · ${d.festival}` : ''}`;
}

/** The Marks are named for road work; this is what each means in one line. */
export const MARK_NOTES: Record<string, string> = {
  Mudrise: 'The Thaw: paths sink and reappear.',
  Carting: 'The Green Hush: long light, and the drift slows.',
  Amberfall: 'The Shedding: maps go wrong fastest.',
  Quiet: 'The White Quiet: cold is stillness.',
};

/** What a festival looks like in Hearthwick (canon: chronicle Part III). */
export const FESTIVAL_NOTES: Record<string, string> = {
  'The Breaking': 'The ice goes out on the Wend. Candle hulls float on the pond tonight: walnut shells with leaf sails.',
  'Carting Day': 'Stalls on the Commons, twists at the bakery, and a polished hame on the gate for the cart that never came home.',
  Amberwake: 'Every house sets a hearth-grade lamp in its window, and the Long Table keeps an empty chair.',
  'Closure Night': 'Every lantern in the village is lit. The road beyond the last post is left dark, on purpose.',
};

/** The next festival on or after `day` (searching up to a year ahead). */
export function nextFestival(now: number, c = CALENDAR): { name: string; at: number; day: CalendarDay } | null {
  const start = Math.floor(now / 86400) * 86400;
  for (let i = 0; i <= c.wickDays * 12; i++) {
    const at = start + i * 86400;
    const d = calendarAt(at, c);
    if (d.festival) return { name: d.festival, at, day: d };
  }
  return null;
}

/**
 * Elara's notice about the Turning. In the last day of a wick it is the
 * canon notice ("Dark of Sap-wick — the outer Wilds will turn."); before
 * that, when to expect it, in the reader's own time.
 */
export function turningNotice(d: CalendarDay, now: number, locale?: string): { text: string; soon: boolean } {
  if (d.notice) return { text: d.notice, soon: true };
  const days = Math.max(1, Math.ceil((d.nextTurning - now) / 86400));
  const when = new Date(d.nextTurning * 1000).toLocaleString(locale, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  return { text: `The outer Wilds turn at the dark of ${d.wick}-wick: ${days === 1 ? 'tomorrow' : `in ${days} days`} (${when}). I’ll post the day before.`, soon: false };
}

// ------------------------------------------------------------ goods

export const MATERIAL_IDS = ['timber', 'stone', 'fiber', 'amber'] as const;

export function emptyCounts(): AssetCounts {
  return { materials: {}, items: {}, decorations: {} };
}

export function countOf(c: AssetCounts | null | undefined, kind: Asset['kind'], id: string): number {
  if (!c) return 0;
  if (kind === 'instance') return (c.instances ?? []).filter((i) => i.itemDef === id).length;
  const map = kind === 'material' ? c.materials : kind === 'item' ? c.items : c.decorations;
  return map[id] ?? 0;
}

/**
 * Decorations you can move (store, mail): the ones in your pack. Pieces set
 * out belong to the homestead and are never counted as carried.
 */
export function movableDecorations(c: AssetCounts | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(c?.decorations ?? {})) if (n > 0) out[id] = n;
  return out;
}

/**
 * Everything you could send, as a flat list (materials first): stacks, home
 * goods, and tools one by one. Heirlooms and story keepsakes stay with you.
 */
export function movableAssets(c: AssetCounts | null | undefined): Asset[] {
  const out: Asset[] = [];
  const sendable = (id: string) => {
    const d = itemDef(id);
    return !d || giveable(d);
  };
  const more = Object.keys(c?.materials ?? {}).filter((m) => !(MATERIAL_IDS as readonly string[]).includes(m)).sort();
  for (const id of [...MATERIAL_IDS, ...more]) if (countOf(c, 'material', id) > 0) out.push({ kind: 'material', id, qty: countOf(c, 'material', id) });
  for (const [id, n] of Object.entries(c?.items ?? {}).sort()) if (n > 0 && sendable(id)) out.push({ kind: 'item', id, qty: n });
  for (const [id, n] of Object.entries(movableDecorations(c)).sort()) out.push({ kind: 'decoration', id, qty: n });
  for (const i of c?.instances ?? []) if (sendable(i.itemDef)) out.push({ kind: 'instance', id: i.itemDef, qty: 1, instance: i.id });
  return out;
}

/** A stable key for one choice in a goods list (instances by their own id). */
export function assetKey(a: Pick<AssetView, 'kind' | 'id' | 'instance'>): string {
  return a.instance ? `${a.kind}:${a.id}:${a.instance}` : `${a.kind}:${a.id}`;
}

// ------------------------------------------------------------ projects

/** How much more of each material a project takes. */
function remaining(p: Pick<ProjectView, 'required' | 'contributed'>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [m, need] of Object.entries(p.required)) out[m] = Math.max(0, need - (p.contributed[m] ?? 0));
  return out;
}

/** The most you can give of each material now: what you carry, capped at what's left. */
export function contributionLimits(p: Pick<ProjectView, 'required' | 'contributed'>, carried: Record<string, number>): Record<string, number> {
  const left = remaining(p);
  const out: Record<string, number> = {};
  for (const m of Object.keys(p.required)) out[m] = Math.max(0, Math.min(left[m] ?? 0, carried[m] ?? 0));
  return out;
}

/** Share of a project done, 0..1 (all materials together). */
export function projectProgress(p: Pick<ProjectView, 'required' | 'contributed'>): number {
  let need = 0;
  let have = 0;
  for (const [m, n] of Object.entries(p.required)) {
    need += n;
    have += Math.min(n, p.contributed[m] ?? 0);
  }
  return need ? have / need : 0;
}

/** The projects as content defines them (guests and before the first read). */
export function blankProjects(): ProjectView[] {
  return PROJECTS.projects.map((p) => ({
    id: p.id,
    name: p.name,
    stage: 'open',
    required: { ...p.materials },
    contributed: Object.fromEntries(Object.keys(p.materials).map((m) => [m, 0])),
    mine: Object.fromEntries(Object.keys(p.materials).map((m) => [m, 0])),
    completedAt: null,
    worldFlag: null,
    grantablePapers: [],
  }));
}

/**
 * Papers that wait for the road to be lit, whatever a project says: the
 * reveal order keeps survival texts late (src/content/papers.ts).
 */
const LATE_PROJECT_PAPERS = ['count-house-tally-book-scrap', 'note-in-the-linseed-box', 'forty-one-and-holding'];

/** Which granted papers to hand over now, given what's held and the quest. */
export function papersDue(grantable: readonly string[], held: (id: string) => boolean, questComplete: boolean): string[] {
  return grantable.filter((id) => !held(id) && (questComplete || !LATE_PROJECT_PAPERS.includes(id)));
}

// ------------------------------------------------------------ crafting

/** How many batches of a recipe the carried materials pay for (0 = can't). A bill line may be paid in its swaps (dried flowers for fresh). */
export function batchesAffordable(r: Recipe, carried: Record<string, number>): number {
  let n = Infinity;
  for (const [m, cost] of Object.entries(r.materials)) {
    let have = carried[m] ?? 0;
    for (const s of r.swaps?.[m]?.standIns ?? []) have += carried[s] ?? 0;
    n = Math.min(n, Math.floor(have / cost));
  }
  return Number.isFinite(n) ? Math.min(100, n) : 0;
}

/**
 * The batch count to show and to send: the chosen one, clamped to what can
 * be paid for now (at least 1, so an unaffordable recipe still shows its cost).
 */
export function effectiveBatches(chosen: number | undefined, affordable: number): number {
  return Math.min(Math.max(1, chosen ?? 1), Math.max(1, affordable))
}

export function recipeCost(r: Recipe, batches = 1): Record<string, number> {
  return Object.fromEntries(Object.entries(r.materials).map(([m, n]) => [m, n * batches]));
}

export const RECIPES = CRAFTING.recipes;

// ------------------------------------------------------------ names

export function assetName(a: Pick<AssetView, 'kind' | 'id'>): string {
  if (a.kind === 'decoration') return homeItem(a.id)?.name ?? a.id;
  return itemName(a.id);
}

/** "12 timber", "a Whittled Fox", "2 Wooden Stools". */
export function assetPhrase(a: AssetView): string {
  const name = assetName(a);
  if (a.kind === 'thanks') return `a thank-you for ${giftPhrase(a.id, 1)} you made`;
  if (a.kind === 'material') return `${a.qty} ${name.toLowerCase()}`;
  if (a.qty === 1) return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
  return `${a.qty} ${name}${name.endsWith('s') ? '' : 's'}`;
}

export function costPhrase(cost: Record<string, number>): string {
  return Object.entries(cost).map(([m, n]) => `${n} ${itemName(m).toLowerCase()}`).join(', ');
}

// ------------------------------------------------------------ mail

export interface MailBuckets {
  /** Addressed to you, waiting to be claimed. */
  waiting: Mail[];
  /** Sent by you, not yet claimed (can be recalled). */
  outgoing: Mail[];
  /** Everything settled: claimed or recalled, both ways. */
  history: Mail[];
}

export function mailBuckets(mail: readonly Mail[], me: string): MailBuckets {
  const settled = (m: Mail) => m.claimedAt !== null || (m.returnedAt ?? null) !== null;
  return {
    waiting: mail.filter((m) => m.toId === me && !settled(m)),
    outgoing: mail.filter((m) => m.fromId === me && !settled(m)),
    history: mail.filter(settled),
  };
}

export const WORKSHOP_TIER = HOMESTEAD_DATA.tiers[2];

/** How a settled parcel ended, in words. */
export function settledLine(m: Mail): string {
  if (m.claimedAt !== null) return m.asset.kind === 'thanks' ? 'read' : 'collected'
  switch (m.returnReason) {
    case 'expired':
      return 'returned after 30 days'
    case 'recipient-removed':
      return 'returned: they left the world'
    default:
      return 'recalled'
  }
}

/** Why the workshop can't be built yet (null: it can). */
export function workshopShort(embers: number, materials: Record<string, number>): string | null {
  if (embers < WORKSHOP_TIER.embers) return `Needs ${WORKSHOP_TIER.embers} embers`;
  for (const [m, n] of Object.entries(WORKSHOP_TIER.materials ?? {})) if ((materials[m] ?? 0) < n) return `Needs ${n} ${m}`;
  return null;
}
