/**
 * Papers and the Hearthwick Library, game side: granting a found paper
 * (one story flag, a toast, a UI event) and the library's shelf for this
 * session — local for guests, the world's shared shelf for connected
 * players (falling back to local while the server has no library).
 */
import { DEMO_CHARACTER } from '../content/world.ts'
import { foundPapers, foundToast, paperById, paperFlag } from '../content/papers.ts'
import { createRemoteLibrary, donationFlag, localDonations, mergeShelf, type RemoteLibrary, type ShelfEntry } from '../lib/papers/library.ts'
import type { LibraryDonateResponse } from '../lib/api/client.ts'
import { bus, EV } from './events.ts'
import { sfx } from './sfx.ts'
import type { Session } from './session.ts'
import { KEEPER } from '../content/residents.ts'

export interface PaperFoundPayload {
  id: string
}

export interface PapersSyncPayload {
  found: string[]
}

/** Tell the UI which papers this save holds (load, server merge, new game). */
export function emitPapers(session: Session): void {
  const payload: PapersSyncPayload = { found: foundPapers(session.state.flags) }
  bus.emit(EV.papersSync, payload)
}

/** Record a find once: flag, chime, toast. Returns false if already held. */
export function grantPaper(session: Session, id: string, opts: { quiet?: boolean } = {}): boolean {
  const paper = paperById(id)
  if (!paper || session.state.flags.includes(paperFlag(id))) return false
  session.addFlag(paperFlag(id))
  if (!session.state.flags.includes(paperFlag(id))) return false // session torn down
  announcePaper(session, id, opts)
  return true
}

/**
 * A paper arrived: chime, toast, UI event. Also for papers the server grants
 * on its own (a quest step's, a claim's, a turning's), when their mark first
 * shows in an adopted state.
 */
export function announcePaper(session: Session, id: string, opts: { quiet?: boolean } = {}): void {
  const paper = paperById(id)
  if (!paper) return
  if (!opts.quiet) {
    sfx('discover')
    bus.emit(EV.toast, { text: foundToast(paper), icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: paper.title } })
  }
  const payload: PaperFoundPayload = { id }
  bus.emit(EV.paperFound, payload)
  emitPapers(session)
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

  private readonly session: Session

  constructor(session: Session, remote?: RemoteLibrary) {
    this.session = session
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
    const link = this.session.link
    if (this.connected && link) {
      // The server checks you hold it against its own `paper:` mark, so the
      // take that found it goes first: the donation queues behind it.
      await link.flush()
      const r = await link.mutate<LibraryDonateResponse>({ kind: 'donate', fields: { paperId } })
      if (r.ok) {
        const entry = r.res.result.entry
        lastShared = [...lastShared.filter((e) => e.paperId !== paperId), entry]
        sfx('lantern')
        return { ok: true, entry }
      }
      if (r.code === 'already-shelved') return { ok: false, text: 'Someone in your world shelved that one first.' }
      // Donating waits for Elara at her desk (docs/design/indoors.md 3.3): her note says where she is.
      if (r.code === 'not-here') return { ok: false, text: KEEPER.away }
      if (r.code === 'offline' || r.code === 'pending') return { ok: false, text: 'Needs a connection. Your paper is safe — try again when you’re back online.' }
      if (r.code === 'unauthorized') return { ok: false, text: 'You’re signed out of your world. Sign in again to donate.' }
      if (r.code === 'not-held') return { ok: false, text: 'Your world hasn’t seen that find yet. Give it a moment, then try again.' }
      return { ok: false, text: 'The librarian couldn’t take it just now. Try again in a moment.' }
    }
    const shelf = mergeShelf(this.local())
    if (shelf.has(paperId)) return { ok: false, text: 'That one is already on the shelves.' }
    const now = new Date()
    this.session.addFlag(donationFlag(paperId, now))
    sfx('lantern')
    return { ok: true, entry: { paperId, donatedBy: playerName(this.session), donatedAt: donationFlag(paperId, now).split('@')[1] } }
  }
}
