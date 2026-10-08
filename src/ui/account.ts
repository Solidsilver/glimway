/**
 * Connected-mode glue for the interface: the one API client (and its queue)
 * for this tab, the page's play-client id, the server probe, and building a
 * connected Session from a server snapshot or the device's connected cache.
 *
 * There is no play without the server: a probe that gets no answer leaves
 * the title at its "can't reach the world" card (a device with a connected
 * cache can keep playing offline).
 */
import { claimClientId, createApiClient } from '../lib/api/client'
import { errorCode } from '../lib/api/errors'
import type { ConnectedCache } from '../lib/api/cache'
import type { Snapshot } from '../lib/api/types'
import type { Probe } from './account-flow.svelte'
import { Link, type Unresolved } from '../game/link'
import { Session } from '../game/session'
import { bus } from '../game/events'
import { update } from './update.svelte'

/**
 * The one API client, watching for `reload-needed` (the client's error path
 * calls back): a server that refuses this client's contract shows the reload
 * notice (src/ui/update.svelte.ts).
 */
export const api = createApiClient({ onReloadNeeded: () => update.reloadNeeded() })

/**
 * This page's play-client id, unique among live pages (a duplicated tab
 * gets its own). Claimed once at load; the channel stays open so later pages
 * hear that this one holds it.
 */
const claim = claimClientId()

/** Links that should follow this page's client id (one per connected session). */
const links = new Set<Link>()

/**
 * A frozen or back-forward-cached page can't answer a duplicate's claim, so
 * both may end up holding one id. When this page comes back, claim again; if
 * a live page answers, take a fresh id and move the running link to it.
 */
async function recheckClientId(): Promise<void> {
  const c = await claim
  const before = c.id
  const after = await c.reclaim()
  if (after === before) return
  for (const link of [...links]) {
    if (!link.active) links.delete(link)
    else void link.changeClient(after)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) void recheckClientId()
  })
  document.addEventListener('resume', () => void recheckClientId())
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void recheckClientId()
  })
}


/** One GET /api/state: a valid cookie means signed in, even with no remembered token. */
export async function probeServer(): Promise<Probe> {
  try {
    return { kind: 'signed-in', snapshot: await api.state() }
  } catch (err) {
    const code = errorCode(err)
    if (code === 'reload-needed') return { kind: 'reload-needed' }
    if (code === 'world-choice-required') {
      try {
        return { kind: 'choose-world', choice: await api.worldChoice() }
      } catch (again) {
        const next = errorCode(again)
        if (next === 'world-chosen') {
          // Chosen meanwhile (another device), or nothing was left to ask:
          // the world is there now.
          try {
            return { kind: 'signed-in', snapshot: await api.state() }
          } catch (last) {
            return errorCode(last) === 'unauthorized' ? { kind: 'signed-out' } : { kind: 'unavailable' }
          }
        }
        return next === 'unauthorized' ? { kind: 'signed-out' } : { kind: 'unavailable' }
      }
    }
    return code === 'unauthorized' ? { kind: 'signed-out' } : { kind: 'unavailable' }
  }
}

/** Display name for an account: the server's verified name, else the hero, else the cache. */
export function accountName(snapshot: Snapshot | null, cache: ConnectedCache | null, fallback = 'Your hero'): string {
  const cached = cache && (!snapshot || cache.accountId === snapshot.accountId) ? cache.name : ''
  return snapshot?.displayName || snapshot?.importedProfile?.name || cached || fallback
}

/**
 * A connected Session, not yet holding the lease. The account's cache wins
 * over the server snapshot when it holds unsent progress (offline play, even
 * from a closed tab or before a logout) or was written by this very page.
 * Call `session.link.reconnect()` next.
 */
export async function connectedSession(opts: { snapshot: Snapshot | null; cache: ConnectedCache | null; name: string }): Promise<Session> {
  const { snapshot } = opts
  const clientId = (await claim).id // current, even after a re-claim
  const accountId = snapshot?.accountId ?? opts.cache?.accountId
  if (!accountId) throw new Error('connectedSession needs a snapshot or a cache')
  const cache = opts.cache?.accountId === accountId ? opts.cache : null
  const useCache = !!cache && (!snapshot || cache.dirty || cache.clientId === clientId)
  const base = useCache
    ? { state: cache!.state, rev: cache!.rev, vitalsSource: cache!.vitalsSource, importedProfile: cache!.importedProfile ?? null }
    : { state: snapshot!.state, rev: snapshot!.rev, vitalsSource: snapshot!.vitalsSource, importedProfile: snapshot!.importedProfile ?? null }
  const link = new Link({
    api,
    clientId,
    accountId,
    worldId: snapshot?.worldId || cache?.worldId,
    name: opts.name,
    rev: base.rev,
    lease: useCache && cache!.clientId === clientId ? cache!.lease : null,
    status: 'offline',
    dirty: useCache ? cache!.dirty : false,
    offlineProgress: useCache ? cache!.offlineProgress : false,
    sent: useCache ? cache!.sent : undefined,
    recovery: cache?.recovery,
    // The same account's lost request is replayed whichever state snapshot wins.
    unresolved: cache?.unresolved as Unresolved | undefined,
    emit: (event, ...args) => bus.emit(event, ...args)
  })
  for (const old of [...links]) if (!old.active) links.delete(old)
  links.add(link)
  return new Session(base.state, { vitalsSource: base.vitalsSource, importedProfile: base.importedProfile }, link)
}
