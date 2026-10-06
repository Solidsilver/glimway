/**
 * What the player has already heard each person say (src/content/talk.ts).
 *
 * - Story lines (an introduction, what they say at a quest stage, a state
 *   of your homestead) are few and fixed: a `heard:<who>@<what>` flag in the
 *   save, so it follows you to every device (the server merges story flags;
 *   they aren't economy flags).
 * - Lines about the day (a festival, a notice, a project, the season) come
 *   round again and again: remembered on this device only, the last 200, so
 *   the save never grows with the calendar.
 */
import type { Session } from './session'
import { GREETINGS } from '../content/talk'

const PREFIX = 'heard:'

export function heardFlag(who: string, what: string): string {
  return `${PREFIX}${who}@${what}`
}

export function heardStory(flags: readonly string[], who: string, what: string): boolean {
  return flags.includes(heardFlag(who, what))
}

export function markStory(session: Session, who: string, what: string): void {
  session.addFlag(heardFlag(who, what))
}

// ------------------------------------------------------- lines about the day

const DAY_KEY = 'fingersnap:heard-day'
const DAY_MAX = 200
let day: string[] | null = null

function dayList(): string[] {
  if (day) return day
  try {
    const v = JSON.parse(localStorage.getItem(DAY_KEY) ?? '[]')
    day = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    day = []
  }
  return day
}

export function heardDay(who: string, topic: string): boolean {
  return dayList().includes(`${who}@${topic}`)
}

export function markDay(who: string, topic: string): void {
  const list = dayList()
  const key = `${who}@${topic}`
  if (list.includes(key)) return
  list.push(key)
  if (list.length > DAY_MAX) list.splice(0, list.length - DAY_MAX)
  try {
    localStorage.setItem(DAY_KEY, JSON.stringify(list))
  } catch {
    /* remembered for this visit */
  }
}

// ------------------------------------------------------------- greetings

const turn: Record<string, number> = {}

/** The next greeting for a person (in turn, starting somewhere different each day). */
export function greetingFor(who: string, fallback = 'Hello again.'): string {
  const lines = GREETINGS[who]
  if (!lines?.length) return fallback
  const start = turn[who] ?? Math.floor(Date.now() / 86_400_000)
  turn[who] = start + 1
  return lines[start % lines.length]
}
