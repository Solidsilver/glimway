/**
 * The residents, game side: what they can see of the world when you talk
 * to them (today's date, the world's projects, your plot), recording the
 * first meeting (a story flag, which also writes their journal entry), and
 * telling the interface who you have met. The words are in
 * src/content/residents.ts.
 */
import { metAt, metFlag, RESIDENT_IDS, type ResidentContext, type ResidentId } from '../content/residents'
import { bus } from './events'
import { homesteadsFor } from './homestead'
import type { Session } from './session'
import { villageFor } from './village'

export const RESIDENT_EV = {
  /** Flags used to assemble journal entries, including first meetings. */
  met: 'ui:residents-met'
} as const

export interface ResidentsMetPayload {
  journalFlags: string[]
}

export function residentContext(session: Session): ResidentContext {
  const village = villageFor(session)
  const homes = homesteadsFor(session)
  const c = village.calendar
  const projects: Record<string, 'open' | 'in-progress' | 'complete'> = {}
  if (village.projectsStatus === 'ready') for (const p of village.projects) projects[p.id] = p.stage
  return {
    stage: session.questStage,
    flags: session.state.flags,
    calendar: { wick: c.wick, day: c.day, mark: c.mark, festival: c.festival, notice: c.notice },
    projects,
    home: { claimed: homes.claimed, tier: homes.mine?.tier ?? null, connected: homes.connected }
  }
}

/** Record a first meeting (once): the flag carries the stage, for the journal's order. */
export function meetResident(session: Session, id: ResidentId): void {
  if (metAt(session.state.flags, id)) return
  session.addFlag(metFlag(id, session.questStage))
  emitResidents(session)
}

/** Tell the interface who this save has met (load, merges, meetings). */
export function emitResidents(session: Session): void {
  const journalFlags = session.state.flags.filter((f) => RESIDENT_IDS.some((id) => f.startsWith(`met:${id}@`)) || f.startsWith('unmoored:') || f === 'warden-sliver:found')
  const payload: ResidentsMetPayload = { journalFlags }
  bus.emit(RESIDENT_EV.met, payload)
}
