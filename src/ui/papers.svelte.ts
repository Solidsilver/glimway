/**
 * Reactive found-papers state for the interface: which papers this save
 * holds (from the game's paper events) and which of those the player has
 * opened (a per-device convenience in localStorage — it only drives the
 * "new" dot, so losing it is harmless).
 */
import { bus, EV } from '../game/events'
import { type PaperFoundPayload, type PapersSyncPayload } from '../game/papers'
import { readJson, stringList, writeJson } from '../lib/local-json'

// `fingersnap:` is the game's old name, kept so saved settings load.
const SEEN_KEY = 'fingersnap:papers-seen'

const loadSeen = (): string[] => readJson(SEEN_KEY, stringList, [])

/** Storage blocked: the dot just comes back next visit. */
const saveSeen = (list: string[]): void => void writeJson(SEEN_KEY, list)

class PapersStore {
  /** Paper ids this save has found, oldest first. */
  found = $state<string[]>([])
  seen = $state<string[]>(loadSeen())

  /** Found but never opened. */
  get unread(): string[] {
    return this.found.filter((id) => !this.seen.includes(id))
  }

  isNew(id: string): boolean {
    return this.found.includes(id) && !this.seen.includes(id)
  }

  markSeen(id: string): void {
    if (this.seen.includes(id)) return
    this.seen = [...this.seen, id]
    saveSeen(this.seen)
  }
}

export const papers = new PapersStore()

bus.on(EV.papersSync, (p: PapersSyncPayload) => {
  papers.found = [...p.found]
})
bus.on(EV.paperFound, (p: PaperFoundPayload) => {
  if (!papers.found.includes(p.id)) papers.found = [...papers.found, p.id]
})
