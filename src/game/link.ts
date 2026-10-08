/**
 * Link — the connected half of a Session (design server-first 2.4). The
 * client holds `server`, the newest `PlayerState` it adopted, and the
 * outbox, its unanswered operations in order. The game shows `server` with
 * the outbox's predictions applied (src/lib/api/predict.ts).
 *
 * - **Operations** are written to the outbox (src/lib/api/outbox.ts) with
 *   their exact request bytes before they are sent, then sent one at a time,
 *   head of line. A replay sends the same key and payload; only the lease
 *   and the report barrier are filled in again.
 * - **Answers** adopt their state only at an equal or higher version. A
 *   validated game refusal drops its operation and its prediction, adopts
 *   the refusal's state and says what didn't happen. Anything ambiguous
 *   (no answer, a 5xx, a 429, `not-implemented`, an unreadable body) keeps
 *   the head and retries with backoff. Predictor failure alone never drops
 *   an operation.
 * - **Offline**, the operations the client can predict (quest steps,
 *   marks, placed papers, falls) queue; anything the server decides says
 *   "Needs a connection". Lease loss, sign-out and `reload-needed` stop the
 *   sender and keep everything; Take over is always the player's choice.
 * - **Reports** (src/lib/api/reports.ts) carry place, vitals and casts about
 *   every 10 seconds, on an area change and on page hide. A vitals-dependent
 *   operation first flushes one and carries its acknowledgment as a barrier.
 * - **Vitals overlay.** Local damage, mana and casts not yet reported live
 *   above the adopted state: an unrelated answer never heals them. A report's
 *   acknowledgment adopts the clamped vitals, keeping what happened since it
 *   was captured; a server vitals write (rest, fall, refill) starts over.
 *
 * One tab per device sends for an account, holding the outbox's Web Lock.
 * No Phaser here: events go out through the injected `emit`, so this runs
 * in tests.
 */
import { create, equals, fromJson, toJson, type DescMessage, type JsonValue } from '@bufbuild/protobuf'
import contract from '../../content/contract.json' with { type: 'json' }
import type { ApiClient, Envelope, RawApi } from '../lib/api/client.ts'
import { newKey } from '../lib/api/client.ts'
import { ApiError, errorCode, isOutboxClientBug, isReloadNeeded, isSettledRefusal, isUnreachable, needsReconciliation, type ApiErrorCode } from '../lib/api/errors.ts'
import type { OperationsApi } from '../lib/api/operations.ts'
import { browserLocks, emptyRecord, expired, holdLock, lockName, outboxStore, type HeldLock, type LockLike, type OutboxEntry, type OutboxKind, type OutboxRecord, type OutboxStore } from '../lib/api/outbox.ts'
import { adoptable, gameStateOf, isClientMark, predictedView, profileOf, QUEST_STEP, whereOf, type Prediction } from '../lib/api/predict.ts'
import { REPORT_INTERVAL_MS, ReportBook, type CapturedReport, type ReportAck } from '../lib/api/reports.ts'
import { LANTERN_ROAD } from '../lib/api/ports.ts'
import type { HomeAction, HomeActionResponse, HomeOp, HomeView, ItemsOp, CommonsResponse, Snapshot, WildsClaimResult, WildsDefeatResult, WildsLanternResult, WildsRegionResponse } from '../lib/api/types.ts'
import { PlayerStateSchema, PlayRequestSchema, type PlayerState } from '../lib/gen/glimway/v1/state_pb.js'
import { FallRequestSchema, MarkRequestSchema, ProfileReportSchema, QuestStepRequestSchema, ReportRequestSchema, SettleEchoRequestSchema, SpendRequestSchema, TakePaperRequestSchema, WildsClaimRequestSchema, WildsLanternRequestSchema, type ProfileResult } from '../lib/gen/glimway/v1/operations_pb.js'
import { HabiticaUserSchema } from '../lib/gen/glimway/v1/profile_pb.js'
import { rawUserFor } from '../lib/habitica/client.ts'
import type { HabiticaProfile, VitalsSource } from '../lib/habitica/types.ts'
import { FLAGS, WELCOME_EMBERS, type EmberSpend, type SpendReason } from '../lib/embers.ts'
import type { GameState, QuestEvent } from '../lib/state.ts'
import { EV, type Emit, type LinkPayload, type LinkStatus } from './event-names.ts'

const HEARTBEAT_MS = 30_000
/** After this long without an answer the chip says "Reaching the world…". */
const REACHING_MS = 60_000
/** A barrier asks for a fresh report at most this many times before backing off. */
const BARRIER_TRIES = 3

export type RemoteSpendResult = null | SpendReason | 'offline' | 'superseded' | 'unsafe' | 'not-home' | 'busy' | 'error'

/** A homestead read: the view, or why there isn't one right now. */
export type HomeRead<T> = { ok: true; value: T } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' }

/** The Commons lane as the game keeps it. */
export type CommonsLaneView = Pick<CommonsResponse, 'gates' | 'gateCount' | 'mine' | 'invites'>

export type HomeActionResult =
  | { ok: true; home: HomeView | null; materials: Record<string, number>; itemId?: string; status?: 'joined' | 'waiting' }
  | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' | 'resolved' }

/** A keyed domain POST, described as data so the outbox can replay it. */
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
  | { kind: 'donate'; fields: { paperId: string } }

/** A domain route without its payload (what an outbox entry keeps to dispatch a replay). */
type MutationRoute = { kind: MutationOp['kind']; op?: string; id?: string }

const routeOf = (op: MutationOp): MutationRoute => ({ kind: op.kind, ...('op' in op ? { op: op.op } : {}), ...('id' in op ? { id: op.id } : {}) })

const ROUTE_PATHS: Record<MutationOp['kind'], (r: MutationRoute) => string> = {
  home: (r) => `/api/homestead/${r.op}`,
  storage: () => '/api/storage',
  craft: () => '/api/craft',
  hearth: () => '/api/hearth/craft',
  desk: () => '/api/desk/copy',
  woodpile: () => '/api/homestead/woodpile',
  shelf: () => '/api/homestead/shelf',
  'mail-send': () => '/api/mail',
  'mail-claim': (r) => `/api/mail/${encodeURIComponent(r.id ?? '')}/claim`,
  'mail-recall': (r) => `/api/mail/${encodeURIComponent(r.id ?? '')}/recall`,
  contribute: (r) => `/api/projects/${encodeURIComponent(r.id ?? '')}/contribute`,
  items: (r) => `/api/items/${r.op}`,
  mend: (r) => `/api/repairs/${encodeURIComponent(r.id ?? '')}/mend`,
  'world-move': () => '/api/world/move',
  'world-leave': () => '/api/world/leave',
  donate: () => '/api/library/donate'
}

/** The route a stored domain entry was made for, read back from its path. */
function routeFromPath(path: string): MutationRoute | null {
  const m = (re: RegExp) => re.exec(path)
  let x: RegExpExecArray | null
  if ((x = m(/^\/api\/homestead\/(buy|place|move|remove|upgrade|claim|clear|invite|joint|leave)$/))) return { kind: 'home', op: x[1] }
  if ((x = m(/^\/api\/items\/([a-z-]+)$/))) return { kind: 'items', op: x[1] }
  if ((x = m(/^\/api\/mail\/([^/]+)\/(claim|recall)$/))) return { kind: x[2] === 'claim' ? 'mail-claim' : 'mail-recall', id: decodeURIComponent(x[1]!) }
  if ((x = m(/^\/api\/projects\/([^/]+)\/contribute$/))) return { kind: 'contribute', id: decodeURIComponent(x[1]!) }
  if ((x = m(/^\/api\/repairs\/([^/]+)\/mend$/))) return { kind: 'mend', id: decodeURIComponent(x[1]!) }
  const fixed: Record<string, MutationOp['kind']> = { '/api/storage': 'storage', '/api/craft': 'craft', '/api/hearth/craft': 'hearth', '/api/desk/copy': 'desk', '/api/homestead/woodpile': 'woodpile', '/api/homestead/shelf': 'shelf', '/api/mail': 'mail-send', '/api/world/move': 'world-move', '/api/world/leave': 'world-leave', '/api/library/donate': 'donate' }
  return fixed[path] ? { kind: fixed[path] } : null
}

