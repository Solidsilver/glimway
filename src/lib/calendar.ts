import raw from '../../content/calendar.json' with { type: 'json' };
export interface Festival { name: string; wick: string; day: number }
export interface Calendar { epoch: string; wickDays: number; wicks: string[]; marks: string[]; festivals: Festival[] }
export interface CalendarDay { wick: string; wickNumber: number; year: number; day: number; mark: string; festival: string | null; startsAt: number; nextTurning: number; notice: string | null; wickDays: number }
export function validateCalendar(value: unknown): Calendar {
  const c = value as Calendar;
  const wicks = ['Thaw','Mud','Bud','Bloom','Light','Cart','Haze','Sap','Amber','Leaf','Smoke','Quiet'];
  const marks = ['Mudrise','Mudrise','Mudrise','Carting','Carting','Carting','Amberfall','Amberfall','Amberfall','Quiet','Quiet','Quiet'];
  if (!c || typeof c.epoch !== 'string' || !/^\d{4}-\d\d-\d\dT00:00:00Z$/.test(c.epoch) || !Number.isFinite(Date.parse(c.epoch)) || new Date(c.epoch).toISOString() !== c.epoch.replace('Z','.000Z') || !Number.isSafeInteger(c.wickDays) || c.wickDays < 7 || c.wickDays > 365 || JSON.stringify(c.wicks) !== JSON.stringify(wicks) || JSON.stringify(c.marks) !== JSON.stringify(marks) || !Array.isArray(c.festivals) || c.festivals.length !== 4) throw new Error('invalid calendar');
  const seen = new Set<string>();
  for (const f of c.festivals) { if (!f || typeof f.name !== 'string' || !f.name || seen.has(f.name) || !wicks.includes(f.wick) || !Number.isSafeInteger(f.day) || f.day < 1 || f.day > c.wickDays) throw new Error('invalid calendar festival'); seen.add(f.name); }
  return c;
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
  return { wick, wickNumber: index + 1, year: Math.floor(index / 12) + 1, day, mark: c.marks[w]!, festival: c.festivals.find(f => f.wick === wick && f.day === day)?.name ?? null, startsAt, nextTurning, notice: nextTurning - unix <= 86400 ? `Dark of ${wick}-wick — the outer Wilds will turn.` : null, wickDays: c.wickDays };
}
