/**
 * Gathering rules, caps, targets and yields (content/gathering.json; docs/items/).
 * Shared with the Go server (content/gathering.go).
 */
import raw from '../../content/gathering.json' with { type: 'json' };
import { giftPhrase, itemDef, itemName } from './items.ts';

interface GatheringActionCaps {
  chop: number;
  break: number;
  dig: number;
}

interface GatheringCaps {
  visit: GatheringActionCaps;
  day: GatheringActionCaps;
}

interface GatheringYield {
  item: string;
  min: number;
  max: number;
  chancePermille?: number;
  /** The yield only turns up in this mark (a season; the server's clock decides). */
  mark?: string;
}

export interface GatheringTarget {
  action: 'chop' | 'break' | 'dig';
  toolAction: 'chop' | 'break' | 'dig';
  name: string;
  yields: GatheringYield[];
  /** The button word when the work isn't a chop, break or dig ("Sweep", "Pick"). */
  verb?: string;
  /** The piece only stands in its season: a mark, or one wick's week. */
  mark?: string;
  wick?: string;
}

export interface GatheringData {
  caps: GatheringCaps;
  softCapLine: string;
  /** How many plants one home's land tends; past it the ground is full. */
  plantsPerHome: number;
  /** The targets each kind of place has: wilds (the Tangle, the Whitequiet), woodland, home, the village, the Commons. */
  areas: Record<string, string[]>;
  swings: Record<string, number>;
  targets: Record<string, GatheringTarget>;
  seeds: string[];
}

export const GATHERING_DATA = raw as GatheringData;

export function gatheringTarget(id: string): GatheringTarget | undefined {
  return GATHERING_DATA.targets[id];
}

/** Whether a place (a progress area) has pieces of a target at all (the server checks the same). */
export function gatheringOffered(area: string, target: string): boolean {
  const kind = area.startsWith('home:') ? 'home' : area;
  return (GATHERING_DATA.areas[kind] ?? []).includes(target);
}

/**
 * The seasons (docs/items/crafting-and-repair.md, "Seasonal materials"): a
 * piece or a yield only turns up in its mark, or its one wick's week — the
 * server's own clock and calendar decide, never the client.
 */
export function inSeason(gate: { mark?: string; wick?: string }, day: { mark: string; wick: string }): boolean {
  if (gate.mark && day.mark !== gate.mark) return false;
  return !gate.wick || day.wick === gate.wick;
}

/**
 * A seasonal piece stays standing through its season however often it's
 * worked (the freshet keeps washing shells up, the pond keeps freezing
 * over): the day's caps hold you, not the map. Everything else leaves a
 * stump or open ground.
 */
export function keepsStanding(target: string): boolean {
  return target === 'freshet-shore' || target === 'bloom-patch' || target === 'pond-ice';
}

/** The line when a home's land already tends all the plants it can. */
export const PLANTS_FULL_LINE = 'Your land has all the planting it can tend.';

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

/** Where the woods can be worked: the Tangle and the Whitequiet, the woods, home land, and the village's water (in season). */
export function gatherArea(area: string): boolean {
  return area === 'wilds' || area === 'woodland' || area === 'village' || area === 'commons' || area.startsWith('home:');
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

/** The button word for a gathering action (the touch action button); a target's own word wins. */
export function gatheringVerb(action: string, override?: string): string {
  if (override) return override;
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
 * What a worked piece leaves standing: a felled tree leaves a stump, a
 * broken boulder leaves pebbles, a dug-out stump or patch leaves nothing.
 * `action` is the work the piece itself answers to (a rebuild replays a
 * dug-out tree from the tree, so `now` decides first).
 */
export function leftBehind(action: string, now: 'stump' | 'open'): 'stump' | 'pebbles' | null {
  if (now === 'stump') return 'stump';
  return action === 'break' ? 'pebbles' : null;
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
function yieldPhrase(itemId: string, qty: number): string {
  if (itemDef(itemId)?.kind !== 'material') return giftPhrase(itemId, qty);
  const name = itemName(itemId).toLowerCase();
  return qty === 1 ? `a little ${name}` : `${qty} ${name}`;
}

/** The whole yield as one line: "4 timber and a green-ash haft". */
export function yieldLine(gathered: readonly { itemDef: string; qty: number }[]): string {
  return gathered.map((g) => yieldPhrase(g.itemDef, g.qty)).join(', ').replace(/, ([^,]*)$/, ' and $1');
}

/** Nothing came of it (an herb patch or a seedling dig can come up empty). */
export const EMPTY_YIELD_LINE = 'Nothing worth keeping this time.';

/** How a tool is named in a line: "Your bench axe", "The Brack felling axe", "Ada’s garden spade". */
function toolSubject(id: string): string {
  const name = itemName(id);
  if (/’s|'s/.test(name)) return name;
  if (itemDef(id)?.grade === 'heirloom') return `The ${name}`;
  return `Your ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

/** A fitting named plainly ("the road-nail"). */
function fittingName(id: string): string {
  const name = itemName(id);
  return `the ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

/**
 * What the work did to the tool, in one line, or null when nothing worth
 * saying happened (docs/items/overview.md: wear is told as a story). A
 * cheap tool giving out, an heirloom going blunt or cracking at zero (a
 * blunt tool refuses, so a landed use that leaves it blunt is the one that
 * blunted it), a fitting wearing away.
 */
export function wearLine(wear: { broke: boolean; state: string; wornOut: readonly string[]; returned: readonly string[]; itemDef: string; usesLeft: number } | undefined): string | null {
  if (!wear || !wear.itemDef) return null;
  const tool = toolSubject(wear.itemDef);
  if (wear.broke) {
    const back = wear.returned.map(fittingName);
    return back.length ? `${tool} gave out. You kept ${back.join(' and ')}.` : `${tool} gave out.`;
  }
  if (wear.state === 'blunt' || wear.state === 'cracked') {
    return `${tool} has ${wear.state === 'blunt' ? 'gone blunt' : 'cracked'}. Mend it at your bench, or ask Silas or Orrin.`;
  }
  if (wear.wornOut.length) return `${wear.wornOut.map(fittingName).join(' and ').replace(/^t/, 'T')} wore away.`;
  return null;
}
