import raw from '../../content/clock.json' with { type: 'json' };
import residentRaw from '../../content/residents.json' with { type: 'json' };
import type { Resident } from './residents.ts';
import { TURNING_NOTICE_FORMAT } from '../content/expansion-writing.ts';
import { decodeContent } from './content-proto.ts';
import { CalendarSchema, type CalendarValid } from './gen/glimway/content/v1/clock_pb.js';
export interface Festival { name: string; wick: string; day: number }
export interface Calendar { epoch: string; wickDays: number; wicks: string[]; marks: string[]; festivals: Festival[] }
export interface CalendarDay { wick: string; wickNumber: number; year: number; day: number; mark: string; festival: string | null; startsAt: number; nextTurning: number; notice: string | null; wickDays: number }
/**
 * Reads clock JSON through the schema (proto/glimway/content/v1/
 * clock.proto): the epoch's canonical midnight-UTC spelling, the fixed
 * wicks and marks, the festival count and each festival's wick and day
 * are all on it. The calendar's own rule — one name per festival — stays
 * here, naming the duplicate.
 */
export function validateCalendar(value: unknown): Calendar {
  const doc = decodeContent(CalendarSchema, value, 'calendar', ['festivals']) as unknown as CalendarValid;
  const seen = new Set<string>();
  for (const f of doc.festivals) {
    if (seen.has(f.name)) throw new Error(`invalid calendar: duplicate festival ${f.name}`);
    seen.add(f.name);
  }
  return doc as unknown as Calendar;
}
export const CALENDAR = validateCalendar(raw);
/** Unix seconds; no local timezone or wall clock dependency. */
export function calendarAt(unix: number, c: Calendar = CALENDAR): CalendarDay {
  if (!Number.isSafeInteger(unix)) throw new Error('invalid calendar time');
  const epoch = Date.parse(c.epoch) / 1000;
  const duration = c.wickDays * 86400;
  const index = Math.floor((unix - epoch) / duration);
  const w = ((index % 12) + 12) % 12;
  const startsAt = epoch + index * duration;
  const day = Math.floor((unix - startsAt) / 86400) + 1;
  const wick = c.wicks[w]!;
  const nextTurning = startsAt + duration;
  return { wick, wickNumber: index + 1, year: Math.floor(index / 12) + 1, day, mark: c.marks[w]!, festival: c.festivals.find(f => f.wick === wick && f.day === day)?.name ?? null, startsAt, nextTurning, notice: nextTurning - unix <= 86400 ? TURNING_NOTICE_FORMAT.replace('{wick}', wick) : null, wickDays: c.wickDays };
}

export function nextTurning(now: number, c: Calendar = CALENDAR): number { return calendarAt(now, c).nextTurning; }

/** Wait from the last gated step (or first step); Unix seconds, never play time. */
export function questWaitReady(wait: { hours?: number; turnings?: number }, since: number, now: number): boolean {
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(now) || now < since) return false;
  if (wait.hours !== undefined) return now - since >= wait.hours * 3600;
  return calendarAt(now).wickNumber - calendarAt(since).wickNumber >= (wait.turnings ?? 0);
}
/** Times are Unix seconds, including fractional values. */
export function recovered(stored: number, rate: number, cap: number, since: number, now: number): number {
 return Math.min(cap, stored + rate * Math.max(0, now - since));
}

export interface CyclePlace { spot: string; since: number; until: number }
/** Half-open phase intervals from Unix zero; negative times wrap by floor. */
export function cycleAt(resident: Resident, now: number): CyclePlace {
  if (!Number.isFinite(now)) throw new Error('invalid cycle time');
  const period = residentRaw.periodMinutes * 60, offset = (resident.offsetMinutes ?? 0) * 60;
  let start = Math.floor((now - offset) / period) * period + offset;
  for (const phase of resident.cycle) {
    const until = start + phase.minutes * 60;
    if (now < until) return { spot: phase.spot, since: start, until };
    start = until;
  }
  throw new Error('invalid resident cycle');
}
/** Current, then previous and next in the inclusive grace window, deduplicated. */
export function cycleSpotsNear(resident: Resident, now: number, graceSeconds: number): string[] {
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) throw new Error('invalid cycle grace');
  const current = cycleAt(resident, now), spots = new Set([current.spot]);
  if (graceSeconds > 0 && now - current.since <= graceSeconds) spots.add(cycleAt(resident, current.since - 1).spot);
  if (graceSeconds > 0 && current.until - now <= graceSeconds) spots.add(cycleAt(resident, current.until).spot);
  return [...spots];
}
