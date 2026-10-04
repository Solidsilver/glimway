/**
 * Link — the connected half of a Session. Owns the play lease, the revision
 * the local copy is based on, and every server write for one signed-in
 * player (design: "Revisions, conflicts, and offline play").
 *
 * - Saves go to the connected cache (src/lib/api/cache.ts) and, while
 *   online, upload as a progress document with `baseRev`. On page hide the
 *   upload starts first, synchronously, so a closing tab still sends it.
 * - Spends and syncs carry the current progress and wait for the server; the
 *   world freezes for the short wait (Session.persistenceInFlight).
 * - Losing the network switches to offline play: saves stay local, spends
 *   and syncs say "Needs a connection", and a reconnect follows the design's
 *   lease-then-upload flow. Server trouble (500s) looks the same to play but
 *   backs off and says so.
 * - A takeover elsewhere ends this tab's lease: status `superseded` until
 *   the player chooses Take over. Unsent story from that window goes to an
 *   orphan slot, which the next lease holder merges (stale write).
 *
 * All calls share the API client's queue, so nothing overlaps. No Phaser
 * here: events go out through the injected `emit`, so this runs in tests.
 */
import type { ApiClient } from '../lib/api/client.ts'
import { newKey } from '../lib/api/client.ts'
import { errorCode, isUnreachable, type ApiErrorCode } from '../lib/api/errors.ts'
import {
  docKey,
  embersGained,
  failureAction,
  isTrouble,
  mergeServerState,
  reconnectNotice,
  reconnectPlan,
  retryDelay,
  spendLanded,
  toProgress,
  uploadLanded,
  type MergeMode
} from '../lib/api/progress.ts'
import { idbLinkStore, type ConnectedCache, type LinkStore } from '../lib/api/cache.ts'
import type { Snapshot, SpendRequest, SyncResponse } from '../lib/api/types.ts'
import type { HabiticaProfile, VitalsSource } from '../lib/habitica/types.ts'
import { FLAGS, WELCOME_EMBERS, type EmberSpend, type SpendReason } from '../lib/embers.ts'
import type { GameState } from '../lib/state.ts'
import { EV, type LinkPayload, type LinkStatus } from './event-names.ts'

const HEARTBEAT_MS = 30_000

export type RemoteSpendResult = null | SpendReason | 'offline' | 'superseded' | 'unsafe' | 'busy' | 'error'

export type RemoteSyncResult =
  | { ok: true; status: SyncResponse['status']; gained: number; welcome: number; credit: { hp: number; mana: number } }
  | { ok: false; code: ApiErrorCode | 'offline' | 'busy' }

/** The part of a Session the link drives (Session implements it). */
export interface LinkSession {
  state: GameState
  vitalsSource: VitalsSource
  importedProfile: HabiticaProfile | null
  remoteBusy: boolean
  applyServer(next: GameState, provenance: { vitalsSource: VitalsSource; importedProfile: HabiticaProfile | null }, relocate: boolean): void
}

