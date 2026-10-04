/**
 * Link — the connected half of a Session. Owns the play lease, the revision
 * the local copy is based on, and every server write for one signed-in
 * player (design: "Revisions, conflicts, and offline play").
 *
 * - Saves go to the connected cache (src/lib/api/cache.ts) and, while
 *   online, upload as a progress document with `baseRev`.
 * - Spends and syncs carry the current progress and wait for the server; the
 *   world freezes for the short wait (Session.persistenceInFlight).
 * - Losing the network switches to offline play: saves stay local, spends
 *   and syncs say "Needs a connection", and a reconnect follows the design's
 *   lease-then-upload flow.
 * - A takeover elsewhere ends this tab's lease: status `superseded` until
 *   the player chooses Take over.
 *
 * All calls share the API client's queue, so nothing overlaps.
 */
import type { ApiClient } from '../lib/api/client'
import { newKey } from '../lib/api/client'
import { errorCode, isUnreachable, type ApiErrorCode } from '../lib/api/errors'
import { embersGained, failureAction, mergeServerState, reconnectNotice, reconnectPlan, toProgress, type MergeMode } from '../lib/api/progress'
import { saveCache, type ConnectedCache } from '../lib/api/cache'
import type { Snapshot, SpendRequest, SyncResponse } from '../lib/api/types'
import type { HabiticaProfile } from '../lib/habitica/types'
import { FLAGS, WELCOME_EMBERS, type EmberSpend, type SpendReason } from '../lib/embers'
import type { GameState } from '../lib/state'
import { bus, EV, type LinkPayload, type LinkStatus } from './events'
import type { Session } from './session'

const HEARTBEAT_MS = 30_000
const RETRY_MS = 8_000

export type RemoteSpendResult = null | SpendReason | 'offline' | 'superseded' | 'unsafe' | 'busy' | 'error'

export type RemoteSyncResult =
  | { ok: true; status: SyncResponse['status']; gained: number; welcome: number; credit: { hp: number; mana: number } }
  | { ok: false; code: ApiErrorCode | 'offline' | 'busy' }

export interface LinkInit {
  api: ApiClient
  clientId: string
  habiticaId: string
  name: string
  rev: number
  lease: string | null
  status: 'online' | 'offline'
  /** The cache holds changes the server hasn't seen (offline play). */
  dirty?: boolean
  recovery?: ConnectedCache['recovery']
  /** Injectable for tests. */
  writeCache?: (record: ConnectedCache) => Promise<boolean>
}

/** Story and vitals only — play time alone is not worth an upload. */
function docKey(state: GameState): string {
  const { playSeconds: _ignored, ...rest } = toProgress(state)
  return JSON.stringify(rest)
}

export class Link {
  readonly api: ApiClient
  readonly clientId: string
  readonly habiticaId: string
  name: string
  /** Server revision the local copy is based on. */
  rev: number
  lease: string | null
  status: LinkStatus
  /** A spend or sync is out: the world waits. */
  busy = false
  recovery: ConnectedCache['recovery']
  private session: Session | null = null
  /** docKey of the last state the server accepted ('' = unknown, so dirty). */
  private acked: string
  /** True once local changes were made while offline (drives the notice). */
  private offlineProgress: boolean
  private uploadQueued = false
  private heartbeat: number | null = null
  private retry: number | null = null
  private lastContact = Date.now()
  private stopped = false
  private reconnecting: Promise<void> | null = null
  private readonly writeCache: (record: ConnectedCache) => Promise<boolean>
  private readonly onOnline = () => {
    if (this.status === 'offline') void this.reconnect(false)
  }

