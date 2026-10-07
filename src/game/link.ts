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
import type { ApiClient, Envelope, RawApi } from '../lib/api/client.ts'
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
import type { HomeAction, HomeActionRequest, HomeActionResponse, HomeOp, HomeView, ItemsOp, CommonsResponse, Snapshot, SpendRequest, SyncResponse, Progress, WildsClaimResult, WildsDefeatResult, WildsLanternResult, WildsRegionResponse } from '../lib/api/types.ts'
import type { HabiticaProfile, VitalsSource } from '../lib/habitica/types.ts'
import { FLAGS, WELCOME_EMBERS, type EmberSpend, type SpendReason } from '../lib/embers.ts'
import type { GameState } from '../lib/state.ts'
import { EV, type LinkPayload, type LinkStatus } from './event-names.ts'

const HEARTBEAT_MS = 30_000

export type RemoteSpendResult = null | SpendReason | 'offline' | 'superseded' | 'unsafe' | 'not-home' | 'busy' | 'error'

/** A homestead read: the view, or why there isn't one right now. */
export type HomeRead<T> = { ok: true; value: T } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' }

/** The Commons lane as the game keeps it. */
export type CommonsLaneView = Pick<CommonsResponse, 'gates' | 'gateCount' | 'mine' | 'invites'>

export type HomeActionResult =
  | { ok: true; home: HomeView | null; materials: Record<string, number>; itemId?: string; status?: 'joined' | 'waiting' }
  | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' | 'resolved' }

/**
 * A keyed gameplay POST, described as data so a lost one can be kept (in
 * memory and the connected cache) and replayed exactly.
 */
export type MutationOp =
  | { kind: 'home'; op: HomeOp; fields: Record<string, unknown> }
  | { kind: 'storage'; fields: Record<string, unknown> }
  | { kind: 'craft'; fields: Record<string, unknown> }
  | { kind: 'hearth'; fields: Record<string, unknown> }
  | { kind: 'desk'; fields: Record<string, unknown> }
  | { kind: 'woodpile'; fields: Record<string, unknown> }
  | { kind: 'shelf'; fields: Record<string, unknown> }
  | { kind: 'mail-send'; fields: Record<string, unknown> }
  | { kind: 'mail-claim'; id: string; fields?: Record<string, unknown> }
  | { kind: 'mail-recall'; id: string; fields?: Record<string, unknown> }
  | { kind: 'contribute'; id: string; fields: Record<string, unknown> }
  | { kind: 'items'; op: ItemsOp; fields: Record<string, unknown> }
  | { kind: 'mend'; id: string; fields?: Record<string, unknown> }
  | { kind: 'world-move'; fields: { worldId: string } }
  | { kind: 'world-leave'; fields: Record<string, never> }

/** A mutation sent whose answer never came: the exact body, key and all. */
export interface Unresolved {
  op: MutationOp
  body: Record<string, unknown>
  at: number
}

/**
 * Failures that say nothing about whether a POST committed: no answer, an
 * answer that isn't the Glimway server's (a proxy page), or a 200 whose
 * body couldn't be read or validated.
 */
/** The server answered (2xx), but the body couldn't be read or validated. */
export function answeredUnreadable(err: unknown): boolean {
  const e = err as { code?: string; status?: number }
  return e?.code === 'bad-response' || (e?.code === 'unavailable' && typeof e.status === 'number' && e.status >= 200 && e.status < 300)
}

export function outcomeUnknown(code: string): boolean {
  return code === 'network' || code === 'unavailable' || code === 'bad-response'
}

/**
 * Refusals the server makes before it looks up the idempotency key
 * (server/internal/api/expansion.go keyedMutation: session, decode, lease,
 * then the key): a replay refused like this proves nothing either way.
 * `unknown` (a code this build doesn't know) is treated the same, to be safe.
 */
export function refusedBeforeReplay(code: string): boolean {
  return ['unauthorized', 'access-denied', 'world-required', 'player-flagged', 'account-switch', 'origin-required', 'cross-origin', 'json-required', 'invalid-json', 'key-required', 'superseded', 'playing-elsewhere', 'invalid-client', 'unknown'].includes(code)
}