export interface LinkInit {
  api: ApiClient
  clientId: string
  habiticaId: string
  name: string
  rev: number
  lease: string | null
  status: 'online' | 'offline'
  /** The cache holds changes the server hasn't seen. */
  dirty?: boolean
  /** Those changes were made while offline (cache flag). */
  offlineProgress?: boolean
  /** The last upload sent before the page went away (cache). */
  sent?: { rev: number; key: string }
  recovery?: ConnectedCache['recovery']
  /** Bus emit (src/game/events.ts); injectable for tests. */
  emit: (event: string, payload?: unknown) => void
  /** Injectable for tests. */
  store?: LinkStore
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
  /** Offline because the server answers 500s, not because the network is gone. */
  trouble = false
  /** A spend or sync is out: the world waits. */
  busy = false
  recovery: ConnectedCache['recovery']
  private session: LinkSession | null = null
  /** docKey of the last state the server accepted ('' = unknown, so dirty). */
  private acked: string
  /** docKey the server refused (400s): not resent until something changes. */
  private refused = ''
  /** The upload in flight (or lost with the page): rev it was based on and its doc. */
  private sent: { rev: number; key: string } | undefined
  /** True once local changes were made while offline (drives the notice). */
  private offlineProgress: boolean
  /** A spend whose answer never came: the reconnect says whether it happened. */
  private lostSpend: EmberSpend | null = null
  private failures = 0
  private uploadQueued = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private lastContact = Date.now()
  private stopped = false
  private reconnecting: Promise<void> | null = null
  private loggedOut = false
  private readonly store: LinkStore
  private readonly emitter: (event: string, payload?: unknown) => void
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
    this.offlineProgress = init.dirty === true && init.offlineProgress === true
    this.sent = init.sent
    this.store = init.store ?? idbLinkStore
    this.emitter = init.emit
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline)
  }

  /** Bind the live session (once, before play starts). */
  attach(session: LinkSession): void {
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

  /**
   * Session.save for connected play: cache always, upload while online.
   * `urgent` (page hide / close): the upload starts before the cache write,
   * because a closing page rarely lives to see IndexedDB finish.
   */
  async persist(opts: { urgent?: boolean } = {}): Promise<void> {
    if (this.stopped || !this.session) return
    if (this.status === 'superseded') {
      // Another tab holds the lease: our unsent story goes to the orphan
      // slot (never over its cache record), for the next holder to merge.
      if (this.dirty) await this.store.saveOrphan({ habiticaId: this.habiticaId, clientId: this.clientId, state: this.session.state, rev: this.rev, savedAt: Date.now() })
      return
    }
    if (this.status === 'offline' && this.dirty) this.offlineProgress = true
    if (opts.urgent) this.scheduleUpload(true)
    await this.saveLocal()
    this.scheduleUpload()
  }

  private async saveLocal(): Promise<void> {
    const s = this.session
    if (!s || this.status === 'superseded') return
    const ok = await this.store.save({
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
      offlineProgress: this.offlineProgress,
      sent: this.sent,
      loggedOut: this.loggedOut || undefined,
      recovery: this.recovery,
      savedAt: Date.now()
    })
    if (!ok && this.status === 'offline') {
      this.emitter(EV.toast, { text: 'This browser wouldn’t save your offline progress. Reconnect soon.', kind: 'error' })
    }
  }

  private scheduleUpload(urgent = false): void {
    if (this.status !== 'online' || !this.lease || !this.dirty) return
    if (this.session && docKey(this.session.state) === this.refused) return
    if (urgent && (this.uploadQueued || this.api.queue.size > 0)) {
      // The queue is busy and the page is going: send now, out of turn. At
      // worst it lands as a stale write, which still keeps its story.
      const s = this.session!
      this.sent = { rev: this.rev, key: docKey(s.state) }
      void this.api.raw.progress({ lease: this.lease, baseRev: this.rev, doc: toProgress(s.state) }, { keepalive: true }).catch(() => undefined)
      return
    }
    if (this.uploadQueued) return
    this.uploadQueued = true
    void this.api
      .run(async (raw) => {
        this.uploadQueued = false
        const s = this.session
        if (!s || this.status !== 'online' || !this.lease || !this.dirty) return
        const key = docKey(s.state)
        if (key === this.refused) return
        this.sent = { rev: this.rev, key }
        const res = await raw.progress({ lease: this.lease, baseRev: this.rev, doc: toProgress(s.state) }, { keepalive: true })
        this.contact()
        this.sent = undefined
        const before = s.state
        this.apply(res, res.status === 'current' ? 'keep-local' : 'server')
        this.acked = res.status === 'current' ? key : docKey(s.state)
        // A current answer's new embers are this upload's quest gifts. After a
        // stale merge they may be another device's sync: no gift toast then.
        if (res.status === 'current') this.giftToast(before)
        // Changes made while this upload was out go up next.
        this.scheduleUpload()
      })
      .catch((err: unknown) => {
        this.uploadQueued = false
        this.onFailure(err, 'upload')
      })
      .finally(() => void this.saveLocal())
  }

  /** Upload anything pending now (logout, tests). */
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
    if (gained > 0) this.emitter(EV.toast, { text: `+${gained} embers — a little warmth from the road.`, icon: 'ember' })
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
      // No answer: it may have gone through. The reconnect will say.
      if (code === 'network') this.lostSpend = spend
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
      // The hero's own progress, untouched: Habitica healing comes only from
      // the server's answer (a hero locked at 0 HP must send hp 0).
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
      const before = s.state
      if (this.dirty && uploadLanded(this.sent, play.rev, play.state)) {
        // Our last upload committed; only its answer was lost. Nobody else
        // played: adopt the revision and send anything newer as current.
        const sentKey = this.sent!.key
        this.apply(play, 'keep-local')
        this.acked = sentKey
      } else if (this.dirty) {
        const plan = reconnectPlan(this.rev, play.rev)
        const offlineCopy = s.state
        // Keyed on changes made offline, not on the current status: the first
        // try after reconnecting may have met another device's lease.
        const notice = reconnectNotice(plan, this.offlineProgress)
        const res = await this.api.run((raw) =>
          raw.progress({ lease: this.lease!, baseRev: plan.baseRev, doc: toProgress(s.state) }, { keepalive: true })
        )
        const pre = s.state
        this.apply(res, res.status === 'current' ? 'keep-local' : 'server')
        this.acked = docKey(s.state)
        if (res.status === 'current') this.giftToast(pre)
        if (notice) {
          this.recovery = { state: offlineCopy, savedAt: Date.now() }
          this.emitter(EV.linkNotice, { kind: 'played-elsewhere' })
        }
      } else {
        this.apply(play, play.rev === this.rev ? 'keep-local' : 'server')
        this.acked = docKey(s.state)
      }
      this.sent = undefined
      this.offlineProgress = false
      this.failures = 0
      this.trouble = false
      this.lostSpendToast(before)
      this.setStatus('online')
      this.startHeartbeat()
      await this.adoptOrphans()
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

  /** A spend whose answer was lost: tell the player whether it happened. */
  private lostSpendToast(before: GameState): void {
    const spend = this.lostSpend
    this.lostSpend = null
    if (!spend || !this.session) return
    if (!spendLanded(spend, before, this.session.state)) return
    const text =
      spend.kind === 'road-lantern' ? 'Your road lantern was lit after all.'
        : spend.kind === 'chest' ? 'The chest opened after all. The Ember Charm is yours.'
          : 'Your rest went through after all. Health and mana restored.'
    this.emitter(EV.toast, { text, icon: spend.kind === 'road-lantern' ? 'lantern' : 'ember' })
  }

  /**
   * Unsent story from tabs that lost the lease: merge each as a stale write
   * (server vitals stay), then drop it. Our own slot is already covered by
   * the upload above, since this tab's state carries on from it.
   */
  private async adoptOrphans(): Promise<void> {
    const orphans = await this.store.loadOrphans(this.habiticaId)
    for (const o of orphans) {
      if (o.clientId !== this.clientId && this.rev > 0 && this.status === 'online') {
        try {
          const res = await this.api.run((raw) =>
            raw.progress({ lease: this.lease!, baseRev: Math.min(o.rev, this.rev - 1), doc: toProgress(o.state) })
          )
          const wasDirty = this.dirty
          this.apply(res, 'keep-local')
          if (!wasDirty) this.acked = docKey(this.session!.state)
        } catch (err) {
          this.onFailure(err, 'orphan')
          return
        }
      }
      await this.store.deleteOrphan(this.habiticaId, o.clientId)
    }
  }

  /** The player chose Take over on the "Playing on another device" screen. */
  takeOver(): Promise<void> {
    return this.reconnect(true)
  }

  private startHeartbeat(): void {
    this.stopRetry()
    if (this.heartbeat !== null || this.stopped) return
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /** Keep the lease alive while idle, and notice a takeover elsewhere. */
  async beat(force = false): Promise<void> {
    if (this.status !== 'online' || this.busy || this.api.queue.size > 0) return
    if (!force && Date.now() - this.lastContact < HEARTBEAT_MS - 5_000) return
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
      if (sameLease) {
        // Still ours (clientIds are unique per page), so nobody else played:
        // the rev moved for bookkeeping (a login settling credit, an owner
        // action). Keep local vitals and position, adopt the rev, and send
        // what we have as a current write.
        this.apply(play, 'keep-local')
        this.scheduleUpload()
      } else {
        // The lease had lapsed to someone else and come back: theirs is newer.
        this.apply(play, 'server')
        this.acked = docKey(this.session!.state)
      }
      void this.saveLocal()
    } catch (err) {
      if (errorCode(err) === 'playing-elsewhere') this.setStatus('superseded')
      else this.onFailure(err, 'heartbeat')
    }
  }

  private scheduleRetry(): void {
    if (this.retry !== null || this.stopped) return
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.status === 'offline') void this.reconnect(false)
    }, retryDelay(this.failures, this.trouble))
  }

  private stopRetry(): void {
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
  }

  private contact(): void {
    this.lastContact = Date.now()
  }

  /** Decide what a failed call means; returns the action taken. */
  private onFailure(err: unknown, what: string): ReturnType<typeof failureAction> {
    const code = errorCode(err)
    const action = failureAction(code)
    if (action === 'offline' || isUnreachable(err)) {
      this.goOffline(isTrouble(code))
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
    console.warn('[fingersnap] server refused a', what, code)
    if (what === 'upload' && this.session) {
      // Don't resend the same refused document in a loop; the next change
      // tries again. It stays dirty: the cache keeps it.
      this.refused = docKey(this.session.state)
      this.emitter(EV.toast, { text: 'The server didn’t accept that save. Your progress is kept on this device.', kind: 'error' })
    }
    return action
  }

  /** Lost the server (network) or it is failing (trouble): play on locally. */
  private goOffline(trouble: boolean): void {
    if (this.status !== 'online' && this.status !== 'offline') return
    this.failures += 1
    const changed = this.status !== 'offline' || this.trouble !== trouble
    this.trouble = trouble
    this.stopHeartbeat()
    this.stopRetry()
    this.status = 'offline'
    if (changed) {
      this.emit()
      void this.saveLocal()
    }
    this.scheduleRetry()
  }

  private setStatus(status: LinkStatus): void {
    if (this.status === status) return
    this.status = status
    if (status !== 'online') this.stopHeartbeat()
    if (status === 'online') this.stopRetry()
    if (status === 'offline') this.scheduleRetry()
    if (status === 'superseded' && this.dirty) void this.persist()
    this.emit()
  }

  private emit(): void {
    const payload: LinkPayload = { status: this.status, busy: this.busy, dirty: this.dirty, trouble: this.trouble }
    this.emitter(EV.link, payload)
  }

  /** The player dismissed the reconnect notice: the recovery copy goes. */
  dismissRecovery(): void {
    this.recovery = undefined
    void this.saveLocal()
  }

  /**
   * Logging out with unsent progress: keep the record for this account's
   * next sign-in, but don't offer it for offline play meanwhile.
   */
  async keepForNextSignIn(): Promise<void> {
    this.loggedOut = true
    await this.saveLocal()
  }

  stop(): void {
    this.stopped = true
    this.stopHeartbeat()
    this.stopRetry()
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
  }
}
