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
import { readJson, stringList, writeJson } from '../lib/local-json'

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

// `fingersnap:` is the game's old name, kept so saved settings load.
const DAY_KEY = 'fingersnap:heard-day'
const DAY_MAX = 200
let day: string[] | null = null

function dayList(): string[] {
  day ??= readJson(DAY_KEY, stringList, [])
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
  writeJson(DAY_KEY, list) // refused: remembered for this visit
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
