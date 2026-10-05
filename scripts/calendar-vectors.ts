import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CALENDAR, calendarAt } from '../src/lib/calendar.ts';
export function calendarVectors() {
  const epoch = Date.parse(CALENDAR.epoch) / 1000;
  const times = new Set<number>([0, epoch - 1, epoch, epoch + 1, Date.parse('2028-02-29T12:00:00Z') / 1000]);
  for (const wickDays of [7, 9, 14]) {
    const c = { ...CALENDAR, wickDays };
    for (let wick = -1; wick <= 24; wick++) for (const day of [0, 1, 5, 6, wickDays - 1, wickDays]) for (const second of [-1, 0, 1]) times.add(epoch + (wick * wickDays + day) * 86400 + second);
  }
  return [7, 9, 14].flatMap(wickDays => [...times].sort((a,b) => a-b).map(unix => ({ wickDays, unix, result: calendarAt(unix, { ...CALENDAR, wickDays }) })));
}
export function serializeCalendarVectors() { return JSON.stringify(calendarVectors()) + '\n'; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFileSync(new URL('../content/vectors/calendar.json', import.meta.url), serializeCalendarVectors());
