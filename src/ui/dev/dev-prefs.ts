/**
 * Dev mode's own conveniences on this device (localStorage): whether the
 * docked panel was open, which of its sections are folded, and the last few
 * things given. Imported only by dev-tools code (App behind DEV_TOOLS, the
 * dev panel), so a release build never carries it.
 */
import { readJson, stringList, writeJson } from '../../lib/local-json.ts';

const KEY = 'fingersnap:dev-panel';

/** The panel's sections, top to bottom. */
export const DEV_SECTIONS = ['clock', 'quick', 'give', 'world-lab', 'terrain', 'height-lab', 'timings'] as const;
export type DevSection = (typeof DEV_SECTIONS)[number];

export interface DevPrefs {
  /** The docked panel (desktop) was open at the last change. */
  open: boolean;
  /** Each section unfolded (true) or folded. */
  sections: Record<DevSection, boolean>;
  /** The last things given, newest first. */
  recent: string[];
}

/** Unfolded at first: everything but the load timings. */
export const DEFAULT_SECTIONS: Record<DevSection, boolean> = { clock: true, quick: true, give: true, 'world-lab': true, terrain: true, 'height-lab': true, timings: false };

/** How many recent things the panel keeps. */
export const RECENT_MAX = 8;

export function parseDevPrefs(v: unknown): DevPrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const s = (o.sections && typeof o.sections === 'object' ? o.sections : {}) as Record<string, unknown>;
  const sections = { ...DEFAULT_SECTIONS };
  for (const k of DEV_SECTIONS) if (typeof s[k] === 'boolean') sections[k] = s[k];
  return { open: o.open === true, sections, recent: stringList(o.recent).slice(0, RECENT_MAX) };
}

export function loadDevPrefs(): DevPrefs {
  return readJson(KEY, parseDevPrefs, parseDevPrefs(null));
}

/** Merge a change into what is stored. */
export function saveDevPrefs(change: Partial<DevPrefs>): DevPrefs {
  const next = { ...loadDevPrefs(), ...change };
  writeJson(KEY, next);
  return next;
}

/** `ids` given just now, at the front of the recent list (no repeats). */
export function withRecent(recent: readonly string[], ids: readonly string[]): string[] {
  const fresh = [...new Set(ids)];
  return [...fresh, ...recent.filter((id) => !fresh.includes(id))].slice(0, RECENT_MAX);
}