/** Send one described mutation through the raw API. */
export function dispatchMutation(raw: RawApi, op: MutationOp, body: Record<string, unknown>): Promise<Snapshot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = body as Envelope & any
  switch (op.kind) {
    case 'home':
      return raw.homeAction(op.op, body as unknown as HomeActionRequest)
    case 'storage':
      return raw.storageMove(req)
    case 'craft':
      return raw.craft(req)
    case 'hearth':
      return raw.hearthCraft(req)
    case 'desk':
      return raw.deskCopy(req)
    case 'woodpile':
      return raw.woodpileAction(req)
    case 'shelf':
      return raw.shelfAction(req)
    case 'mail-send':
      return raw.mailSend(req)
    case 'mail-claim':
      return raw.mailClaim(op.id, req)
    case 'mail-recall':
      return raw.mailRecall(op.id, req)
    case 'contribute':
      return raw.contribute(op.id, req)
    case 'items':
      return raw.itemAction(op.op, req)
    case 'mend':
      return raw.repairMend(op.id, req)
    case 'world-move':
      return raw.worldMove(req)
    case 'world-leave':
      return raw.worldLeave(req)
  }
}

export type MutateResult<R> = { ok: true; res: R } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' | 'resolved' }

export type RemoteSyncResult =
  | { ok: true; status: SyncResponse['status']; gained: number; welcome: number; credit: { hp: number; mana: number } }
  | { ok: false; code: ApiErrorCode | 'offline' | 'busy' }

/** Wilds calls: the mapped result, or why not (ApiErrorCode, or no answer). */
export type WildsOutcome<T> = { ok: true; result: T } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' }

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
  /** The account's world, when known (snapshot or cache). */
  worldId?: string
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
  /** A mutation whose answer was lost before the page went away (cache). */
  unresolved?: Unresolved | null
  /** Bus emit (src/game/events.ts); injectable for tests. */
  emit: (event: string, payload?: unknown) => void
  /** Injectable for tests. */
  store?: LinkStore
}