/** Send one described domain mutation through the raw API. */
export function dispatchMutation(raw: RawApi, route: MutationRoute, body: Record<string, unknown>): Promise<Snapshot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = body as Envelope & any
  switch (route.kind) {
    case 'home':
      return raw.homeAction(route.op as HomeOp, req)
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
      return raw.mailClaim(route.id ?? '', req)
    case 'mail-recall':
      return raw.mailRecall(route.id ?? '', req)
    case 'contribute':
      return raw.contribute(route.id ?? '', req)
    case 'items':
      return raw.itemAction(route.op as ItemsOp, req)
    case 'mend':
      return raw.repairMend(route.id ?? '', req)
    case 'world-move':
      return raw.worldMove(req)
    case 'world-leave':
      return raw.worldLeave(req)
    case 'donate':
      return raw.libraryDonate(req)
  }
}

export type MutateResult<R> = { ok: true; res: R } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' | 'resolved' }

export type RemoteSyncResult =
  | { ok: true; status: ProfileResult['status']; gained: number; welcome: number; credit: { hp: number; mana: number } }
  | { ok: false; code: ApiErrorCode | 'offline' | 'busy' }

/** Wilds calls: the mapped result, or why not (ApiErrorCode, or no answer). */
export type WildsOutcome<T> = { ok: true; result: T } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' }

/** The part of a Session the link drives (Session implements it). */
export interface LinkSession {
  /** The game's state: the link's view plus the live place, vitals and play time. */
  state: GameState
  vitalsSource: VitalsSource
  importedProfile: HabiticaProfile | null
  remoteBusy: boolean
  /**
   * Show a new view. Live place and vitals stay unless `relocate` (the
   * server or a fall moved the hero) or `vitals` (the overlay moved).
   */
  applyServer(next: GameState, provenance: { vitalsSource: VitalsSource; importedProfile: HabiticaProfile | null }, opts: { relocate?: boolean; vitals?: { hp: number; mana: number }; quiet?: boolean }): void
}

export interface LinkInit {
  api: ApiClient
  clientId: string
  accountId: string
  /** This device (`claimDeviceId`): the outbox is keyed by account and device. */
  device: string
  name: string
  worldId?: string
  /** The newest state known: the server's answer, or the outbox's copy offline. */
  state: PlayerState
  /** The account's outbox on this device (`openOutbox`). */
  record?: OutboxRecord | null
  status: 'online' | 'offline'
  /** Bus emit (src/game/events.ts); injectable for tests. */
  emit: Emit
  /** Injectable for tests. */
  store?: OutboxStore
  /** Web Locks (null: none, every tab sends for itself). */
  locks?: LockLike | null
  /** Tells other tabs the outbox changed (null: none). */
  channel?: ChannelLike | null
  now?: () => number
}

interface ChannelLike {
  postMessage(message: unknown): void
  onmessage: ((ev: { data: unknown }) => void) | null
  close(): void
}

/** How an operation the caller waits for came out. */
type Outcome =
  | { ok: true; state: PlayerState | null; result: unknown }
  | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' | 'resolved' }

/** Typed operations: their request schema and facade call. */
const TYPED: Partial<Record<OutboxKind, { schema: DescMessage; path: string; send: (ops: OperationsApi, req: never) => Promise<import('../lib/gen/glimway/v1/state_pb.js').Envelope> }>> = {
  'quest-step': { schema: QuestStepRequestSchema, path: '/api/quest/step', send: (ops, req) => ops.questStep(req) },
  mark: { schema: MarkRequestSchema, path: '/api/story/mark', send: (ops, req) => ops.mark(req) },
  'take-paper': { schema: TakePaperRequestSchema, path: '/api/papers/take', send: (ops, req) => ops.takePaper(req) },
  'settle-echo': { schema: SettleEchoRequestSchema, path: '/api/wilds/echo', send: (ops, req) => ops.settleEcho(req) },
  fall: { schema: FallRequestSchema, path: '/api/fall', send: (ops, req) => ops.fall(req) },
  spend: { schema: SpendRequestSchema, path: '/api/spend', send: (ops, req) => ops.spend(req) },
  'wilds-claim': { schema: WildsClaimRequestSchema, path: '/api/wilds/claim', send: (ops, req) => ops.wildsClaim(req) },
  'wilds-lantern': { schema: WildsLanternRequestSchema, path: '/api/wilds/lantern', send: (ops, req) => ops.wildsLantern(req) }
}

/** What the game should say when an operation it predicted didn't happen. */
const UNDONE: Partial<Record<OutboxKind, string>> = {
  'quest-step': 'That story step didn’t take: the world had moved on. Nothing was lost.',
  mark: 'The world didn’t keep one thing you noticed. Nothing else changed.',
  'take-paper': 'That paper wasn’t there for you after all. It’s back where it was.',
  'settle-echo': 'That Echo wasn’t yours to settle just now.',
  fall: 'Your last fall wasn’t recorded.'
}

/** The outbox for an account on this device, or a fresh one. */
export { outboxStore }

export async function openOutbox(store: OutboxStore, account: string, device: string): Promise<OutboxRecord> {
  return (await store.load(account, device)) ?? emptyRecord(account, device)
}

const stateJson = (s: PlayerState): JsonValue => toJson(PlayerStateSchema, s, { alwaysEmitImplicit: true })

/** The predictable part of a stored entry (2.4: the game shows `server` with these applied). */
function predictionOf(entry: OutboxEntry): Prediction {
  try {
    const b = JSON.parse(entry.body) as Record<string, unknown>
    switch (entry.kind) {
      case 'quest-step':
        return { kind: 'quest-step', quest: String(b.quest), to: String(b.to) }
      case 'mark':
        return { kind: 'mark', mark: String(b.mark) }
      case 'take-paper':
        return { kind: 'take-paper', paper: String(b.paper) }
      case 'settle-echo':
        return { kind: 'settle-echo', member: String(b.member) }
      case 'fall':
        return { kind: 'fall' }
      default:
        return { kind: 'none' }
    }
  } catch {
    return { kind: 'none' }
  }
}

export class Link {
  readonly api: ApiClient
  readonly ops: OperationsApi
  /** This page's play-client id (changes only via `changeClient`). */
  clientId: string
  readonly accountId: string
  readonly device: string
  /** The account's world ('' until a state says). */
  worldId: string
  name: string
  lease: string | null
  status: LinkStatus
  /** Answers keep failing on the server's side (5xx, 429, unfinished routes), not the network. */
  trouble = false
  /** An operation the game waits for is out: the world holds still. */
  busy = false
  /** Sending stopped until a reload (`reload-needed`) or a fix (`client-bug`). */
  paused: null | 'reload' | 'client-bug' = null
  /** The newest state adopted. */
  server: PlayerState
  readonly reports: ReportBook
  private entries: OutboxEntry[]
  private nextId: number
  private session: LinkSession | null = null
  private readonly store: OutboxStore
  private readonly emitter: Emit
  private readonly now: () => number
  private readonly locks: LockLike | null
  private readonly channel: ChannelLike | null
  private lock: HeldLock | null = null
  /** Callers waiting for their entry's answer. */
  private readonly waiters = new Map<number, (o: Outcome) => void>()
  /** The predicted recovery each unanswered fall showed (the overlay's point for its answer). */
  private readonly fallPoints = new Map<number, { hp: number; mana: number }>()
  private pumping: Promise<void> | null = null
  private reportWanted = false
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  /** When the head (or a report) first went unanswered ('' = answered). */
  private unansweredSince: number | null = null
  private lastContact: number
  private stopped = false
  private sealed = false
  private settleRun = 0
  private loggedOut = false
  private reconnecting: Promise<void> | null = null
  /** A version whose two copies differed: reconciled once. */
  private reconciled = -1
  private readonly onOnline = () => {
    if (this.status === 'offline') void this.reconnect(false)
  }

