/**
 * Gathering rules, caps, targets and yields (content/gathering.json; docs/items/).
 * Shared with the Go server (content/gathering.go).
 */
import raw from '../../content/gathering.json' with { type: 'json' };
import { giftPhrase, itemDef, itemName } from './items.ts';

export interface GatheringActionCaps {
  chop: number;
  break: number;
  dig: number;
}

export interface GatheringCaps {
  visit: GatheringActionCaps;
  day: GatheringActionCaps;
}

export interface GatheringYield {
  item: string;
  min: number;
  max: number;
  chancePermille?: number;
}

export interface GatheringTarget {
  action: 'chop' | 'break' | 'dig';
  toolAction: 'chop' | 'break' | 'dig';
  name: string;
  yields: GatheringYield[];
}

export interface GatheringData {
  caps: GatheringCaps;
  softCapLine: string;
  swings: Record<string, number>;
  targets: Record<string, GatheringTarget>;
  seeds: string[];
}

export const GATHERING_DATA = raw as GatheringData;

export function gatheringTarget(id: string): GatheringTarget | undefined {
  return GATHERING_DATA.targets[id];
}

export function isPlantableSeed(itemDef: string): boolean {
  return GATHERING_DATA.seeds.includes(itemDef);
}

/** Swings/strikes required for a gathering action (Bite fitting reduces by 1). */
export function gatheringSwings(action: string, bite = false): number {
  const base = GATHERING_DATA.swings[action] ?? 3;
  return bite ? Math.max(1, base - 1) : base;
}

/** One swing's length (ms) with an ordinary tool. */
export const SWING_MS = 300;

/** What a tool brings to the work (docs/items/crafting-and-repair.md, "Fittings", "Warden-stone"). */
export interface ToolFeel {
  /** A Bite fitting: fewer swings, and a dull warden-set tool still cuts well. */
  bite: boolean;
  /** A Heft fitting: faster swings. */
  heft: boolean;
  /** A warden-set tool at its dullest: half speed (three-quarters with Bite). */
  dull: boolean;
}

/** How a piece is worked with a tool: how many swings, and how long each takes. */
export function swingPlan(action: string, tool: ToolFeel): { swings: number; ms: number } {
  let ms = SWING_MS;
  if (tool.heft) ms *= 0.75;
  if (tool.dull) ms *= tool.bite ? 4 / 3 : 2;
  return { swings: gatheringSwings(action, tool.bite), ms: Math.round(ms) };
}

/** Where the woods can be worked: the Tangle and the Whitequiet, the woods, and home land. */
export function gatherArea(area: string): boolean {
  return area === 'wilds' || area === 'woodland' || area.startsWith('home:');
}

/**
 * The drift (docs/items/overview.md, "The drift and your things"): whether
 * a worked piece stays worked. Only your own land inside lamplight
 * remembers; the Tangle, the Whitequiet, the woods and your unlit edge
 * come back when you leave and return.
 */
export function keepsWork(area: string, lit: boolean): boolean {
  return area.startsWith('home:') && lit;
}

/** The button word for a gathering action (the touch action button). */
export function gatheringVerb(action: string): string {
  return action === 'chop' ? 'Chop' : action === 'break' ? 'Break' : action === 'dig' ? 'Dig' : 'Work';
}

/** The tool an action wants, said in words (for when you haven't one). */
export function gatheringToolWord(action: string): string {
  return action === 'chop' ? 'axe' : action === 'break' ? 'pick' : 'spade';
}

/**
 * A visit is one stay in an area: the caps count per area visit (per the
 * Tangle trip, not per chunk) and reset when you leave and come back. The
 * key is what makes a stay the same stay: scene rebuilds keep it, leaving
 * to another area ends it. The outer Wilds are their own area (the
 * Whitequiet), so the region rides along for wilds saves.
 */
export function visitKey(area: string, wildsRegion: string | null): string {
  return area === 'wilds' ? `wilds:${wildsRegion ?? 'tangle'}` : area;
}

let visit: { key: string; id: string } = { key: '', id: '' };

/** The visit id for the stay we're in now (stable until the area changes). */
export function visitIdFor(area: string, wildsRegion: string | null): string {
  const key = visitKey(area, wildsRegion);
  if (visit.key !== key) {
    const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : null;
    visit = { key, id: uuid ?? `visit-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}` };
  }
  return visit.id;
}

/**
 * What this visit's work changed (by `areaId:tx,ty`), and the kinds of work
 * the wood has given enough of. A scene rebuilt within the same stay (a
 * reload of the chunk, a snap-back) keeps them; the next visit starts
 * fresh — the drift.
 */
export interface VisitWork {
  worked: Map<string, 'stump' | 'open'>;
  enough: Set<string>;
}

let work: { id: string; done: VisitWork } = { id: '', done: { worked: new Map(), enough: new Set() } };

/** This visit's work so far (a new visit id starts it empty). */
export function visitWork(visitId: string): VisitWork {
  if (work.id !== visitId) work = { id: visitId, done: { worked: new Map(), enough: new Set() } };
  return work.done;
}

/**
 * What the wood gave, in words: materials are counted like stuff ("4
 * timber", "a little beeswax" for one), everything else like things.
 */
export function yieldPhrase(itemId: string, qty: number): string {
  if (itemDef(itemId)?.kind !== 'material') return giftPhrase(itemId, qty);
  const name = itemName(itemId).toLowerCase();
  return qty === 1 ? `a little ${name}` : `${qty} ${name}`;
}

/** The whole yield as one line: "4 timber and a green-ash haft". */
export function yieldLine(gathered: readonly { itemDef: string; qty: number }[]): string {
  return gathered.map((g) => yieldPhrase(g.itemDef, g.qty)).join(', ').replace(/, ([^,]*)$/, ' and $1');
}
