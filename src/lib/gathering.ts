/**
 * Gathering rules, caps, targets and yields (content/gathering.json; docs/items/).
 * Shared with the Go server (content/gathering.go).
 */
import raw from '../../content/gathering.json' with { type: 'json' };

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