  constructor(init: LinkInit) {
    this.api = init.api
    this.clientId = init.clientId
    this.habiticaId = init.habiticaId
    this.name = init.name
    this.rev = init.rev
    this.lease = init.lease
    this.status = init.status
    this.recovery = init.recovery
    this.acked = init.dirty ? '' : 'pending'
    this.offlineProgress = init.status === 'offline' && init.dirty === true
    this.writeCache = init.writeCache ?? saveCache
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline)
  }

  /** Bind the live session (once, before play starts). */
  attach(session: Session): void {
    this.session = session
    if (this.acked === 'pending') this.acked = docKey(session.state)
    if (this.status === 'online') this.startHeartbeat()
    else this.scheduleRetry()
    this.emit()
  }

  get online(): boolean {
    return this.status === 'online'
  }

  get dirty(): boolean {
    return !!this.session && docKey(this.session.state) !== this.acked
  }

  // ------------------------------------------------------------ persistence

  /** Session.save for connected play: cache always, upload while online. */
  async persist(): Promise<void> {
    if (this.stopped || !this.session) return
    if (this.status === 'offline' && this.dirty) this.offlineProgress = true
    // A taken-over tab must not overwrite the device's cache. A signed-out
    // one keeps caching: signing in again (any 401: idle or lifetime expiry)
    // finds the unsent progress there and uploads it.
    if (this.status === 'superseded') return
    await this.saveLocal()
    this.scheduleUpload()
  }

  private async saveLocal(): Promise<void> {
    const s = this.session
    if (!s) return
    const ok = await this.writeCache({
      habiticaId: this.habiticaId,
      name: this.name,
      state: s.state,
      vitalsSource: s.vitalsSource,
      importedProfile: s.importedProfile ?? undefined,
      rev: this.rev,
      lease: this.lease,
      clientId: this.clientId,
      dirty: this.dirty,
      offline: this.status === 'offline',
      recovery: this.recovery,
      savedAt: Date.now()
    })
    if (!ok && this.status === 'offline') {
      bus.emit(EV.toast, { text: 'This browser wouldn’t save your offline progress. Reconnect soon.', kind: 'error' })
    }
  }

  private scheduleUpload(): void {
    if (this.status !== 'online' || !this.lease || this.uploadQueued || !this.dirty) return
    this.uploadQueued = true
    void this.api
      .run(async (raw) => {
        this.uploadQueued = false
        const s = this.session
        if (!s || this.status !== 'online' || !this.lease || !this.dirty) return
        const sent = docKey(s.state)
        const res = await raw.progress({ lease: this.lease, baseRev: this.rev, doc: toProgress(s.state) }, { keepalive: true })
        this.contact()
        const before = s.state
        this.apply(res, res.status === 'current' ? 'keep-local' : 'server')
        this.acked = res.status === 'current' ? sent : docKey(s.state)
        this.giftToast(before)
        // Changes made while this upload was out go up next.
        this.scheduleUpload()
      })
      .catch((err: unknown) => {
        this.uploadQueued = false
        this.onFailure(err, 'upload')
      })
      .finally(() => void this.saveLocal())
  }

  /** Upload anything pending now (logout, page hide). */
  async flush(): Promise<void> {
    this.scheduleUpload()
    await this.api.queue.idle()
  }

  /** Apply a server state to the session and adopt its revision. */
  private apply(snapshot: Snapshot, mode: MergeMode): void {
    const s = this.session
    if (!s) return
    const merged = mergeServerState(s.state, snapshot.state, mode)
    this.rev = snapshot.rev
    if (snapshot.importedProfile?.name) this.name = snapshot.importedProfile.name
    s.applyServer(merged, { vitalsSource: snapshot.vitalsSource, importedProfile: snapshot.importedProfile ?? null }, mode === 'server')
  }

  private giftToast(before: GameState): void {
    const s = this.session
    if (!s) return
    const gained = embersGained(before, s.state)
    if (gained > 0) bus.emit(EV.toast, { text: `+${gained} embers — a little warmth from the road.`, icon: 'ember' })
  }

  // ------------------------------------------------------------ spends & sync

  /** Spend through the server. The payoff waits for its answer. */
  async spend(spend: EmberSpend): Promise<RemoteSpendResult> {
    const s = this.session
    if (!s || this.stopped) return 'error'
    if (this.busy) return 'busy'
    if (this.status !== 'online' || !this.lease) return this.status === 'superseded' ? 'superseded' : 'offline'
    const key = newKey()
    const build = (): SpendRequest => ({
      lease: this.lease!,
      baseRev: this.rev,
      kind: spend.kind,
      ...(spend.kind === 'road-lantern' ? { target: spend.id } : {}),
      progress: toProgress(s.state),
      key
    })
    this.setBusy(true)
    try {
      const res = await this.withReload(() => this.api.run((raw) => raw.spend(build())))
      this.contact()
      this.apply(res, 'server')
      this.acked = docKey(s.state)
      void this.saveLocal()
      return null
    } catch (err) {
      const code = errorCode(err)
      if (code === 'short' || code === 'done' || code === 'full' || code === 'needs-earned') return code
      if (code === 'not-at-safe-boundary') return 'unsafe'
      const action = this.onFailure(err, 'spend')
      return action === 'offline' ? 'offline' : action === 'superseded' ? 'superseded' : 'error'
    } finally {
      this.setBusy(false)
    }
  }

  /** Record a profile the browser just fetched from Habitica. */
  async sync(profile: HabiticaProfile): Promise<RemoteSyncResult> {
    const s = this.session
    if (!s || this.stopped) return { ok: false, code: 'unknown' }
    if (this.busy) return { ok: false, code: 'busy' }
    if (this.status !== 'online' || !this.lease) return { ok: false, code: this.status === 'superseded' ? 'superseded' : 'offline' }
    this.setBusy(true)
    try {
      const before = s.state
      const res = await this.withReload(() =>
        this.api.run((raw) => raw.sync({ lease: this.lease!, baseRev: this.rev, progress: toProgress(s.state), profile }))
      )
      this.contact()
      this.apply(res, 'server')
      this.acked = docKey(s.state)
      void this.saveLocal()
      const gained = embersGained(before, s.state)
      const welcome = !before.flags.includes(FLAGS.welcome) && s.state.flags.includes(FLAGS.welcome) ? Math.min(gained, WELCOME_EMBERS) : 0
      return { ok: true, status: res.status, gained, welcome, credit: res.vitalsCredit }
    } catch (err) {
      const code = errorCode(err)
      const action = failureAction(code)
      if (action === 'offline' || action === 'superseded' || action === 'signed-out') this.onFailure(err, 'sync')
      return { ok: false, code: action === 'offline' ? 'offline' : code }
    } finally {
      this.setBusy(false)
    }
  }

  /** stale-revision: re-read state (keeping local progress) and retry once. */
  private async withReload<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt()
    } catch (err) {
      if (errorCode(err) !== 'stale-revision') throw err
      const snap = await this.api.run((raw) => raw.state(this.lease))
      this.apply(snap, 'keep-local')
      return attempt()
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy
    if (this.session) this.session.remoteBusy = busy
    this.emit()
  }

  // ------------------------------------------------------------ lease & reconnect

  /**
   * Acquire the lease and bring the server up to date (design, "Reconnecting
   * after offline play"). Never takes over silently: `takeOver` comes only
   * from the player's button.
   */
  reconnect(takeOver: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.reconnecting) return this.reconnecting
    this.reconnecting = this.doReconnect(takeOver).finally(() => {
      this.reconnecting = null
    })
    return this.reconnecting
  }

  private async doReconnect(takeOver: boolean): Promise<void> {
    const s = this.session
    if (!s) return
    try {
      const play = await this.api.run((raw) => raw.play({ clientId: this.clientId, takeOver }))
      this.contact()
      this.lease = play.lease
      const dirty = this.dirty
      const plan = reconnectPlan(this.rev, play.rev)
      if (dirty) {
        const offlineCopy = s.state
        // Keyed on changes made offline, not on the current status: the first
        // try after reconnecting may have met another device's lease.
        const notice = reconnectNotice(plan, this.offlineProgress)
        const res = await this.api.run((raw) =>
          raw.progress({ lease: this.lease!, baseRev: plan.baseRev, doc: toProgress(s.state) }, { keepalive: true })
        )
        const before = s.state
        this.apply(res, res.status === 'current' ? 'keep-local' : 'server')
        this.acked = docKey(s.state)
        this.giftToast(before)
        if (notice) {
          this.recovery = { state: offlineCopy, savedAt: Date.now() }
          bus.emit(EV.linkNotice, { kind: 'played-elsewhere' })
        }
      } else {
        this.apply(play, play.rev === this.rev ? 'keep-local' : 'server')
        this.acked = docKey(s.state)
      }
      this.offlineProgress = false
      this.setStatus('online')
      this.startHeartbeat()
      // Anything that changed while the reconnect was out goes up next.
      this.scheduleUpload()
    } catch (err) {
      if (errorCode(err) === 'playing-elsewhere') {
        this.setStatus('superseded')
        return
      }
      this.onFailure(err, 'reconnect')
    } finally {
      void this.saveLocal()
    }
  }

  /** The player chose Take over on the "Playing on another device" screen. */
  takeOver(): Promise<void> {
    return this.reconnect(true)
  }

  private startHeartbeat(): void {
    this.stopRetry()
    if (this.heartbeat !== null || this.stopped) return
    this.heartbeat = window.setInterval(() => void this.beat(), HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /** Keep the lease alive while idle, and notice a takeover elsewhere. */
  private async beat(): Promise<void> {
    if (this.status !== 'online' || this.busy || this.api.queue.size > 0) return
    if (Date.now() - this.lastContact < HEARTBEAT_MS - 5_000) return
    try {
      const snap = await this.api.run((raw) => raw.state(this.lease))
      this.contact()
      if (snap.rev === this.rev) return
      // Something else wrote. A GET can't say whose lease is live, so ask for
      // ours back without taking over: another active tab answers
      // playing-elsewhere.
      const play = await this.api.run((raw) => raw.play({ clientId: this.clientId }))
      const sameLease = play.lease === this.lease
      this.lease = play.lease
      this.apply(play, sameLease && !this.dirty ? 'keep-local' : 'server')
      this.acked = docKey(this.session!.state)
      void this.saveLocal()
    } catch (err) {
      if (errorCode(err) === 'playing-elsewhere') this.setStatus('superseded')
      else this.onFailure(err, 'heartbeat')
    }
  }

  private scheduleRetry(): void {
    if (this.retry !== null || this.stopped) return
    this.retry = window.setInterval(() => {
      if (this.status === 'offline') void this.reconnect(false)
    }, RETRY_MS)
  }

  private stopRetry(): void {
    if (this.retry !== null) window.clearInterval(this.retry)
    this.retry = null
  }

  private contact(): void {
    this.lastContact = Date.now()
  }

  /** Decide what a failed call means; returns the action taken. */
  private onFailure(err: unknown, what: string): ReturnType<typeof failureAction> {
    const action = failureAction(errorCode(err))
    if (action === 'offline' || isUnreachable(err)) {
      this.goOffline()
      return 'offline'
    }
    if (action === 'superseded' || action === 'elsewhere') {
      this.setStatus('superseded')
      return 'superseded'
    }
    if (action === 'signed-out') {
      this.setStatus('signed-out')
      return action
    }
    if (action === 'reload' && what === 'upload') {
      // Our baseRev is ahead of the server (a restored backup): merge as stale.
      void this.api
        .run((raw) => raw.state(this.lease))
        .then((snap) => {
          this.rev = reconnectPlan(this.rev, snap.rev).baseRev
          this.scheduleUpload()
        })
        .catch(() => undefined)
      return action
    }
    console.warn('[fingersnap] server refused a', what, errorCode(err))
    if (what === 'upload' && this.session) {
      // Don't retry the same refused document in a loop; the next change tries again.
      this.acked = docKey(this.session.state)
      bus.emit(EV.toast, { text: 'The server didn’t accept that save. Your progress is kept on this device.', kind: 'error' })
    }
    return action
  }

  private goOffline(): void {
    if (this.status === 'offline') return
    if (this.status !== 'online') return
    this.stopHeartbeat()
    this.setStatus('offline')
    void this.saveLocal()
    this.scheduleRetry()
  }

  private setStatus(status: LinkStatus): void {
    if (this.status === status) return
    this.status = status
    if (status !== 'online') this.stopHeartbeat()
    if (status === 'online') this.stopRetry()
    if (status === 'offline') this.scheduleRetry()
    this.emit()
  }

  private emit(): void {
    const payload: LinkPayload = { status: this.status, busy: this.busy, dirty: this.dirty }
    bus.emit(EV.link, payload)
  }

  /** The player dismissed the reconnect notice: the recovery copy goes. */
  dismissRecovery(): void {
    this.recovery = undefined
    void this.saveLocal()
  }

  stop(): void {
    this.stopped = true
    this.stopHeartbeat()
    this.stopRetry()
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
  }
}
