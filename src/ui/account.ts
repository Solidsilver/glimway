/**
 * Connected-mode glue for the interface: the one API client (and its queue)
 * for this tab, the page's play-client id, the server probe, and building a
 * connected Session from a server snapshot or the device's connected cache.
 *
 * Guest play never needs any of this: a build without a server probes once,
 * gets `unavailable`, and everything stays local.
 */
import { claimClientId, claimDeviceId, createApiClient, newKey } from '../lib/api/client'
import { errorCode } from '../lib/api/errors'
import type { ConnectedCache } from '../lib/api/cache'
import type { Snapshot } from '../lib/api/types'
import type { Probe } from './account-flow.svelte'
import { fromJson } from '@bufbuild/protobuf'
import { PlayerStateSchema } from '../lib/gen/glimway/v1/state_pb.js'
import { profileOf } from '../lib/api/predict'
import { Link, openOutbox, outboxStore } from '../game/link'
import { Session } from '../game/session'
import { bus } from '../game/events'

export const api = createApiClient()

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
 * A connected Session, not yet holding the lease, built from the account's
 * outbox on this device (src/lib/api/outbox.ts) and the newest state known:
 * the server's answer, or the outbox's copy when no server answered. The old
 * connected cache (`cache`) is no longer read; its records are a clean break.
 * Call `session.link.reconnect()` next.
 */
export async function connectedSession(opts: { snapshot: Snapshot | null; cache: ConnectedCache | null; name: string }): Promise<Session> {
  const { snapshot } = opts
  const clientId = (await claim).id // current, even after a re-claim
  const accountId = snapshot?.accountId ?? opts.cache?.accountId
  if (!accountId) throw new Error('connectedSession needs a snapshot or a cache')
  const device = deviceId()
  const store = outboxStore()
  const record = await openOutbox(store, accountId, device)
  const state = snapshot?.player ?? (record.server ? fromJson(PlayerStateSchema, record.server, { ignoreUnknownFields: true }) : null)
  if (!state) throw new Error('connectedSession needs a state')
  const link = new Link({
    api,
    clientId,
    accountId,
    device,
    worldId: snapshot?.worldId || record.worldId,
    name: opts.name,
    state,
    record,
    status: 'offline',
    store,
    emit: (event, ...args) => bus.emit(event, ...args)
  })
  for (const old of [...links]) if (!old.active) links.delete(old)
  links.add(link)
  const profile = profileOf(state)
  return new Session(link.initialState(), { vitalsSource: profile ? 'imported' : 'demo', importedProfile: profile }, link)
}

function deviceId(): string {
  try {
    return claimDeviceId()
  } catch {
    // No localStorage: one device id for this page.
    return (pageDevice ??= newKey())
  }
}
let pageDevice: string | null = null
