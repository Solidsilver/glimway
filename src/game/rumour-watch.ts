/**
 * This wick's rumour follows the turning (docs/design/open-map.md 2.10):
 * the server reads it fresh into every state, but a turning changes it
 * without a version bump, so the client's same-version rule would keep the
 * old one. When the calendar's wick turns (or the dev clock jumps), the
 * state is read again, wherever the hero is: Elara has the next one.
 */
import { calendarAt } from '../lib/calendar.ts'
import { gameNow } from './clock.ts'
import { bus, EV } from './events.ts'
import type { Session } from './session.ts'

let watching: Session | null = null
let timer: ReturnType<typeof setInterval> | null = null
let wick = ''

const wickOf = (now: number) => {
  const d = calendarAt(now)
  return `${d.year}:${d.wickNumber}`
}

function check(): void {
  const s = watching
  if (!s) return
  const now = wickOf(gameNow())
  if (now === wick) return
  const first = wick === ''
  wick = now
  if (!first) void s.link?.refreshState()
}

/** Follow the turning for this session (a later call for another session takes over). */
export function watchRumour(session: Session): void {
  if (watching === session) return
  watching = session
  wick = ''
  check()
  if (!timer) {
    timer = setInterval(check, 15_000)
    bus.on(EV.clock, check)
  }
}