export class Link {
  readonly api: ApiClient
  /** This page's play-client id (changes only via `changeClient`). */
  clientId: string
  readonly habiticaId: string
  /** The account's world ('' until a snapshot or the cache says). */
  worldId: string
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
  /** A keyed mutation whose answer was lost (see `mutate`). */
  private unresolved: Unresolved | null
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
    this.worldId = init.worldId ?? ''
    this.name = init.name
    this.rev = init.rev
    this.lease = init.lease
    this.status = init.status
    this.recovery = init.recovery
    this.acked = init.dirty ? '' : 'pending'
    this.offlineProgress = init.dirty === true && init.offlineProgress === true
    this.sent = init.sent
    this.unresolved = init.unresolved ?? null
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
   * `urgent` (tab hidden, page leaving): the upload starts before the cache
   * write, because a closing page rarely lives to see IndexedDB finish.
   * `leaving` (pagehide only): if the queue is busy, send out of turn rather
   * than wait behind it. A merely hidden tab keeps the queue's order: an
   * out-of-turn write could land second as a stale write, bump the rev, and
   * leave this tab a rev behind (re-review N1).
   */
  async persist(opts: { urgent?: boolean; leaving?: boolean } = {}): Promise<void> {
    if (this.stopped || !this.session) return
    if (this.status === 'superseded') {
      // Another tab holds the lease: our unsent story goes to the orphan
      // slot (never over its cache record), for the next holder to merge.
      if (this.dirty) await this.store.saveOrphan({ habiticaId: this.habiticaId, clientId: this.clientId, state: this.session.state, rev: this.rev, savedAt: Date.now() })
      return
    }
    if (this.status === 'offline' && this.dirty) this.offlineProgress = true
    if (opts.urgent || opts.leaving) this.scheduleUpload(opts.leaving === true)
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
      worldId: this.worldId || undefined,
      recovery: this.recovery,
      unresolved: this.unresolved ?? undefined,
      savedAt: Date.now()
    })
    if (!ok && this.status === 'offline') {
      this.emitter(EV.toast, { text: 'This browser wouldn’t save your offline progress. Reconnect soon.', kind: 'error' })
    }
  }

  private scheduleUpload(outOfTurn = false): void {
    if (this.status !== 'online' || !this.lease || !this.dirty) return
    if (this.session && docKey(this.session.state) === this.refused) return
    if (outOfTurn && (this.uploadQueued || this.api.queue.size > 0)) {
      // The queue is busy and the page is going: send now, out of turn. At
      // worst it lands as a stale write, which still keeps its story.
      const s = this.session!
      const mine = { rev: this.rev, key: docKey(s.state) }
      this.sent = mine
      void this.api.raw
        .progress({ lease: this.lease, baseRev: this.rev, doc: toProgress(s.state) }, { keepalive: true })
        .catch(() => undefined)
        .then(() => this.afterOutOfTurn(mine))
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
        const mine = { rev: this.rev, key }
        this.sent = mine
        const res = await raw.progress({ lease: this.lease, baseRev: this.rev, doc: toProgress(s.state) }, { keepalive: true })
        this.contact()
        // Only clear our own marker; an out-of-turn request may have set its own.
        if (this.sent === mine) this.sent = undefined
        this.refused = ''
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

  /**
   * The page outlived its out-of-turn upload (pagehide into the back-forward
   * cache, say). That request may have bumped the server's rev without this
   * link adopting it, so check in: our own lease with a newer rev is adopted
   * keep-local and re-sent as a current write (see `beat`).
   */
  private async afterOutOfTurn(marker: { rev: number; key: string }): Promise<void> {
    if (this.sent === marker) this.sent = undefined
    if (this.stopped) return
    await this.api.queue.idle()
    await this.beat(true)
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
    if (snapshot.worldId) this.worldId = snapshot.worldId
    const name = snapshot.displayName || snapshot.importedProfile?.name
    if (name) this.name = name
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
      await this.exchange((raw) => raw.spend(build()))
      void this.saveLocal()
      return null
    } catch (err) {
      const code = errorCode(err)
      if (code === 'short' || code === 'done' || code === 'full' || code === 'needs-earned') return code
      if (code === 'not-at-safe-boundary') return 'unsafe'
      if (code === 'not-at-own-plot') return 'not-home'
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
      const res = await this.exchange((raw) => raw.sync({ lease: this.lease!, baseRev: this.rev, progress: toProgress(s.state), profile }))
      void this.saveLocal()
      const gained = embersGained(before, s.state)
      const welcome = !before.flags.includes(FLAGS.welcome) && s.state.flags.includes(FLAGS.welcome) ? Math.min(gained, WELCOME_EMBERS) : 0
      return { ok: true, status: res.status, gained, welcome, credit: res.vitalsCredit }
    } catch (err) {
      return { ok: false, code: this.writeFailure(err, 'sync') }
    } finally {
      this.setBusy(false)
    }
  }

  // ------------------------------------------------------------ homesteads

  /** Read the homestead behind a gate (null: unclaimed land). Reads never move the revision. */
  async readHome(gate: number): Promise<HomeRead<{ gate: number; landSeed: number; home: HomeView | null; materials: Record<string, number> }>> {
    // `materials` are always the caller's own, even when visiting a neighbour.
    return this.read(async () => {
      const r = await this.api.run((raw) => raw.home(gate))
      return { gate: r.gate, landSeed: r.landSeed, home: r.home, materials: r.materials }
    })
  }

  /** The world's Commons lane: gates, holders, invitations. */
  async readCommons(): Promise<HomeRead<CommonsLaneView>> {
    return this.read(async () => {
      const r = await this.api.run((raw) => raw.commons())
      return { gates: r.gates, gateCount: r.gateCount, mine: r.mine, invites: r.invites }
    })
  }

  private async read<T>(get: () => Promise<T>): Promise<HomeRead<T>> {
    if (this.stopped) return { ok: false, code: 'unknown' }
    if (this.status !== 'online') return { ok: false, code: this.status === 'superseded' ? 'superseded' : 'offline' }
    try {
      const value = await get()
      this.contact()
      return { ok: true, value }
    } catch (err) {
      const code = errorCode(err)
      if (isUnreachable(err)) {
        this.onFailure(err, 'home-read')
        return { ok: false, code: 'offline' }
      }
      return { ok: false, code }
    }
  }

  /**
   * A homestead purchase, placement or upgrade. Like a spend: it carries the
   * current progress, the world waits for the answer, and nothing changes
   * locally on a no.
   */
  async homeAction(action: HomeAction): Promise<HomeActionResult> {
    const { op, ...fields } = action
    const r = await this.mutate<HomeActionResponse>({ kind: 'home', op, fields })
    if (!r.ok) return r
    return { ok: true, home: r.res.result.home, materials: r.res.result.materials, itemId: r.res.result.itemId, status: r.res.result.status }
  }

  /**
   * One keyed gameplay POST (homesteads, storage, crafting, mail, projects):
   * the current lease, revision and progress ride along with a fresh
   * idempotency key, the world waits for the answer, and the merged
   * snapshot is adopted on a yes. Nothing changes locally on a no.
   *
   * When the answer is lost (the request may have landed), the exact request
   * is kept as `unresolved` (and in the cache) and the result is `pending`:
   * the outcome is unknown, not "nothing changed". Before any later mutation,
   * and after a reconnect, the same request is replayed with the same key,
   * revision and progress (the server's idempotency hash ignores only the
   * lease): a committed one answers with its original response, one that
   * never landed is refused or runs once. Nothing can be paid for twice.
   */
  async mutate<R extends Snapshot>(op: MutationOp): Promise<MutateResult<R>> {
    const s = this.session
    if (!s || this.stopped) return { ok: false, code: 'unknown' }
    if (this.busy) return { ok: false, code: 'busy' }
    if (this.status !== 'online' || !this.lease) return { ok: false, code: this.status === 'superseded' ? 'superseded' : 'offline' }
    if (this.unresolved) {
      // Settle the earlier request first. If it had landed, stop: the player
      // asked again believing it failed, so say so instead of doing it twice.
      const earlier = await this.resolveUnresolved()
      if (this.unresolved) return { ok: false, code: 'pending' }
      if (earlier === 'landed') return { ok: false, code: 'resolved' }
      const now = this.status as LinkStatus
      if (now !== 'online' || !this.lease) return { ok: false, code: now === 'superseded' ? 'superseded' : 'offline' }
    }
    const key = newKey()
    let sent: Record<string, unknown> | null = null
    const body = (): Record<string, unknown> => (sent = { lease: this.lease!, baseRev: this.rev, key, progress: toProgress(s.state), ...op.fields })
    this.setBusy(true)
    try {
      const res = (await this.exchange((raw) => dispatchMutation(raw, op, body()))) as R
      void this.saveLocal()
      return { ok: true, res }
    } catch (err) {
      const code = errorCode(err)
      if (outcomeUnknown(code) && sent) {
        // No trustworthy answer: it may have committed. Keep the exact request.
        this.unresolved = { op, body: sent, at: Date.now() }
        void this.saveLocal()
        if (answeredUnreadable(err)) {
          // The server did answer, we just couldn't read it: ask again at once
          // with the same request. A committed one hands back its answer.
          const r = await this.replay(false)
          if (r.outcome === 'landed' && r.res) return { ok: true, res: r.res as R }
          if (r.outcome === 'landed') return { ok: false, code: 'resolved' }
          if (r.outcome === 'refused') return { ok: false, code: (r.code ?? 'unknown') as ApiErrorCode }
          return { ok: false, code: 'pending' }
        }
        this.onFailure(err, 'mutation')
        return { ok: false, code: 'pending' }
      }
      return { ok: false, code: this.writeFailure(err, 'mutation') }
    } finally {
      this.setBusy(false)
    }
  }

  /** A mutation whose answer was lost, if any (read-only). */
  get pendingOperation(): Unresolved | null {
    return this.unresolved
  }

  /**
   * Replay the unresolved mutation exactly (only the lease is current) and
   * report what happened: `landed` (now or before; the original response
   * comes back), `refused` (it never committed: nothing changed), or
   * `unknown` (still no answer). Emits EV.mutationResolved for the features.
   */
  async resolveUnresolved(): Promise<'landed' | 'refused' | 'unknown' | 'none'> {
    return (await this.replay(true)).outcome
  }

  /**
   * One exact replay of the unresolved request. `announce` emits
   * EV.mutationResolved (recovery the features hear about); an immediate
   * replay inside `mutate` returns the answer to its caller instead.
   */
  private async replay(announce: boolean): Promise<{ outcome: 'landed' | 'refused' | 'unknown' | 'none'; res?: Snapshot; code?: string }> {
    const u = this.unresolved
    const s = this.session
    if (!u || !s) return { outcome: 'none' }
    if (this.status !== 'online' || !this.lease) return { outcome: 'unknown' }
    try {
      const res = await this.api.run(async (raw) => {
        const r = await dispatchMutation(raw, u.op, { ...u.body, lease: this.lease! })
        this.contact()
        this.unresolved = null
        // A committed request answers with its original response. If the
        // link has moved past it since (the reconnect's own write), that
        // answer is history: adopting it would take the revision, and the
        // state, back one step, and the next action would be refused as stale.
        if (r.rev >= this.rev) {
          this.apply(r, 'server')
          this.acked = docKey(s.state)
        }
        return r
      })
      void this.saveLocal()
      if (announce) this.emitter(EV.mutationResolved, { op: u.op, outcome: 'landed', res })
      return { outcome: 'landed', res }
    } catch (err) {
      const code = errorCode(err)
      if (outcomeUnknown(code) || refusedBeforeReplay(code)) {
        // No trustworthy answer, or refused before the server even looked up
        // the key (signed out, taken over): still unknown. Keep it.
        if (!answeredUnreadable(err) && (isUnreachable(err) || failureAction(code) !== 'refused')) this.onFailure(err, 'resolve')
        return { outcome: 'unknown', code }
      }
      if (code === 'idempotency-mismatch') {
        // The key is already spent on a committed request: it landed, but its
        // answer isn't ours to read. The features re-read what they show.
        this.unresolved = null
        void this.saveLocal()
        if (announce) this.emitter(EV.mutationResolved, { op: u.op, outcome: 'landed' })
        return { outcome: 'landed' }
      }
      // Refused after the key lookup (stale revision, short of funds, already
      // placed…): the original never committed, or its replay would have been
      // served from the idempotency cache.
      this.unresolved = null
      void this.saveLocal()
      if (announce) this.emitter(EV.mutationResolved, { op: u.op, outcome: 'refused', code })
      return { outcome: 'refused', code }
    }
  }

  /** A GET that needs the session (storage, mail, projects). Never moves the revision. */
  readWith<T>(get: (raw: RawApi) => Promise<T>): Promise<HomeRead<T>> {
    return this.read(() => this.api.run(get))
  }

  /** stale-revision: re-read state (keeping local progress) and retry once. */
  /**
   * One keyed request, answered and adopted inside a single queue task. The
   * queue starts its next task as soon as this one settles, before the
   * caller's code after `await` runs; adopting here means the next request
   * (an upload queued meanwhile, say) is built on this answer's revision,
   * never the one before it. A stale-revision refusal re-reads the state
   * (keeping local progress) and tries once more, in the same task.
   *
   * The answer's state is merged (`stateToo`, the default) or only its
   * revision taken (a defeat report: the local recovery owns the save now).
   * The progress sent counts as uploaded; anything that changed locally
   * while the request was out stays unsent, and goes up next on this
   * revision. `sentKey`: the progress was captured before queueing.
   */
  private exchange<T extends Snapshot>(send: (raw: RawApi) => Promise<T>, opts: { stateToo?: boolean; sentKey?: string } = {}): Promise<T> {
    return this.api.run(async (raw) => {
      const s = this.session
      const keyNow = () => opts.sentKey ?? (s ? docKey(s.state) : '')
      let sentKey = keyNow()
      let res: T
      try {
        res = await send(raw)
      } catch (err) {
        if (errorCode(err) !== 'stale-revision') throw err
        const snap = await raw.state(this.lease)
        this.contact()
        this.apply(snap, 'keep-local')
        sentKey = keyNow()
        res = await send(raw)
      }
      this.contact()
      if (!s) return res
      const changedMeanwhile = docKey(s.state) !== sentKey
      if (opts.stateToo === false) {
        this.rev = res.rev
        this.acked = sentKey
      } else {
        this.apply(res, 'server')
        if (!changedMeanwhile) this.acked = docKey(s.state)
      }
      return res
    })
  }

  // ------------------------------------------------------------ the Wilds

  /**
   * Region read (GET — no lease needed, but adopt a newer rev and balances).
   * The world's shared Wilds state: epoch, entities with cycles, personal
   * claims, discoveries, lanterns, material balances.
   */
  async wildsRegion(regionId: string): Promise<WildsRegionResponse> {
    const res = await this.api.run(async (raw) => {
      const r = await raw.wildsRegion(regionId)
      this.contact()
      // keep-local: a read must never move the hero or touch local vitals.
      this.apply(r, 'keep-local')
      return r
    })
    void this.saveLocal()
    return res
  }

  /**
   * Claim a camp/node/chest/POI. The carried progress (area `wilds`,
   * region-wide pixels) rides along, so the server's near-the-entity check
   * sees where this tab is playing. It is captured before the request is
   * queued — a defeat report must describe the fall, not the recovery.
   * Returns the loot and post-grant state.
   */
  async wildsClaim(req: { epoch: string; entityId: string; cycle: number }): Promise<WildsOutcome<WildsClaimResult>> {
    return this.wildsMutation(
      req.epoch,
      (raw, key, progress) =>
        raw.wildsClaim({
          lease: this.lease!,
          baseRev: this.rev,
          epoch: req.epoch,
          entityId: req.entityId,
          cycle: req.cycle,
          key,
          progress
        })
    )
  }

  /**
   * Report a defeat in the Wilds (before recovery): replaces this player's
   * lantern at region tiles (x, y). No vitals come back from it, and the
   * answer's state is not adopted (the local recovery owns vitals now).
   */
  async wildsDefeat(req: { epoch: string; x: number; y: number }): Promise<WildsOutcome<WildsDefeatResult>> {
    return this.wildsMutation(
      req.epoch,
      (raw, key, progress) => raw.wildsDefeat({ lease: this.lease!, baseRev: this.rev, epoch: req.epoch, x: req.x, y: req.y, key, progress }),
      { adoptState: false }
    )
  }

  /** Relight a fallen hero's lantern (the exact instance, by id). */
  async wildsRelight(req: { epoch: string; ownerId: string; lanternId: string }): Promise<WildsOutcome<WildsLanternResult>> {
    return this.wildsMutation(req.epoch, (raw, key, progress) =>
      raw.wildsLantern({
        lease: this.lease!,
        baseRev: this.rev,
        epoch: req.epoch,
        ownerId: req.ownerId,
        lanternId: req.lanternId,
        key,
        progress
      })
    )
  }

  /** Shared body of the three Wilds mutations: busy/lease guards, stale retry, adopt. */
  private async wildsMutation<T>(
    epoch: string,
    call: (raw: RawApi, key: string, progress: Progress) => Promise<Snapshot & { result: T }>,
    opts: { adoptState?: boolean } = {}
  ): Promise<WildsOutcome<T>> {
    const s = this.session
    if (!s || this.stopped) return { ok: false, code: 'unknown' }
    if (this.busy) return { ok: false, code: 'busy' }
    if (this.status !== 'online' || !this.lease) return { ok: false, code: this.status === 'superseded' ? 'superseded' : 'offline' }
    if (!epoch) return { ok: false, code: 'epoch-not-found' }
    // Captured now: the request must describe the moment it was made.
    const progress = toProgress(s.state)
    const sentKey = docKey(s.state)
    // One key per logical write: a stale-revision retry is the same write.
    const key = newKey()
    this.setBusy(true)
    try {
      const res = await this.exchange((raw) => call(raw, key, progress), { stateToo: opts.adoptState !== false, sentKey })
      void this.saveLocal()
      return { ok: true, result: res.result }
    } catch (err) {
      return { ok: false, code: this.writeFailure(err, 'wilds') }
    } finally {
      this.setBusy(false)
    }
  }

  /**
   * A keyed write's refusal: losing the server, the lease (here or to another
   * tab) or the sign-in moves the link's status; anything else is the
   * write's own answer. Returns the code its caller reports.
   */
  private writeFailure(err: unknown, what: string): ApiErrorCode | 'offline' {
    const code = errorCode(err)
    const fa = failureAction(code)
    if (!isUnreachable(err) && fa !== 'offline' && fa !== 'superseded' && fa !== 'elsewhere' && fa !== 'signed-out') return code
    const action = this.onFailure(err, what)
    return action === 'superseded' ? 'superseded' : action === 'offline' ? 'offline' : code
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
        // Send and adopt in one queue task, like `exchange`: anything changed
        // while the upload was out stays unacked and goes up next.
        const { res, pre } = await this.api.run(async (raw) => {
          const sentKey = docKey(s.state)
          const r = await raw.progress({ lease: this.lease!, baseRev: plan.baseRev, doc: toProgress(s.state) }, { keepalive: true })
          const changedMeanwhile = docKey(s.state) !== sentKey
          const pre = s.state
          this.apply(r, r.status === 'current' ? 'keep-local' : 'server')
          this.acked = changedMeanwhile ? sentKey : docKey(s.state)
          return { res: r, pre }
        })
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
      // A mutation whose answer was lost: replay it exactly, now we can.
      if (this.unresolved) await this.resolveUnresolved()
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
          await this.api.run(async (raw) => {
            const res = await raw.progress({ lease: this.lease!, baseRev: Math.min(o.rev, this.rev - 1), doc: toProgress(o.state) })
            const wasDirty = this.dirty
            this.apply(res, 'keep-local')
            if (!wasDirty) this.acked = docKey(this.session!.state)
          })
        } catch (err) {
          this.onFailure(err, 'orphan')
          return
        }
      }
      await this.store.deleteOrphan(this.habiticaId, o.clientId)
    }
  }

  /**
   * This page turned out to share its client id with another live page (it
   * was frozen when the other claimed it) and took a fresh one. The old lease
   * belongs to that other page now: drop it and reconnect as a new client,
   * which meets the normal playing-elsewhere / take-over flow.
   */
  changeClient(id: string): Promise<void> {
    if (this.stopped || id === this.clientId) return Promise.resolve()
    this.clientId = id
    this.lease = null
    this.stopHeartbeat()
    void this.saveLocal()
    return this.reconnect(false)
  }

  get active(): boolean {
    return !this.stopped
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

  /**
   * Keep the lease alive while idle, and notice a takeover elsewhere: the GET
   * says whether the lease we sent is still the player's (`leaseActive`).
   */
  async beat(force = false): Promise<void> {
    if (this.status !== 'online' || this.busy || this.api.queue.size > 0) return
    if (!force && Date.now() - this.lastContact < HEARTBEAT_MS - 5_000) return
    try {
      // Adopted inside the queue task, so a request queued meanwhile is built on it.
      const moved = await this.api.run(async (raw) => {
        const snap = await raw.state(this.lease)
        this.contact()
        if (snap.leaseActive === false) return 'superseded' as const
        if (snap.rev === this.rev) return false
        // Still our lease, so nobody else played: the rev moved for bookkeeping
        // (a login settling credit, an owner action). Keep local vitals and
        // position, adopt the rev, and send what we have as a current write.
        this.apply(snap, 'keep-local')
        return true
      })
      if (moved === 'superseded') {
        // Another tab or device took over. Taking it back is the player's call.
        this.setStatus('superseded')
        return
      }
      if (!moved) return
      this.scheduleUpload()
      void this.saveLocal()
    } catch (err) {
      this.onFailure(err, 'heartbeat')
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
    console.warn('[glimway] server refused a', what, code)
    if (what === 'upload' && this.session) {
      // Don't resend the same refused document in a loop; the next change
      // tries again. It stays dirty: the cache keeps it.
      const firstRefusal = this.refused === ''
      this.refused = docKey(this.session.state)
      // Once per run of refusals: further changes may be refused too.
      if (firstRefusal) this.emitter(EV.toast, { text: 'The server didn’t accept that save. Your progress is kept on this device.', kind: 'error' })
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
