import { CALENDAR } from '../../src/lib/calendar.ts'

/** First day of a named wick; marks group wicks and have different names. */
export function wickStart(wick: string): number {
  const index = CALENDAR.wicks.indexOf(wick)
  if (index < 0) throw new Error(`Unknown wick: ${wick}`)
  return Date.parse(CALENDAR.epoch) / 1000 + index * CALENDAR.wickDays * 86400
}
