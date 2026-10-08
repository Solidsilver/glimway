/**
 * The outer Wilds and the Turning — pure season rules shared by the client
 * and its tests. The server generates both regions and their story sites
 * (server/internal/wilds); this keeps only what the client reads them by.
 *
 * Epochs: the inner region (the Tangle) is permanent (season "0"). The outer
 * region turns every wick: its season is `t:<startsAt>:<endsAt>` — the
 * wick's UTC boundaries in Unix seconds, exactly what the server writes.
 */
import { CALENDAR, calendarAt, type Calendar } from '../calendar.ts';

export const INNER_REGION_ID = 'inner-1';
export const OUTER_REGION_ID = 'outer-1';

// ------------------------------------------------------------ epochs

/** The outer season for a moment: the wick it falls in, by its UTC bounds. */
export function outerSeasonAt(unix: number, cal: Calendar = CALENDAR): string {
  const d = calendarAt(Math.floor(unix), cal);
  return `t:${d.startsAt}:${d.nextTurning}`;
}

/**
 * The wick bounds a season names, or null for a permanent one ("0").
 * Older numeric seasons (an absolute wick number) are read through the
 * calendar so they keep working.
 */
export function seasonBounds(season: string, cal: Calendar = CALENDAR): { startsAt: number; endsAt: number } | null {
  const t = /^t:(-?\d+):(-?\d+)$/.exec(season);
  if (t) return { startsAt: Number(t[1]), endsAt: Number(t[2]) };
  const n = Number(season);
  if (!Number.isSafeInteger(n) || n === 0 || season.trim() !== season || season === '') return null;
  const epoch = Date.parse(cal.epoch) / 1000;
  const duration = cal.wickDays * 86400;
  const startsAt = epoch + (n - 1) * duration;
  return { startsAt, endsAt: startsAt + duration };
}

/** The Mark (Mudrise, Carting, Amberfall, Quiet) an outer season falls in. */
export function seasonMark(season: string, cal: Calendar = CALENDAR): string | null {
  const b = seasonBounds(season, cal);
  return b ? calendarAt(b.startsAt, cal).mark : null;
}

/** Has this epoch ended at `unix`? Permanent epochs never do. */
export function epochEnded(season: string, unix: number, endsAt?: number | null): boolean {
  const end = endsAt ?? seasonBounds(season)?.endsAt ?? null;
  return end !== null && unix >= end;
}

// ------------------------------------------------------------ story sites

/**
 * - echo: a phantom camp where an Echo of the Six can wait (outer).
 * - given: where the outer Wilds give a text back, by the crossing (outer entry).
 * - cairn: the Amberwash forage cairn (outer).
 * - nest: a dead iron-oak with a jackdaw's nest (outer).
 * - reeds: a backwater of the Wend, reeds and still water (outer).
 * - plank: a plank half-buried where the bridge tore (the Tangle crossing).
 */
export type SiteKind = 'echo' | 'given' | 'cairn' | 'nest' | 'reeds' | 'plank';

/** A story site's geometry, served in its chunk. */
export interface StorySite {
  /** Stable within the epoch: `<kind>` or `echo:<n>`. */
  id: string;
  kind: SiteKind;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
}
