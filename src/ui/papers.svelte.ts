/**
 * Reactive found-papers state for the interface: which papers this save
 * holds (from the game's PAPER_EV events) and which of those the player has
 * opened (a per-device convenience in localStorage — it only drives the
 * "new" dot, so losing it is harmless).
 */
import { bus } from '../game/events'
import { PAPER_EV, type PaperFoundPayload, type PapersSyncPayload } from '../game/papers'

const SEEN_KEY = 'fingersnap:papers-seen'

function loadSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveSeen(list: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(list))
  } catch {
    /* storage blocked: the dot just comes back next visit */
  }
}

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

bus.on(PAPER_EV.sync, (p: PapersSyncPayload) => {
  papers.found = [...p.found]
})
bus.on(PAPER_EV.found, (p: PaperFoundPayload) => {
  if (!papers.found.includes(p.id)) papers.found = [...papers.found, p.id]
})
