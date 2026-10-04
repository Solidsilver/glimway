/**
 * Connected-mode glue for the interface: the one API client (and its queue)
 * for this tab, the tab's play-client id, the server probe, and building a
 * connected Session from a server snapshot or the device's connected cache.
 *
 * Guest play never needs any of this: a build without a server probes once,
 * gets `unavailable`, and everything stays local.
 */
import { createApiClient, tabClientId } from '../lib/api/client'
import { errorCode } from '../lib/api/errors'
import type { ConnectedCache } from '../lib/api/cache'
import type { Snapshot } from '../lib/api/types'
import { Link } from '../game/link'
import { Session } from '../game/session'

export const api = createApiClient()
export const clientId = tabClientId()

export type Probe = { kind: 'signed-in'; snapshot: Snapshot } | { kind: 'signed-out' } | { kind: 'unavailable' }

/** One GET /api/state: a valid cookie means signed in, even with no remembered token. */
export async function probeServer(): Promise<Probe> {
  try {
    return { kind: 'signed-in', snapshot: await api.state() }
  } catch (err) {
    return errorCode(err) === 'unauthorized' ? { kind: 'signed-out' } : { kind: 'unavailable' }
  }
}

/** Display name for an account: the imported hero, else the cache, else a fallback. */
export function accountName(snapshot: Snapshot | null, cache: ConnectedCache | null, fallback = 'Your hero'): string {
  const cached = cache && (!snapshot || cache.habiticaId === snapshot.habiticaId) ? cache.name : ''
  return snapshot?.importedProfile?.name || cached || fallback
}

/**
 * A connected Session, not yet holding the lease. The device's cache wins
 * over the server snapshot when it belongs to this account and either holds
 * unsent progress (offline play, even from a closed tab) or was written by
 * this very tab. Call `session.link.reconnect()` next.
 */
export function connectedSession(opts: { snapshot: Snapshot | null; cache: ConnectedCache | null; name: string }): Session {
  const { snapshot, cache } = opts
  const habiticaId = snapshot?.habiticaId ?? cache?.habiticaId
  if (!habiticaId) throw new Error('connectedSession needs a snapshot or a cache')
  const useCache = !!cache && cache.habiticaId === habiticaId && (!snapshot || cache.dirty || cache.clientId === clientId)
  const base = useCache
    ? { state: cache!.state, rev: cache!.rev, vitalsSource: cache!.vitalsSource, importedProfile: cache!.importedProfile ?? null }
    : { state: snapshot!.state, rev: snapshot!.rev, vitalsSource: snapshot!.vitalsSource, importedProfile: snapshot!.importedProfile ?? null }
  const link = new Link({
    api,
    clientId,
    habiticaId,
    name: opts.name,
    rev: base.rev,
    lease: useCache && cache!.clientId === clientId ? cache!.lease : null,
    status: 'offline',
    dirty: useCache ? cache!.dirty : false,
    recovery: cache?.habiticaId === habiticaId ? cache.recovery : undefined
  })
  return new Session(base.state, { vitalsSource: base.vitalsSource, importedProfile: base.importedProfile }, link)
}