  constructor(init: LinkInit) {
    this.api = init.api
    this.ops = init.api.operations
    this.clientId = init.clientId
    this.accountId = init.accountId
    this.device = init.device
    this.name = init.name
    this.worldId = init.worldId ?? init.state.account?.worldId ?? ''
    this.status = init.status
    this.store = init.store ?? outboxStore()
    this.emitter = init.emit
    this.now = init.now ?? Date.now
    this.locks = init.locks === undefined ? browserLocks() : init.locks
    this.channel = init.channel === undefined ? defaultChannel() : init.channel
    this.lastContact = this.now()
    const record = init.record && init.record.account === init.accountId && init.record.device === init.device ? init.record : emptyRecord(init.accountId, init.device)
    const stored = record.server ? safeState(record.server) : null
    this.server = stored && stored.version > init.state.version ? stored : init.state
    this.entries = [...record.entries]
    this.nextId = record.nextId
    // The same tab's lease resumes after a reload; another tab's never does.
    this.lease = record.client === init.clientId ? record.lease : null
    this.reports = new ReportBook(record.reports)
    if (!record.reports) this.reports.reset(this.server.vitals?.vitalsSetVersion ?? 0)
    if (this.channel) this.channel.onmessage = (ev) => this.onChannel(ev.data)
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline)
  }

  /**
   * The game's starting state: the view, with the place and vitals the last
   * page reported or meant to report (a reload never heals or moves the hero).
   */
  initialState(): GameState {
    const view = this.view()
    const n = this.reports.next
    if (n.place && n.basis >= (this.server.vitals?.vitalsSetVersion ?? 0)) {
      const live = gameStateOf(create(PlayerStateSchema, { ...this.server, place: { ...this.server.place!, area: n.place.area, x: n.place.x, y: n.place.y } }))
      return { ...view, area: live.area, position: live.position, ...(live.wildsRegion ? { wildsRegion: live.wildsRegion } : {}), hp: Math.min(n.hp, view.maxHp), mana: Math.min(n.mana, view.maxMana) }
    }
    return view
  }

  /** Bind the live session (once, before play starts). */
  attach(session: LinkSession): void {
    this.session = session
    this.noteLive()
    this.startReports()
    if (this.status === 'online') {
      this.startHeartbeat()
      void this.own(false).then(() => this.pump())
    } else this.scheduleRetry()
    void this.expire()
    this.emit()
  }

  get online(): boolean {
    return this.status === 'online'
  }

  /** The outbox holds something the server hasn't answered (what a logout asks about). */
  get dirty(): boolean {
    return this.entries.length > 0
  }

  /** Nothing is waiting to be written. */
  get settled(): boolean {
    return this.status === 'online' && !this.paused && this.entries.length === 0 && !this.reports.captured && !this.busy
  }

  /** Unanswered operations, oldest first (read-only). */
  get outbox(): readonly OutboxEntry[] {
    return this.entries
  }

  /** The head was sent and its answer is still unknown (a lost mutation). */
  get pendingOperation(): OutboxEntry | null {
    const head = this.entries[0]
    return head && head.sent && !head.offline ? head : null
  }

  /** The state version this tab holds. */
  get rev(): number {
    return this.server.version
  }

  get active(): boolean {
    return !this.stopped
  }

  /** "Reaching the world…": an answer has been missing for over a minute. */
  get reaching(): boolean {
    return this.unansweredSince !== null && this.now() - this.unansweredSince >= REACHING_MS
  }

  // ------------------------------------------------------------ the view

  private view(): GameState {
    return predictedView(this.server, this.entries.map(predictionOf), { profile: profileOf(this.server) })
  }

  /** Show the view. `relocate`: the server (or a fall) moved the hero; `vitals`: the overlay moved. */
  private refresh(opts: { relocate?: boolean; vitals?: { hp: number; mana: number }; quiet?: boolean } = {}): void {
    const s = this.session
    if (!s) return
    const profile = profileOf(this.server)
    s.applyServer(this.view(), { vitalsSource: profile ? 'imported' : 'demo', importedProfile: profile }, opts)
  }

  /** The screen's place and vitals, into the next report. */
  private noteLive(): void {
    const s = this.session
    if (!s) return
    this.reports.note(whereOf(s.state), Math.max(0, s.state.hp), Math.max(0, s.state.mana))
  }

  /**
   * Adopt a state at an equal or higher version, and move the vitals overlay:
   * a server vitals write starts over from it (keeping what happened after a
   * predicted fall), a report's acknowledgment keeps what happened since its
   * capture, anything else leaves live vitals alone.
   */
  private adopt(next: PlayerState | null | undefined, ctx: { captured?: CapturedReport | null; ack?: ReportAck; fall?: number; read?: boolean } = {}): boolean {
    if (!next) return false
    const prev = this.server
    if (!adoptable(prev, next)) return false
    if (next.version === prev.version && !ctx.read && !equals(PlayerStateSchema, next, prev)) {
      // Two answers at one version disagree: neither is trusted until a read says.
      if (this.reconciled !== next.version) {
        this.reconciled = next.version
        void this.reconcile()
      }
      return false
    }
    this.server = next
    if (next.account?.worldId) this.worldId = next.account.worldId
    if (next.account?.displayName) this.name = next.account.displayName
    const s = this.session
    const v = next.vitals!
    const before = prev.vitals!
    let vitals: { hp: number; mana: number } | undefined
    if (s && v.vitalsSetVersion > before.vitalsSetVersion) {
      const point = ctx.fall !== undefined ? this.fallPoints.get(ctx.fall) : undefined
      const live = { hp: s.state.hp, mana: s.state.mana }
      vitals = point ? { hp: v.hp + (live.hp - point.hp), mana: v.mana + (live.mana - point.mana) } : { hp: v.hp, mana: v.mana }
      if (ctx.fall !== undefined) this.reports.release(ctx.fall, v.vitalsSetVersion)
      else this.reports.reset(v.vitalsSetVersion)
    } else if (s && ctx.captured && ctx.ack?.accepted && !ctx.ack.staleBasis) {
      const c = ctx.captured
      vitals = { hp: v.hp + (s.state.hp - c.hp), mana: v.mana + (s.state.mana - c.mana) }
    }
    if (vitals) vitals = { hp: clamp(vitals.hp, v.maxHp), mana: clamp(vitals.mana, v.maxMana) }
    if (ctx.fall !== undefined) this.fallPoints.delete(ctx.fall)
    // A fall's answer never moves the hero: its walk home was shown when it happened.
    this.refresh({ vitals })
    return true
  }

  /** Read the server's state and adopt it (an uncertain answer, a sent head given up). */
  private async reconcile(): Promise<void> {
    try {
      const res = await this.api.run(() => this.ops.state(this.lease ?? undefined))
      this.contact()
      if (res.state) this.adoptRead(res.state)
    } catch {
      /* the next answer says */
    }
  }

  /** A read's state wins over a disagreeing copy at the same version. */
  private adoptRead(state: PlayerState): void {
    this.adopt(state, { read: true })
  }

  // ------------------------------------------------------------ persistence

  /**
   * Session.save: the next report takes the screen's place and vitals and
   * the outbox record is written. `leaving` (page hide): a report goes out
   * now with keepalive, out of turn, so a closing tab still sends it.
   */
  async persist(opts: { urgent?: boolean; leaving?: boolean } = {}): Promise<void> {
    if (this.stopped || !this.session) return
    this.noteLive()
    if ((opts.urgent || opts.leaving) && this.canSend()) this.sendReportNow(opts.leaving === true)
    await this.saveRecord()
  }

  private record(): OutboxRecord {
    return {
      account: this.accountId,
      device: this.device,
      nextId: this.nextId,
      entries: this.entries,
      server: stateJson(this.server),
      reports: this.reports.stored(),
      client: this.clientId,
      lease: this.lease,
      name: this.name,
      worldId: this.worldId,
      loggedOut: this.loggedOut,
      savedAt: this.now()
    }
  }

  /** Write the record (only the sender writes it). False when it didn't land. */
  private async saveRecord(): Promise<boolean> {
    if (this.status === 'superseded') return false
    const ok = await this.store.save(this.record())
    if (ok) this.channel?.postMessage({ type: 'outbox', account: this.accountId, device: this.device })
    return ok
  }

  /** Another tab wrote the outbox: a passive tab picks it up, so its view is current when it takes over. */
  private onChannel(data: unknown): void {
    const m = data as { type?: string; account?: string; device?: string } | null
    if (!m || m.type !== 'outbox' || m.account !== this.accountId || m.device !== this.device || this.status !== 'superseded') return
    void this.reloadRecord()
  }

  private async reloadRecord(): Promise<void> {
    const r = await this.store.load(this.accountId, this.device)
    if (!r) return
    // The store's entries, plus ours it hasn't seen yet (newer than its allocator).
    // Ours that it knew of and no longer holds were answered by the other tab.
    const stored = new Set(r.entries.map((e) => e.id))
    this.entries = [...r.entries, ...this.entries.filter((e) => !stored.has(e.id) && e.id >= r.nextId)].sort((a, b) => a.id - b.id)
    this.nextId = Math.max(this.nextId, r.nextId)
    const state = r.server ? safeState(r.server) : null
    if (state) this.adoptRead(state)
    else this.refresh()
  }

  /** Before a reload for a new version: send everything, then report whether it all landed. 'saved' seals the link. */
  async settle(): Promise<'saved' | 'offline' | 'unsaved'> {
    const run = ++this.settleRun
    await this.persist()
    this.reportWanted = true
    for (let i = 0; i < 50; i++) {
      this.pump()
      if (this.pumping) await this.pumping
      if (this.reconnecting) await this.reconnecting.catch(() => undefined)
      await new Promise((r) => setTimeout(r, 10))
      if (run !== this.settleRun) return 'unsaved'
      if (!this.pumping && (!this.canSend() || (!this.entries.length && !this.reports.captured))) break
    }
    await this.saveRecord()
    if (!this.settled) return this.status === 'offline' ? 'offline' : 'unsaved'
    this.sealed = true
    return 'saved'
  }

  /** The reload was called off: operations may start again. */
  cancelSettle(): void {
    this.settleRun += 1
    this.sealed = false
  }

  /** Send everything pending now (logout, a library donation). */
  async flush(): Promise<void> {
    this.noteLive()
    this.reportWanted = true
    this.pump()
    while (this.pumping) await this.pumping
  }

  // ------------------------------------------------------------ the outbox

  /**
   * Add an operation. `offline` operations are predicted and kept without a
   * connection; the rest need one and their caller waits for the answer.
   * Persist first: an entry that can't be written is never sent offline.
   */
  private async submit(kind: OutboxKind, path: string, key: string, body: Record<string, unknown>, opts: { offline: boolean; barrier?: boolean }): Promise<Outcome> {
    if (this.stopped || !this.session) return { ok: false, code: 'unknown' }
    if (this.status === 'superseded' || this.status === 'signed-out') return { ok: false, code: this.status === 'superseded' ? 'superseded' : 'unauthorized' }
    if (!opts.offline) {
      if (this.busy || this.sealed) return { ok: false, code: 'busy' }
      if (this.paused === 'reload') return { ok: false, code: 'reload-needed' }
      if (!this.canSend()) return { ok: false, code: 'offline' }
    } else if (this.sealed) return { ok: false, code: 'busy' }
    const entry: OutboxEntry = { id: this.nextId++, kind, path, key, body: JSON.stringify(body), contract: contract.number, createdAt: this.now(), sent: false, barrier: opts.barrier === true, offline: opts.offline }
    this.entries.push(entry)
    const saved = await this.saveRecord()
    if (!saved && opts.offline && !this.canSend()) {
      // No durable outbox (a private window): offline play is off.
      this.entries = this.entries.filter((e) => e !== entry)
      this.refresh()
      this.emitter(EV.toast, { text: 'Needs a connection. This browser won’t keep offline changes.', kind: 'error' })
      return { ok: false, code: 'offline' }
    }
    if (opts.offline) {
      this.pump()
      return { ok: true, state: null, result: null }
    }
    this.setBusy(true)
    try {
      const done = new Promise<Outcome>((r) => this.waiters.set(entry.id, r))
      this.pump()
      return await done
    } finally {
      this.setBusy(false)
    }
  }

  private canSend(): boolean {
    return !this.stopped && !!this.lock && this.status === 'online' && !!this.lease && !this.paused
  }

  private pump(): void {
    if (this.pumping || !this.canSend()) return
    this.pumping = this.drain().finally(() => {
      this.pumping = null
      // More arrived while draining; a pending retry waits for its timer instead.
      if (this.retry === null && this.canSend() && (this.entries.length > 0 || (this.reportWanted && this.reports.due))) this.pump()
    })
  }

  /** Head of line: one operation at a time, in order; a report when the outbox is idle. */
  private async drain(): Promise<void> {
    while (this.canSend()) {
      await this.expire()
      const head = this.entries[0]
      if (!head) {
        if (!this.reportWanted && !this.reports.captured) return
        this.noteLive()
        if (!(await this.sendReport(false))) return
        this.reportWanted = false
        return
      }
      if (!(await this.sendHead(head))) return
    }
  }

  /** Send the head. False: stop draining (paused, offline, waiting to retry). */
  private async sendHead(head: OutboxEntry): Promise<boolean> {
    let barrier: { client: string; generation: string; seq: number } | null = null
    if (head.barrier) {
      barrier = await this.flushBarrier()
      if (!barrier) return false
    }
    if (!head.sent) {
      head.sent = true
      await this.saveRecord()
    }
    const body = JSON.parse(head.body) as Record<string, unknown>
    body.op = { ...(body.op as object), lease: this.lease, ...(barrier ? { report: barrier } : {}) }
    try {
      let state: PlayerState | null
      let result: unknown
      if (head.kind === 'mutation') {
        const route = routeFromPath(head.path)
        if (!route) throw new Error('unknown route')
        const res = await this.api.run((raw) => dispatchMutation(raw, route, body))
        state = res.player ?? null
        result = res
      } else {
        const typed = TYPED[head.kind]!
        const env = await this.api.run(() => typed.send(this.ops, fromJson(typed.schema, body as JsonValue, { ignoreUnknownFields: false }) as never))
        state = env.state ?? null
        result = env.result
      }
      this.answered()
      this.entries = this.entries.filter((e) => e !== head)
      if (state) this.adopt(state, head.kind === 'fall' ? { fall: head.id } : {})
      else {
        // An answer without a typed state (a domain route not yet on the new envelope): read it.
        this.fallPoints.delete(head.id)
        this.refresh()
        await this.reconcile()
      }
      if (head.kind === 'fall' && !state) this.reports.release(head.id, this.server.vitals?.vitalsSetVersion ?? 0)
      await this.saveRecord()
      // A step's gift (paid once, by the server): the toast follows its answer.
      const gift = head.kind === 'quest-step' && (result as { case?: string; value?: { embers?: number } })?.case === 'questStep' ? (result as { value: { embers: number } }).value.embers : 0
      if (gift > 0) this.emitter(EV.toast, { text: `+${gift} embers — a little warmth from the road.`, icon: 'ember' })
      this.settle_(head, { ok: true, state, result })
      return true
    } catch (err) {
      return this.headFailed(head, err)
    }
  }

  /** The head wasn't answered with success. */
  private async headFailed(head: OutboxEntry, err: unknown): Promise<boolean> {
    const code = errorCode(err)
    if (isReloadNeeded(err)) {
      this.pause('reload')
      return false
    }
    if (isOutboxClientBug(err) || (err instanceof Error && !('code' in err))) {
      // A request the server can't even decode is a bug here: never retried in a loop.
      console.warn('[glimway] the server could not read a queued', head.kind, code)
      this.pause('client-bug')
      this.emitter(EV.toast, { text: 'Something this device queued couldn’t be read by the world. It’s kept here; reload to try again.', kind: 'error' })
      return false
    }
    if (code === 'superseded' || code === 'playing-elsewhere') {
      this.leaseLost()
      return false
    }
    if (code === 'unauthorized') {
      this.setStatus('signed-out')
      this.abandonUnsent()
      return false
    }
    if (needsReconciliation(err)) {
      // The key already committed a payload: it happened, in some form. Read what the world holds.
      this.answered()
      this.adopt((err as { state?: PlayerState }).state)
      await this.reconcile()
      this.drop(head)
      this.settle_(head, { ok: false, code: 'resolved' })
      return true
    }
    if (isSettledRefusal(err)) {
      this.answered()
      this.drop(head)
      // A step that didn't happen takes the steps after it along (an explicit dependency).
      const dependents = head.kind === 'quest-step' ? this.entries.filter((e) => e.kind === 'quest-step' && predictionQuest(e) === predictionQuest(head)) : []
      for (const d of dependents) this.drop(d)
      this.adopt(err.state)
      this.refresh()
      await this.saveRecord()
      console.warn('[glimway] the world refused a', head.kind, code)
      const undone = UNDONE[head.kind]
      if (undone && !this.waiters.has(head.id)) this.emitter(EV.toast, { text: undone, kind: 'error' })
      this.settle_(head, { ok: false, code })
      for (const d of dependents) this.settle_(d, { ok: false, code })
      return true
    }
    // Ambiguous: it may have committed. Keep it, retry with the same key and bytes.
    if (err instanceof Error && 'state' in err) this.adopt((err as { state?: PlayerState }).state)
    this.unanswered()
    if (head.offline === false) this.settle_(head, { ok: false, code: 'pending' })
    this.abandonUnsent()
    this.backoff(err)
    return false
  }

  /** Remove an entry from the outbox (and its prediction). */
  private drop(entry: OutboxEntry): void {
    this.entries = this.entries.filter((e) => e !== entry)
    if (entry.kind === 'fall') {
      this.fallPoints.delete(entry.id)
      this.reports.release(entry.id, this.server.vitals?.vitalsSetVersion ?? 0)
    }
  }

  /**
   * Operations that need a connection and were never sent go when the
   * connection does: nothing the server decides happens hours later.
   * Their callers hear `offline`.
   */
  private abandonUnsent(): void {
    const gone = this.entries.filter((e) => !e.offline && !e.sent)
    if (!gone.length) return
    for (const e of gone) this.drop(e)
    for (const e of gone) this.settle_(e, { ok: false, code: 'offline' })
    void this.saveRecord()
  }

  /** Tell a waiting caller (once), or the features about a replay nobody waited for. */
  private settle_(entry: OutboxEntry, outcome: Outcome): void {
    const waiter = this.waiters.get(entry.id)
    if (waiter) {
      this.waiters.delete(entry.id)
      waiter(outcome)
      return
    }
    if (entry.kind !== 'mutation' || (outcome.ok === false && outcome.code === 'pending')) return
    const route = routeFromPath(entry.path)
    if (!route) return
    const op = { ...route, fields: {} } as MutationOp
    if (outcome.ok) this.emitter(EV.mutationResolved, { op, outcome: 'landed', res: outcome.result })
    else this.emitter(EV.mutationResolved, { op, outcome: outcome.code === 'resolved' ? 'landed' : 'refused', code: outcome.code })
  }

  /**
   * Drop entries past their lifetime or made under another contract (2.4).
   * One that may have been sent is reconciled first: the state read says
   * what the world holds before its prediction goes.
   */
  private async expire(): Promise<void> {
    // One that may have been sent waits until a state read can say what landed.
    const old = expired(this.entries, this.now(), contract.number).filter((e) => !e.sent || this.canSend())
    if (!old.length) return
    if (old.some((e) => e.sent)) await this.reconcile()
    for (const e of old) this.drop(e)
    for (const e of old) this.settle_(e, { ok: false, code: 'offline' })
    this.refresh()
    await this.saveRecord()
    this.emitter(EV.toast, { text: 'Something you did offline more than six days ago wasn’t kept.', kind: 'error' })
  }

  private pause(why: 'reload' | 'client-bug'): void {
    this.paused = why
    this.stopTimers()
    this.emit()
  }

  // ------------------------------------------------------------ reports

  private startReports(): void {
    if (this.reportTimer !== null || this.stopped) return
    this.reportTimer = setInterval(() => {
      this.noteLive()
      this.reportWanted = true
      this.pump()
    }, REPORT_INTERVAL_MS)
  }

  /** The hero changed area: report it soon (after whatever is in flight). */
  reportSoon(): void {
    this.noteLive()
    this.reportWanted = true
    this.pump()
  }

  /** A signature cast happened on screen (counted against the server's cast budget). */
  noteCast(n = 1): void {
    this.reports.cast(n)
  }

  /** Send a report. False: stop draining. */
  private async sendReport(force: boolean): Promise<boolean> {
    const c = this.reports.capture(force)
    if (!c) return true
    await this.saveRecord()
    try {
      const env = await this.api.run(() => this.ops.report(this.reportRequest(c)))
      this.answered()
      const ack = env.result.case === 'report' ? (env.result.value as ReportAck) : null
      const retired = ack ? this.reports.ack(ack) : null
      this.adopt(env.state, { captured: retired, ack: ack ?? undefined })
      await this.saveRecord()
      return true
    } catch (err) {
      const code = errorCode(err)
      if (isReloadNeeded(err)) this.pause('reload')
      else if (code === 'superseded' || code === 'playing-elsewhere') {
        // A retired generation: its captured report never moves to a new one.
        this.reports.drop()
        this.leaseLost()
      } else if (code === 'unauthorized') this.setStatus('signed-out')
      else if (isOutboxClientBug(err)) {
        // Its values can't be read: drop it rather than send it forever.
        this.reports.drop()
        this.pause('client-bug')
      } else {
        this.unanswered()
        this.backoff(err)
      }
      return false
    }
  }

  private reportRequest(c: CapturedReport) {
    return create(ReportRequestSchema, { lease: this.lease ?? '', client: c.client, generation: c.generation, seq: c.seq, basis: c.basis, place: c.place, hp: c.hp, mana: c.mana, casts: c.casts })
  }

  /** Page hide: the report goes now with keepalive, unqueued. */
  private sendReportNow(leaving: boolean): void {
    const c = this.reports.capture(false)
    if (!c || !leaving) {
      this.reportWanted = true
      this.pump()
      return
    }
    void this.ops.report(this.reportRequest(c), { keepalive: true }).then(
      (env) => {
        const ack = env.result.case === 'report' ? (env.result.value as ReportAck) : null
        const retired = ack ? this.reports.ack(ack) : null
        this.adopt(env.state, { captured: retired, ack: ack ?? undefined })
      },
      () => undefined
    )
  }

  /**
   * The report barrier (2.2): freeze and flush a report and wait for its
   * acknowledgment, so a rest or a consumable reads the vitals on screen.
   * Null when it can't be had now (the link then waits or retries).
   */
  private async flushBarrier(): Promise<{ client: string; generation: string; seq: number } | null> {
    for (let i = 0; i < BARRIER_TRIES; i++) {
      this.noteLive()
      const c = this.reports.capture(true)
      if (!c) break
      if (!(await this.sendReport(true))) return null
      if (!this.reports.captured && this.reports.barrier()?.seq === c.seq) return this.reports.barrier()
    }
    // No fresh acknowledgment to be had (a stale basis each time): try again later.
    this.backoff(new ApiError('report-required'))
    return null
  }

  // ------------------------------------------------------------ operations

  /** A quest step (predicted; queues offline). */
  questStep(event: QuestEvent): void {
    const s = this.session
    if (!s) return
    const key = newKey()
    const body = toJson(QuestStepRequestSchema, create(QuestStepRequestSchema, { op: { lease: '', key }, quest: LANTERN_ROAD, to: QUEST_STEP[event], where: whereOf(s.state) }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    void this.submit('quest-step', TYPED['quest-step']!.path, key, body, { offline: true })
    this.refresh()
  }

  /** A client-namespace mark (seen:, met:, found:, defeated:…; predicted; queues offline). */
  mark(mark: string): void {
    const s = this.session
    if (!s || !isClientMark(mark)) return
    const key = newKey()
    const body = toJson(MarkRequestSchema, create(MarkRequestSchema, { op: { lease: '', key }, mark, where: whereOf(s.state) }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    void this.submit('mark', TYPED.mark!.path, key, body, { offline: true })
    this.refresh()
  }

  /**
   * Take a paper (predicted). Placed and handed-over papers queue offline; a
   * site paper (`epoch`, `site`) needs the server.
   */
  takePaper(paper: string, site?: { epoch: string; site: string }): void {
    const s = this.session
    if (!s) return
    const key = newKey()
    const body = toJson(TakePaperRequestSchema, create(TakePaperRequestSchema, { op: { lease: '', key }, paper, where: whereOf(s.state), epoch: site?.epoch ?? '', site: site?.site ?? '' }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    void this.submit('take-paper', TYPED['take-paper']!.path, key, body, { offline: true })
    this.refresh()
  }

  /**
   * The hero fell where they stand now: the recovery and the walk home are
   * predicted at once, and the fall queues (offline too). Combat captured
   * before it is void; the next report waits for its answer.
   */
  fall(): { hp: number; mana: number } | null {
    const s = this.session
    if (!s) return null
    const key = newKey()
    const where = whereOf(s.state)
    const body = toJson(FallRequestSchema, create(FallRequestSchema, { op: { lease: '', key }, where }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    const id = this.nextId
    void this.submit('fall', TYPED.fall!.path, key, body, { offline: true })
    // Refused before it was queued (another tab plays): nothing to predict.
    if (!this.entries.some((e) => e.id === id)) return null
    this.reports.fall(id)
    const view = this.view()
    const point = { hp: view.hp, mana: view.mana }
    this.fallPoints.set(id, point)
    this.refresh({ relocate: true, vitals: point, quiet: true })
    this.noteLive()
    return point
  }

  /** Settle an Echo (the server checks this player's assignment). */
  async settleEcho(req: { epoch: string; site: string; member: string }): Promise<WildsOutcome<{ paper: string }>> {
    const s = this.session
    if (!s) return { ok: false, code: 'unknown' }
    const key = newKey()
    const body = toJson(SettleEchoRequestSchema, create(SettleEchoRequestSchema, { op: { lease: '', key }, epoch: req.epoch, site: req.site, member: req.member, where: whereOf(s.state) }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    const r = await this.submit('settle-echo', TYPED['settle-echo']!.path, key, body, { offline: false })
    if (!r.ok) return { ok: false, code: r.code === 'resolved' ? 'unknown' : r.code }
    const res = r.result as { case?: string; value?: { paper?: string } }
    return { ok: true, result: { paper: res?.case === 'settleEcho' ? res.value?.paper ?? '' : '' } }
  }

  /** Spend through the server. The payoff waits for its answer; rests carry a report barrier. */
  async spend(spend: EmberSpend): Promise<RemoteSpendResult> {
    const s = this.session
    if (!s || this.stopped) return 'error'
    const key = newKey()
    const body = toJson(SpendRequestSchema, create(SpendRequestSchema, { op: { lease: '', key }, kind: spend.kind, where: whereOf(s.state), target: spend.kind === 'road-lantern' ? spend.id : '' }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    const r = await this.submit('spend', TYPED.spend!.path, key, body, { offline: false, barrier: spend.kind === 'rest' || spend.kind === 'home-rest' })
    if (r.ok) return null
    const code = r.code
    if (code === 'short' || code === 'done' || code === 'full' || code === 'needs-earned') return code
    if (code === 'not-at-safe-boundary') return 'unsafe'
    if (code === 'not-at-own-plot') return 'not-home'
    if (code === 'offline' || code === 'superseded' || code === 'busy') return code
    if (code === 'pending') return 'offline'
    return 'error'
  }

  /**
   * Record the Habitica `/user` projection the browser just fetched. The
   * server maps it (design 2.2, `profile`); a report barrier goes first so
   * credit is measured against the vitals on screen. Not keyed: credit is
   * against the XP mark.
   */
  async profile(rawUser: unknown): Promise<RemoteSyncResult> {
    const s = this.session
    if (!s || this.stopped) return { ok: false, code: 'unknown' }
    if (this.busy || this.sealed) return { ok: false, code: 'busy' }
    if (!this.canSend()) return { ok: false, code: 'offline' }
    let raw
    try {
      raw = fromJson(HabiticaUserSchema, rawUser as JsonValue, { ignoreUnknownFields: true })
    } catch {
      return { ok: false, code: 'bad-response' }
    }
    this.setBusy(true)
    try {
      // After everything queued before it: one answer at a time.
      while (this.pumping) await this.pumping
      if (this.entries.length) {
        this.pump()
        while (this.pumping) await this.pumping
        if (this.entries.length) return { ok: false, code: 'offline' }
      }
      const barrier = await this.flushBarrier()
      if (!barrier) return { ok: false, code: 'offline' }
      const before = s.state
      const env = await this.api.run(() => this.ops.profile(create(ProfileReportSchema, { lease: this.lease ?? '', raw, report: barrier })))
      this.answered()
      this.adopt(env.state)
      void this.saveRecord()
      const res = env.result.case === 'profile' ? env.result.value : null
      const gained = Math.max(0, res?.credit ?? 0)
      const welcome = !before.flags.includes(FLAGS.welcome) && s.state.flags.includes(FLAGS.welcome) ? Math.min(gained, WELCOME_EMBERS) : 0
      return { ok: true, status: res?.status === 'unchanged' ? 'unchanged' : 'synced', gained, welcome, credit: { hp: res?.vitalsCredit?.hp ?? 0, mana: res?.vitalsCredit?.mana ?? 0 } }
    } catch (err) {
      const code = errorCode(err)
      if (err instanceof Error && 'state' in err) this.adopt((err as { state?: PlayerState }).state)
      if (isReloadNeeded(err)) this.pause('reload')
      else if (code === 'superseded' || code === 'playing-elsewhere') this.leaseLost()
      else if (code === 'unauthorized') this.setStatus('signed-out')
      else if (isUnreachable(err)) {
        this.backoff(err)
        return { ok: false, code: 'offline' }
      }
      return { ok: false, code }
    } finally {
      this.setBusy(false)
    }
  }

  /** The profile the browser mapped, posted as its raw projection (until callers pass the raw one). */
  async sync(profile: HabiticaProfile): Promise<RemoteSyncResult> {
    const raw = rawUserFor(profile)
    if (!raw) return { ok: false, code: 'bad-response' }
    return this.profile(raw)
  }

  // ------------------------------------------------------------ homesteads and domains

  /** Read the homestead behind a gate (null: unclaimed land). Reads never move the version. */
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
      const player = (value as { player?: PlayerState } | null)?.player
      if (player) this.adopt(player)
      return { ok: true, value }
    } catch (err) {
      const code = errorCode(err)
      if (isUnreachable(err)) {
        this.backoff(err)
        return { ok: false, code: 'offline' }
      }
      return { ok: false, code }
    }
  }

  /** A GET that needs the session (storage, mail, projects). */
  readWith<T>(get: (raw: RawApi) => Promise<T>): Promise<HomeRead<T>> {
    return this.read(() => this.api.run(get))
  }

  /** A homestead purchase, placement or upgrade. The world waits for the answer. */
  async homeAction(action: HomeAction): Promise<HomeActionResult> {
    const { op, ...fields } = action
    const r = await this.mutate<HomeActionResponse>({ kind: 'home', op, fields })
    if (!r.ok) return r
    return { ok: true, home: r.res.result.home, materials: r.res.result.materials, itemId: r.res.result.itemId, status: r.res.result.status }
  }

  /**
   * One keyed domain POST (homesteads, storage, crafting, mail, projects,
   * items, repairs, worlds): its fields plus `op` and the hero's `where`,
   * written to the outbox and sent; the world waits for the answer. When the
   * answer is lost the outbox keeps it and replays it with the same key
   * (`pending`); a refusal changes nothing. Consumables carry a report
   * barrier, since they read the stored vitals.
   */
  async mutate<R extends Snapshot>(op: MutationOp): Promise<MutateResult<R>> {
    const s = this.session
    if (!s || this.stopped) return { ok: false, code: 'unknown' }
    if (this.pendingOperation) {
      // An earlier answer is still unknown: settle it first.
      this.pump()
      while (this.pumping) await this.pumping
      if (this.pendingOperation) return { ok: false, code: 'pending' }
    }
    const key = newKey()
    const fields = { ...(op.fields ?? {}) }
    // The domain's own `op` field moves aside for the operation header.
    if (op.kind === 'shelf' && 'op' in fields) {
      fields.action = fields.op
      delete fields.op
    }
    const body: Record<string, unknown> = { ...fields, op: { lease: '', key }, where: whereOf(s.state) }
    const route = routeOf(op)
    const r = await this.submit('mutation', ROUTE_PATHS[op.kind](route), key, body, { offline: false, barrier: op.kind === 'items' && op.op === 'use' })
    if (!r.ok) return { ok: false, code: r.code }
    return { ok: true, res: r.result as R }
  }

  /** Settle the unknown head now: `landed`, `refused`, `unknown` or `none`. */
  async resolveUnresolved(): Promise<'landed' | 'refused' | 'unknown' | 'none'> {
    const head = this.pendingOperation
    if (!head) return 'none'
    const done = new Promise<Outcome>((r) => this.waiters.set(head.id, r))
    this.pump()
    while (this.pumping) await this.pumping
    if (this.entries.includes(head)) {
      this.waiters.delete(head.id)
      return 'unknown'
    }
    const o = await done
    return o.ok || o.code === 'resolved' ? 'landed' : 'refused'
  }

  // ------------------------------------------------------------ the Wilds

  /** Region read (a GET: no lease). Adopts a newer state, never moves the hero. */
  async wildsRegion(regionId: string): Promise<WildsRegionResponse> {
    const res = await this.api.run((raw) => raw.wildsRegion(regionId))
    this.contact()
    if (res.player) this.adopt(res.player)
    return res
  }

  /** Claim a camp/node/chest/POI from where the hero stands. */
  async wildsClaim(req: { epoch: string; entityId: string; cycle: number }): Promise<WildsOutcome<WildsClaimResult>> {
    const s = this.session
    if (!s) return { ok: false, code: 'unknown' }
    if (!req.epoch) return { ok: false, code: 'epoch-not-found' }
    const key = newKey()
    const body = toJson(WildsClaimRequestSchema, create(WildsClaimRequestSchema, { op: { lease: '', key }, epoch: req.epoch, entityId: req.entityId, cycle: req.cycle, where: whereOf(s.state) }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    const r = await this.submit('wilds-claim', TYPED['wilds-claim']!.path, key, body, { offline: false })
    if (!r.ok) return { ok: false, code: r.code === 'resolved' ? 'unknown' : r.code }
    const res = r.result as { case?: string; value?: import('../lib/gen/glimway/v1/operations_pb.js').WildsClaimResult }
    if (res?.case !== 'wildsClaim' || !res.value) return { ok: false, code: 'bad-response' }
    return { ok: true, result: claimResult(res.value) }
  }

  /** Relight a fallen hero's lantern (the exact instance, by id). */
  async wildsRelight(req: { epoch: string; ownerId: string; lanternId: string }): Promise<WildsOutcome<WildsLanternResult>> {
    const s = this.session
    if (!s) return { ok: false, code: 'unknown' }
    if (!req.epoch) return { ok: false, code: 'epoch-not-found' }
    const key = newKey()
    const body = toJson(WildsLanternRequestSchema, create(WildsLanternRequestSchema, { op: { lease: '', key }, epoch: req.epoch, ownerId: req.ownerId, lanternId: req.lanternId, where: whereOf(s.state) }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    const r = await this.submit('wilds-lantern', TYPED['wilds-lantern']!.path, key, body, { offline: false })
    if (!r.ok) return { ok: false, code: r.code === 'resolved' ? 'unknown' : r.code }
    const res = r.result as { case?: string; value?: import('../lib/gen/glimway/v1/operations_pb.js').WildsLanternResult }
    if (res?.case !== 'wildsLantern' || !res.value) return { ok: false, code: 'bad-response' }
    return { ok: true, result: lanternResult(res.value) }
  }

  /**
   * Retired: a fall now places the fallen-hero lantern (`fall`).
   * TODO(D): remove `reportDefeat` in src/game/wilds/entities.ts with this.
   */
  async wildsDefeat(_req: { epoch: string; x: number; y: number }): Promise<WildsOutcome<WildsDefeatResult>> {
    return { ok: false, code: 'not-implemented' }
  }

  // ------------------------------------------------------------ lease, ownership, reconnect

  /**
   * Hold the outbox lock for this device. `steal` only on the player's Take
   * over. Without it this tab is passive: another tab here is playing.
   */
  private async own(steal: boolean): Promise<boolean> {
    if (this.lock) return true
    const lock = await holdLock(this.locks, lockName(this.accountId, this.device), steal)
    if (!lock) return false
    if (this.stopped) {
      lock.release()
      return false
    }
    this.lock = lock
    void lock.lost.then(() => {
      if (this.lock !== lock) return
      // Another tab took the outbox: this one stops sending and keeps nothing it can't write.
      this.lock = null
      if (!this.stopped) this.leaseLost()
    })
    // The previous owner may have written entries meanwhile.
    await this.reloadRecord()
    return true
  }

  /**
   * Acquire the lease and send what waits (design 2.4). Never takes over
   * silently: `takeOver` comes only from the player's button.
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
    if (!this.session) return
    if (!(await this.own(takeOver))) {
      this.setStatus('superseded')
      return
    }
    try {
      const play = await this.api.run(() => this.ops.play(create(PlayRequestSchema, { clientId: this.clientId, takeOver })))
      this.contact()
      this.lease = play.lease
      const v = play.state?.vitals
      this.reports.bind(play.reportClient, play.reportGeneration, v?.reportSeq ?? 0, v?.reportGeneration ?? '')
      if (play.state) this.adoptRead(play.state)
      this.failures = 0
      this.trouble = false
      this.answered()
      this.setStatus('online')
      this.startHeartbeat()
      await this.saveRecord()
      // A report captured before a reload goes again at once; the rest keep their timer.
      if (this.reports.captured) this.reportWanted = true
      this.pump()
    } catch (err) {
      const code = errorCode(err)
      if (code === 'playing-elsewhere') {
        this.setStatus('superseded')
        return
      }
      if (isReloadNeeded(err)) {
        this.pause('reload')
        return
      }
      if (code === 'unauthorized') {
        this.setStatus('signed-out')
        return
      }
      this.backoff(err)
    }
  }

  /**
   * This page turned out to share its client id with another live page and
   * took a fresh one. The old lease is that page's now: reconnect as a new
   * client, which meets the normal playing-elsewhere / take-over flow.
   */
  changeClient(id: string): Promise<void> {
    if (this.stopped || id === this.clientId) return Promise.resolve()
    this.clientId = id
    this.lease = null
    this.stopHeartbeat()
    return this.reconnect(false)
  }

  /** The player chose Take over on the "Playing on another device" screen. */
  takeOver(): Promise<void> {
    return this.reconnect(true)
  }

  /** Superseded: stop sending and keep everything. Callers of unsent work hear it. */
  private leaseLost(): void {
    for (const [id, waiter] of [...this.waiters]) {
      const e = this.entries.find((x) => x.id === id)
      if (e && !e.sent) this.entries = this.entries.filter((x) => x !== e)
      this.waiters.delete(id)
      waiter({ ok: false, code: 'superseded' })
    }
    this.setStatus('superseded')
    if (this.lock) {
      this.lock.release()
      this.lock = null
    }
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
   * Keep the lease alive while idle and notice a takeover elsewhere: the GET
   * says whether our lease is still the player's (`leaseActive`).
   */
  async beat(force = false): Promise<void> {
    if (this.status !== 'online' || this.busy || this.pumping || this.api.queue.size > 0) return
    if (!force && this.now() - this.lastContact < HEARTBEAT_MS - 5_000) return
    try {
      const res = await this.api.run(() => this.ops.state(this.lease ?? undefined))
      this.contact()
      if (!res.leaseActive) {
        this.leaseLost()
        return
      }
      if (res.state) this.adoptRead(res.state)
    } catch (err) {
      if (errorCode(err) === 'unauthorized') this.setStatus('signed-out')
      else if (isReloadNeeded(err)) this.pause('reload')
      else this.backoff(err)
    }
  }

  /** An answer came: the "Reaching the world…" clock stops. */
  private answered(): void {
    this.contact()
    this.failures = 0
    if (this.unansweredSince !== null || this.trouble) {
      this.unansweredSince = null
      this.trouble = false
      this.emit()
    }
  }

  private unanswered(): void {
    this.unansweredSince ??= this.now()
  }

  /**
   * Keep what waits and try again later. No answer at all takes the link
   * offline (play goes on locally); an answer that settles nothing (5xx,
   * 429, an unfinished route) is "trouble" and keeps the status.
   */
  private backoff(err: unknown): void {
    this.failures += 1
    const offline = isUnreachable(err)
    const status = (err as { status?: number } | null)?.status
    this.trouble = !offline || (status !== undefined && status >= 500)
    if (offline && this.status === 'online') {
      this.stopHeartbeat()
      this.status = 'offline'
    }
    this.emit()
    void this.saveRecord()
    this.scheduleRetry((err as { retryAfterMs?: number } | null)?.retryAfterMs)
  }

  private scheduleRetry(after?: number): void {
    if (this.retry !== null || this.stopped) return
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.status === 'offline') void this.reconnect(false)
      else this.pump()
    }, after ?? retryDelay(this.failures, this.trouble))
  }

  private stopRetry(): void {
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
  }

  private stopTimers(): void {
    this.stopHeartbeat()
    this.stopRetry()
  }

  private contact(): void {
    this.lastContact = this.now()
  }

  private setBusy(busy: boolean): void {
    this.busy = busy
    if (this.session) this.session.remoteBusy = busy
    this.emit()
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
    const payload: LinkPayload = { status: this.status, busy: this.busy, dirty: this.dirty, trouble: this.trouble, reaching: this.reaching, paused: this.paused }
    this.emitter(EV.link, payload)
  }

  /** Kept for the reconnect notice, which no longer has a recovery copy to drop. */
  dismissRecovery(): void {}

  /**
   * Logging out with unsent work the player chose to keep: it stays on this
   * device for this account's next sign-in, and isn't offered meanwhile.
   */
  async keepForNextSignIn(): Promise<void> {
    this.loggedOut = true
    await this.store.save(this.record())
  }

  /**
   * Logging out and dropping the unsent work. A head that may have been sent
   * is reconciled first, so nothing is claimed lost that actually landed.
   */
  async dropUnsent(): Promise<void> {
    if (this.entries.some((e) => e.sent) && this.canSend()) await this.reconcile()
    for (const e of [...this.entries]) this.drop(e)
    this.refresh()
    await this.store.clear(this.accountId, this.device)
  }

  stop(): void {
    this.stopped = true
    this.stopTimers()
    if (this.reportTimer !== null) clearInterval(this.reportTimer)
    this.reportTimer = null
    for (const [, waiter] of this.waiters) waiter({ ok: false, code: 'unknown' })
    this.waiters.clear()
    this.lock?.release()
    this.lock = null
    if (this.channel) {
      this.channel.onmessage = null
      this.channel.close()
    }
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
  }
}

function predictionQuest(e: OutboxEntry): string {
  const p = predictionOf(e)
  return p.kind === 'quest-step' ? p.quest : ''
}

function clamp(v: number, max: number): number {
  return Math.min(Math.max(v, 0), max)
}

function safeState(json: JsonValue): PlayerState | null {
  try {
    return fromJson(PlayerStateSchema, json, { ignoreUnknownFields: true })
  } catch {
    return null
  }
}

/** Retry delays: 2 s doubling to a minute, a little slower while the server is in trouble. */
export function retryDelay(failures: number, trouble: boolean): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1))
  return trouble ? Math.min(60_000, base * 1.5) : base
}

function defaultChannel(): ChannelLike | null {
  const BC = (globalThis as { BroadcastChannel?: new (n: string) => ChannelLike }).BroadcastChannel
  try {
    return BC ? new BC('glimway-outbox') : null
  } catch {
    return null
  }
}

/** The typed claim result as the Wilds code keeps it. */
function claimResult(r: import('../lib/gen/glimway/v1/operations_pb.js').WildsClaimResult): WildsClaimResult {
  const e = r.entity
  return {
    epoch: r.epoch,
    entity: {
      id: e?.id ?? '',
      kind: 'camp',
      tx: 0,
      ty: 0,
      enemies: [],
      material: '',
      tier: 0,
      poi: '',
      cycle: e?.cycle ?? 0,
      state: (e?.state ?? 'available') as WildsClaimResult['entity']['state'],
      available_at: e?.availableAt ?? 0,
      by: e?.by ?? null,
      at: e?.at ?? null
    },
    loot: { materials: (r.loot?.materials ?? []).map((m) => ({ id: m.id, qty: m.qty })), trinket: r.loot?.trinket ?? null },
    materials: { timber: r.materials.timber ?? 0, stone: r.materials.stone ?? 0, fiber: r.materials.fiber ?? 0, amber: r.materials.amber ?? 0 },
    wardenSliverFound: r.wardenSliverFound,
    stormDropFound: r.stormDropFound
  }
}

function lanternResult(r: import('../lib/gen/glimway/v1/operations_pb.js').WildsLanternResult): WildsLanternResult {
  return {
    epoch: r.epoch,
    rewarded: r.rewarded,
    loot: { materials: (r.loot?.materials ?? []).map((m) => ({ id: m.id, qty: m.qty })), trinket: r.loot?.trinket ?? null },
    materials: { timber: r.materials.timber ?? 0, stone: r.materials.stone ?? 0, fiber: r.materials.fiber ?? 0, amber: r.materials.amber ?? 0 },
    lanterns: r.lanterns.map((l) => ({ id: l.id, ownerId: l.ownerId, displayName: l.displayName, x: l.x, y: l.y, litBy: l.litBy ?? null, at: l.at, litAt: l.litAt ?? null }))
  }
}
