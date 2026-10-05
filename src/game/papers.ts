/**
 * Papers and the Hearthwick Library, game side: granting a found paper
 * (one story flag, a toast, a UI event) and the library's shelf for this
 * session — local for guests, the world's shared shelf for connected
 * players (falling back to local while the server has no library).
 *
 * Events live here rather than in events.ts so this feature stays one
 * module the UI subscribes to.
 */
import { DEMO_CHARACTER } from '../content/world'
import { foundPapers, foundToast, paperById, paperFlag } from '../content/papers'
import { createRemoteLibrary, donationFlag, localDonations, mergeShelf, type RemoteLibrary, type ShelfEntry } from '../lib/papers/library'
import { newKey } from '../lib/api/client'
import { bus, EV } from './events'
import { sfx } from './sfx'
import type { Session } from './session'

export const PAPER_EV = {
  /** A paper was found just now: { id }. */
  found: 'ui:paper-found',
  /** The full found list for this save: { found: string[] }. */
  sync: 'ui:papers-sync',
  /** The player stepped up to the library door. */
  openLibrary: 'ui:library-open'
} as const

export interface PaperFoundPayload {
  id: string
}

export interface PapersSyncPayload {
  found: string[]
}

/** Tell the UI which papers this save holds (load, server merge, new game). */
export function emitPapers(session: Session): void {
  const payload: PapersSyncPayload = { found: foundPapers(session.state.flags) }
  bus.emit(PAPER_EV.sync, payload)
}

/** Record a find once: flag, chime, toast. Returns false if already held. */
export function grantPaper(session: Session, id: string, opts: { quiet?: boolean } = {}): boolean {
  const paper = paperById(id)
  if (!paper || session.state.flags.includes(paperFlag(id))) return false
  session.addFlag(paperFlag(id))
  if (!session.state.flags.includes(paperFlag(id))) return false // session torn down
  if (!opts.quiet) {
    sfx('discover')
    bus.emit(EV.toast, { text: foundToast(paper), icon: 'scroll' })
  }
  const payload: PaperFoundPayload = { id }
  bus.emit(PAPER_EV.found, payload)
  emitPapers(session)
  return true
}

// ------------------------------------------------------------ the library

export type ShelfMode = 'local' | 'shared'

export interface ShelfView {
  shelf: Map<string, ShelfEntry>
  /** shared: the world's shelf on the server; local: this save only. */
  mode: ShelfMode
  /** Connected, but the world's shelf could not be reached just now. */
  offline: boolean
}

export type DonateResult = { ok: true; entry: ShelfEntry } | { ok: false; text: string }

/** Once a server says it has no library, stop asking for this page load. */
let remoteUnsupported = false
/** Last shared shelf seen (shown, marked offline, when the server is unreachable). */
let lastShared: ShelfEntry[] = []

export function playerName(session: Session): string {
  return session.link?.name || session.importedProfile?.name || DEMO_CHARACTER.name
}

export class Library {
  private remote: RemoteLibrary

  constructor(private session: Session, remote?: RemoteLibrary) {
    this.remote = remote ?? createRemoteLibrary()
  }

  private get connected(): boolean {
    return !!this.session.link && !remoteUnsupported
  }

  private local(): ShelfEntry[] {
    return localDonations(this.session.state.flags, playerName(this.session))
  }

  async load(): Promise<ShelfView> {
    if (this.connected) {
      const r = await this.remote.load()
      if (r.ok) {
        lastShared = r.shelves
        // Anything donated locally before the server had a library still counts.
        return { shelf: mergeShelf(r.shelves, this.local()), mode: 'shared', offline: false }
      }
      if (r.reason === 'unsupported') remoteUnsupported = true
      else return { shelf: mergeShelf(lastShared, this.local()), mode: 'shared', offline: true }
    }
    return { shelf: mergeShelf(this.local()), mode: 'local', offline: false }
  }

  async donate(paperId: string): Promise<DonateResult> {
    const paper = paperById(paperId)
    if (!paper) return { ok: false, text: 'That page isn’t one the library knows.' }
    if (!this.session.state.flags.includes(paperFlag(paperId))) return { ok: false, text: 'You can only donate papers you have found yourself.' }
    if (this.connected) {
      // The server checks you hold it against your stored progress, so the
      // upload carrying this find must land before the donation is sent.
      await this.session.save()
      await this.session.link?.flush()
      const r = await this.remote.donate(paperId, newKey())
      if (r.ok) {
        lastShared = [...lastShared.filter((e) => e.paperId !== paperId), r.entry]
        sfx('lantern')
        return r
      }
      if (r.reason === 'already-shelved') {
        if (r.entry) lastShared = [...lastShared.filter((e) => e.paperId !== paperId), r.entry]
        return { ok: false, text: 'Someone in your world shelved that one first.' }
      }
      if (r.reason === 'offline') return { ok: false, text: 'Needs a connection. Your paper is safe — try again when you’re back online.' }
      if (r.reason === 'signed-out') return { ok: false, text: 'You’re signed out of your world. Sign in again to donate.' }
      if (r.reason === 'not-held') return { ok: false, text: 'Your world hasn’t seen that find yet. Give it a moment, then try again.' }
      if (r.reason !== 'unsupported') return { ok: false, text: 'The librarian couldn’t take it just now. Try again in a moment.' }
      remoteUnsupported = true
    }
    const shelf = mergeShelf(this.local())
    if (shelf.has(paperId)) return { ok: false, text: 'That one is already on the shelves.' }
    const now = new Date()
    this.session.addFlag(donationFlag(paperId, now))
    sfx('lantern')
    return { ok: true, entry: { paperId, donatedBy: playerName(this.session), donatedAt: donationFlag(paperId, now).split('@')[1] } }
  }
}

/** Test seam: forget what this page learned about the server's library. */
export function resetLibraryCache(): void {
  remoteUnsupported = false
  lastShared = []
}
