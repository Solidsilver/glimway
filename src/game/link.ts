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
 * - **Ownership.** One tab per device owns an account's outbox: it holds the
 *   Web Lock and the record's fence (src/lib/api/outbox.ts `claim`). Only the
 *   owner allocates, predicts durable work or writes the record, offline too.
 * - **Durability.** A write counts once its transaction commits. Nothing is
 *   sent before its entry (and its `sent` mark) is stored, and nothing that
 *   may have been sent is dropped without a state read that says what the
 *   world holds. An answer that can't be trusted (the wrong result, no state,
 *   a disagreeing copy at the same version) never advances the head.
 * - **Callers** waiting on an operation always hear back: paused, signed out,
 *   taken over or unreachable, the world never freezes waiting on the queue.
 *
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
import { adoptable, fallRecovery, gameStateOf, isClientMark, predictedView, profileOf, QUEST_STEP, whereOf, type Prediction } from '../lib/api/predict.ts'
import { REPORT_INTERVAL_MS, ReportBook, type CapturedReport, type ReportAck } from '../lib/api/reports.ts'
import { LANTERN_ROAD } from '../lib/api/ports.ts'
import type { HomeAction, HomeActionResponse, HomeOp, HomeView, ItemsOp, CommonsResponse, Snapshot, WildsClaimResult, WildsDefeatResult, WildsLanternResult, WildsRegionResponse } from '../lib/api/types.ts'
import { EnvelopeSchema, PlayerStateSchema, PlayRequestSchema, type PlayerState } from '../lib/gen/glimway/v1/state_pb.js'
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
   * `predicted`: a local prediction changed the view, and its own caller
   * announces it (a found paper).
   */
  applyServer(next: GameState, provenance: { vitalsSource: VitalsSource; importedProfile: HabiticaProfile | null }, opts: { relocate?: boolean; vitals?: { hp: number; mana: number }; quiet?: boolean; predicted?: boolean }): void
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

/**
 * How an operation the caller waits for came out. `pending`: it is kept
 * (it may have been sent, or the queue is held) and its outcome comes later.
 */
type Outcome =
  | { ok: true; state: PlayerState | null; result: unknown }
  | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' | 'resolved' }

/** Typed operations: their request schema, facade call, and the envelope result case their answer must carry. */
const TYPED: Partial<Record<OutboxKind, { schema: DescMessage; path: string; result: string; send: (ops: OperationsApi, req: never) => Promise<import('../lib/gen/glimway/v1/state_pb.js').Envelope> }>> = {
  'quest-step': { schema: QuestStepRequestSchema, path: '/api/quest/step', result: 'questStep', send: (ops, req) => ops.questStep(req) },
  mark: { schema: MarkRequestSchema, path: '/api/story/mark', result: 'mark', send: (ops, req) => ops.mark(req) },
  'take-paper': { schema: TakePaperRequestSchema, path: '/api/papers/take', result: 'takePaper', send: (ops, req) => ops.takePaper(req) },
  'settle-echo': { schema: SettleEchoRequestSchema, path: '/api/wilds/echo', result: 'settleEcho', send: (ops, req) => ops.settleEcho(req) },
  fall: { schema: FallRequestSchema, path: '/api/fall', result: 'fall', send: (ops, req) => ops.fall(req) },
  spend: { schema: SpendRequestSchema, path: '/api/spend', result: 'spend', send: (ops, req) => ops.spend(req) },
  'wilds-claim': { schema: WildsClaimRequestSchema, path: '/api/wilds/claim', result: 'wildsClaim', send: (ops, req) => ops.wildsClaim(req) },
  'wilds-lantern': { schema: WildsLanternRequestSchema, path: '/api/wilds/lantern', result: 'wildsLantern', send: (ops, req) => ops.wildsLantern(req) }
}

/** The same mutation asked again: its route and fields, apart from the header and where the hero stands. */
function sameRequest(entry: OutboxEntry, path: string, body: Record<string, unknown>): boolean {
  if (entry.kind !== 'mutation' || entry.path !== path) return false
  const strip = ({ op: _op, where: _where, ...rest }: Record<string, unknown>) => JSON.stringify(rest)
  return strip(JSON.parse(entry.body) as Record<string, unknown>) === strip(body)
}

/** The village spawn a fall wakes at (the server's own place comes with its answer). */
const VILLAGE_SPAWN = { area: 'village', x: 400, y: 300 }

/** An answer that arrived but proves nothing (the wrong result, no state): retried, not "offline". */
const untrusted = () => new ApiError('bad-response', { status: 200 })

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
  /**
   * Sending stopped until a reload (`reload`), a fix (`client-bug`), or until
   * the world can say which payload a key committed (`mismatch`).
   */
  paused: null | 'reload' | 'client-bug' | 'mismatch' = null
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
  /** The record's fence while this tab owns it (null: not the owner, never writes). */
  private fence: number | null = null
  private owning: Promise<boolean> | null = null
  /** Callers waiting for their entry's answer. */
  private readonly waiters = new Map<number, (o: Outcome) => void>()
  /** Entries that may have been sent before this page held them: replayed only after a state read. */
  private needsRead = false
  /** A record write didn't land: retried until it does, and nothing claims to be settled meanwhile. */
  private unsaved = false
  private savedNotice = false
  private saveRetry: ReturnType<typeof setTimeout> | null = null
  private pumping: Promise<void> | null = null
  private reportWanted = false
  /** Heads already asked again at once after an unreadable answer. */
  private readonly replayed = new Set<number>()
  /** The periodic report is due: it goes even with nothing new (play time is counted between reports). */
  private reportForced = false
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  /** When the head (or a report) first went unanswered (null: answered). */
  private unansweredSince: number | null = null
  private lastContact: number
  private stopped = false
  private sealed = false
  private settleRun = 0
  private loggedOut = false
  private reconnecting: Promise<void> | null = null
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
    // Read-only until this tab owns the record (`own` loads it again under the lock).
    this.entries = [...record.entries]
    this.nextId = record.nextId
    // The same tab's lease resumes after a reload; another tab's never does.
    this.lease = record.client === init.clientId ? record.lease : null
    this.reports = new ReportBook(record.client === init.clientId ? record.reports : null)
    if (record.client !== init.clientId || !record.reports) this.reports.reset(this.basis())
    if (this.channel) this.channel.onmessage = (ev) => this.onChannel(ev.data)
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline)
  }

  /**
   * The game's starting state: the view, with the place and vitals the last
   * page reported or meant to report (a reload never heals or moves the
   * hero). After a fall still in the outbox, that is the recovery and what
   * happened since, even if the world already holds the fall.
   */
  initialState(): GameState {
    const view = this.view()
    const n = this.reports.next
    const pendingFall = n.boundary !== null && this.entries.some((e) => e.id === n.boundary && e.kind === 'fall')
    if (n.place && (pendingFall || n.basis >= (this.server.vitals?.vitalsSetVersion ?? 0))) {
      const live = gameStateOf(create(PlayerStateSchema, { ...this.server, place: { ...this.server.place!, area: n.place.area, x: n.place.x, y: n.place.y } }))
      return { ...view, area: live.area, position: live.position, ...(live.wildsRegion ? { wildsRegion: live.wildsRegion } : {}), hp: Math.min(n.hp, view.maxHp), mana: Math.min(n.mana, view.maxMana) }
    }
    return view
  }

  /** Bind the live session (once, before play starts) and take ownership of the outbox. */
  attach(session: LinkSession): void {
    this.session = session
    this.noteLive()
    this.startReports()
    void this.own(false).then((ok) => {
      if (this.stopped) return
      if (!ok) {
        // Another tab here owns it (a storage failure retries on its own).
        if (!this.unsaved) this.setStatus('superseded')
        return
      }
      void this.expire()
      if (this.status === 'online') {
        this.startHeartbeat()
        this.pump()
      } else this.scheduleRetry()
    })
    this.emit()
  }

  /** Resolves once this tab owns the outbox (false: another tab here does). */
  ready(): Promise<boolean> {
    return this.own(false)
  }

  get online(): boolean {
    return this.status === 'online'
  }

  /** The outbox holds something the server hasn't answered (what a logout asks about). */
  get dirty(): boolean {
    return this.entries.length > 0
  }

  /** Nothing is waiting to be written, and the record says so durably. */
  get settled(): boolean {
    return this.status === 'online' && !this.paused && this.entries.length === 0 && !this.reports.captured && !this.busy && !this.unsaved
  }

  /** Unanswered operations, oldest first (read-only). */
  get outbox(): readonly OutboxEntry[] {
    return this.entries
  }

  /** This tab owns the outbox (the lock and the record's fence). */
  get owner(): boolean {
    return this.fence !== null
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
  private refresh(opts: { relocate?: boolean; vitals?: { hp: number; mana: number }; quiet?: boolean; predicted?: boolean } = {}): void {
    const s = this.session
    if (!s) return
    const profile = profileOf(this.server)
    s.applyServer(this.view(), { vitalsSource: profile ? 'imported' : 'demo', importedProfile: profile }, opts)
  }

  /** The screen's place and vitals, into the next report. */
  /**
   * The basis a report names: the newest server vitals or place write this
   * link has taken. The server ignores a report's place below the place
   * watermark and its vitals below the vitals one (design: Reports, 2).
   */
  private basis(): number {
    return Math.max(this.server.vitals?.vitalsSetVersion ?? 0, this.server.place?.placeSetVersion ?? 0)
  }

  private noteLive(): void {
    const s = this.session
    if (!s) return
    this.reports.note(whereOf(s.state), Math.max(0, s.state.hp), Math.max(0, s.state.mana))
  }

  /** How a state meets the one held: newer, equal (the same copy), older, or a disagreeing copy at the same version. */
  private compare(next: PlayerState): 'newer' | 'equal' | 'older' | 'conflict' {
    const held = this.server
    if (!adoptable(held, next)) return 'older'
    if (next.version > held.version) return 'newer'
    return equals(PlayerStateSchema, next, held) ? 'equal' : 'conflict'
  }

  /**
   * Adopt a state at an equal or higher version, and move the vitals overlay.
   * A server vitals write starts over from it, unless a fall waits in the
   * outbox: then the write is taken for that fall, and what happened after
   * its predicted recovery is kept. A report's acknowledgment keeps what
   * happened since its capture. Anything else leaves live vitals alone.
   * `read`: a state read, which wins over a disagreeing copy.
   */
  private adopt(next: PlayerState | null | undefined, ctx: { captured?: CapturedReport | null; ack?: ReportAck; read?: boolean; fall?: OutboxEntry } = {}): boolean {
    if (!next) return false
    const how = this.compare(next)
    if (how === 'older' || (how === 'conflict' && !ctx.read)) return false
    const prev = this.server
    this.server = next
    if (next.account?.worldId) this.worldId = next.account.worldId
    if (next.account?.displayName) this.name = next.account.displayName
    const s = this.session
    const v = next.vitals!
    let vitals: { hp: number; mana: number } | undefined
    if (s && v.vitalsSetVersion > prev.vitals!.vitalsSetVersion) {
      const fall = ctx.fall ?? this.entries.find((e) => e.kind === 'fall' && e.fall)
      if (fall?.fall) {
        vitals = { hp: v.hp + (s.state.hp - fall.fall.hp), mana: v.mana + (s.state.mana - fall.fall.mana) }
        // The fall's recovery is the world's now: its own answer applies nothing twice.
        fall.fall = { hp: v.hp, mana: v.mana }
      } else {
        vitals = { hp: v.hp, mana: v.mana }
        this.reports.reset(this.basis())
      }
    } else if (s && ctx.captured && ctx.ack?.accepted && !ctx.ack.staleBasis) {
      const c = ctx.captured
      vitals = { hp: v.hp + (s.state.hp - c.hp), mana: v.mana + (s.state.mana - c.mana) }
    }
    if (vitals) vitals = { hp: clamp(vitals.hp, v.maxHp), mana: clamp(vitals.mana, v.maxMana) }
    // A place watermark the screen now follows (no vitals written): name it.
    this.reports.rebase(this.basis())
    this.refresh({ vitals })
    return true
  }

  /**
   * Read the server's state and adopt it: what an uncertain answer, an
   * expired or abandoned head, or a replay from an earlier page needs first.
   * `ok` only when a valid read came back on our own lease; anything else
   * already moved the link (paused, signed out, taken over, offline).
   */
  private async reconcile(): Promise<'ok' | 'failed'> {
    if (!this.lease || this.stopped) return 'failed'
    try {
      const res = await this.api.run(() => this.ops.state(this.lease ?? undefined))
      this.contact()
      if (!res.leaseActive) {
        this.leaseLost()
        return 'failed'
      }
      if (!res.state) {
        this.stalled(untrusted())
        return 'failed'
      }
      this.adopt(res.state, { read: true })
      this.needsRead = false
      return 'ok'
    } catch (err) {
      this.stopFor(err)
      return 'failed'
    }
  }

  // ------------------------------------------------------------ ownership and persistence

  /**
   * Own the outbox for this device: hold the Web Lock (`steal` only on the
   * player's Take over), then claim the record, which raises its fence and
   * hands back the record as stored. False: another tab here owns it.
   */
  private own(steal: boolean): Promise<boolean> {
    if (this.fence !== null) return Promise.resolve(true)
    if (this.owning) return this.owning
    this.owning = (async () => {
      const lock = await holdLock(this.locks, lockName(this.accountId, this.device), steal)
      if (!lock) return false
      if (this.stopped) {
        lock.release()
        return false
      }
      const record = await this.store.claim(this.accountId, this.device)
      if (!record) {
        // The record couldn't be claimed (storage failed): try again with the next retry.
        lock.release()
        this.storageFailed()
        return false
      }
      this.lock = lock
      this.fence = record.fence
      void lock.lost.then(() => {
        if (this.lock === lock) this.ownershipLost()
      })
      this.take(record)
      return true
    })().finally(() => {
      this.owning = null
    })
    return this.owning
  }

  /**
   * The claimed record replaces what this page read before it owned it.
   * Work a previous page queued that needs a connection and was never sent
   * goes: nothing the server decides happens long after its caller left.
   * Work that may have been sent is replayed only after a state read.
   */
  private take(record: OutboxRecord): void {
    const stale = record.entries.filter((e) => !e.offline && !e.sent && !this.waiters.has(e.id))
    this.entries = record.entries.filter((e) => !stale.includes(e))
    this.nextId = Math.max(this.nextId, record.nextId)
    this.needsRead = this.entries.some((e) => e.sent)
    if (record.client === this.clientId && record.reports) {
      const live = this.reports.next
      Object.assign(this.reports, new ReportBook(record.reports))
      if (live.place) this.reports.note(live.place, live.hp, live.mana)
    }
    const state = record.server ? safeState(record.server) : null
    if (state && this.compare(state) === 'newer') this.adopt(state)
    else this.refresh()
    if (stale.length) void this.saveRecord()
  }

  /** Another tab owns the outbox now (its Take over, or a newer tab without Web Locks): stop, write nothing. */
  private ownershipLost(): void {
    this.fence = null
    this.lock?.release()
    this.lock = null
    if (this.stopped) return
    this.release('hold')
    this.setStatus('superseded')
  }

  /** IndexedDB is there: entries must be stored before they count (false: memory only, offline play off). */
  private get durable(): boolean {
    return this.store.durable
  }

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
      fence: this.fence ?? 0,
      savedAt: this.now()
    }
  }

  /**
   * Write the record, as its owner only, counted once committed. A failed
   * write is retried until one lands; a fenced one means another tab owns it.
   */
  private async saveRecord(): Promise<'saved' | 'fenced' | 'failed'> {
    if (this.fence === null) return 'fenced'
    const r = await this.store.save(this.record())
    if (r === 'fenced') {
      this.ownershipLost()
      return r
    }
    if (r === 'failed') {
      if (this.durable) this.storageFailed()
      return r
    }
    this.unsaved = false
    this.channel?.postMessage({ type: 'outbox', account: this.accountId, device: this.device })
    return r
  }

  /** IndexedDB refused a write: say so once, and keep trying. */
  private storageFailed(): void {
    this.unsaved = true
    if (!this.savedNotice) {
      this.savedNotice = true
      this.emitter(EV.toast, { text: 'This browser isn’t saving your queued changes right now. Keep this tab open; it keeps trying.', kind: 'error' })
    }
    if (this.saveRetry !== null || this.stopped) return
    this.saveRetry = setTimeout(() => {
      this.saveRetry = null
      if (this.fence === null) void this.reconnect(false)
      else void this.saveRecord().then((r) => r === 'saved' && this.pump())
    }, 2_000)
  }

  /** Another tab wrote the outbox: a passive tab picks it up, so its view is current when it takes over. */
  private onChannel(data: unknown): void {
    const m = data as { type?: string; account?: string; device?: string } | null
    if (!m || m.type !== 'outbox' || m.account !== this.accountId || m.device !== this.device || this.fence !== null) return
    void this.store.load(this.accountId, this.device).then((r) => {
      if (!r || this.fence !== null) return
      this.entries = r.entries
      this.nextId = Math.max(this.nextId, r.nextId)
      const state = r.server ? safeState(r.server) : null
      if (state && this.compare(state) !== 'older') this.adopt(state, { read: true })
      else this.refresh()
    })
  }

  /** Before a reload for a new version: send everything, then report whether it all landed. 'saved' seals the link. */
  async settle(): Promise<'saved' | 'offline' | 'unsaved'> {
    const run = ++this.settleRun
    await this.persist()
    for (let i = 0; i < 50; i++) {
      // Until what the hero is doing now has gone up: a report already on its
      // way may carry an older spot, and the newer one must follow it.
      this.noteLive()
      if (this.reports.due) this.reportWanted = true
      this.pump()
      if (this.pumping) await this.pumping
      if (this.reconnecting) await this.reconnecting.catch(() => undefined)
      await new Promise((r) => setTimeout(r, 10))
      if (run !== this.settleRun) return 'unsaved'
      if (!this.pumping && (!this.canSend() || (!this.entries.length && !this.reports.due))) break
    }
    if (this.unsaved) await this.saveRecord()
    if (!this.settled || this.reports.due) return this.status === 'offline' ? 'offline' : 'unsaved'
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
   * Persist first: nothing is sent, or predicted durably, before its entry
   * is stored. `prepare` runs with the entry (in the same record write);
   * `undo` takes it back if the write doesn't land.
   */
  private async submit(
    kind: OutboxKind,
    path: string,
    key: string,
    body: Record<string, unknown>,
    opts: { offline: boolean; barrier?: boolean; fall?: { hp: number; mana: number }; prepare?: (id: number) => void; undo?: () => void }
  ): Promise<{ outcome: Outcome; entry: OutboxEntry | null }> {
    const refused = (code: Extract<Outcome, { ok: false }>['code']) => ({ outcome: { ok: false, code } as Outcome, entry: null })
    if (this.stopped || !this.session) return refused('unknown')
    if (this.status === 'superseded' || this.status === 'signed-out') return refused(this.status === 'superseded' ? 'superseded' : 'unauthorized')
    if (this.sealed) return refused('busy')
    if (!opts.offline) {
      if (this.busy) return refused('busy')
      if (this.paused === 'reload') return refused('reload-needed')
      if (!this.canSend()) return refused('offline')
    } else if (!this.canSend() && !this.durable) {
      // No outbox that survives the page: offline play is off, before anything shows.
      this.emitter(EV.toast, { text: 'Needs a connection. This browser won’t keep offline changes.', kind: 'error' })
      return refused('offline')
    }
    if (this.fence === null && !(await this.own(false))) return refused('superseded')
    const entry: OutboxEntry = { id: this.nextId++, kind, path, key, body: JSON.stringify(body), contract: contract.number, createdAt: this.now(), sent: false, barrier: opts.barrier === true, offline: opts.offline, ...(opts.fall ? { fall: opts.fall } : {}) }
    this.entries.push(entry)
    opts.prepare?.(entry.id)
    if (opts.offline && kind !== 'fall') this.refresh({ predicted: true })
    const saved = await this.saveRecord()
    if (saved !== 'saved' && (this.durable || saved === 'fenced' || !this.canSend())) {
      // Not stored, so never sent and never kept: everything it showed goes.
      this.entries = this.entries.filter((e) => e !== entry)
      opts.undo?.()
      this.refresh()
      if (saved === 'fenced') return refused('superseded')
      if (opts.offline) this.emitter(EV.toast, { text: 'This browser couldn’t keep that change. Nothing was queued.', kind: 'error' })
      void this.saveRecord()
      return refused('offline')
    }
    if (opts.offline) {
      this.pump()
      return { outcome: { ok: true, state: null, result: null }, entry }
    }
    this.setBusy(true)
    try {
      const done = new Promise<Outcome>((r) => this.waiters.set(entry.id, r))
      this.pump()
      return { outcome: await done, entry }
    } finally {
      this.setBusy(false)
    }
  }

  private canSend(): boolean {
    return !this.stopped && this.fence !== null && this.status === 'online' && !!this.lease && !this.paused
  }

  private pump(): void {
    if (this.pumping || !this.canSend()) return
    this.pumping = this.drain().finally(() => {
      this.pumping = null
      // More arrived while draining; a pending retry waits for its timer instead.
      if (this.retry === null && this.canSend() && (this.entries.length > 0 || (this.reportWanted && (this.reportForced || this.reports.due)))) this.pump()
    })
  }

  /** Head of line: one operation at a time, in order; a report when the outbox is idle. */
  private async drain(): Promise<void> {
    while (this.canSend()) {
      if (!(await this.expire())) return
      const head = this.entries[0]
      if (!head) {
        if (!this.reportWanted && !this.reports.captured) return
        this.noteLive()
        const forced = this.reportForced
        if (!(await this.sendReport(forced)).ok) return
        this.reportWanted = false
        if (forced) this.reportForced = false
        return
      }
      if (!(await this.sendHead(head))) return
    }
  }

  /** Send the head. False: stop draining (paused, offline, waiting to retry). */
  private async sendHead(head: OutboxEntry): Promise<boolean> {
    if (head.sent && this.needsRead && (await this.reconcile()) !== 'ok') return false
    let barrier: { client: string; generation: string; seq: number } | null = null
    if (head.barrier) {
      barrier = await this.flushBarrier()
      if (!barrier) return false
    }
    if (!head.sent) {
      head.sent = true
      const marked = await this.saveRecord()
      if (marked !== 'saved' && this.durable) {
        // Never send what the record doesn't say may have been sent.
        head.sent = false
        if (marked === 'failed') return this.stalled(untrusted())
        return false
      }
    }
    const body = JSON.parse(head.body) as Record<string, unknown>
    body.op = { ...(body.op as object), lease: this.lease, ...(barrier ? { report: barrier } : {}) }
    let state: PlayerState | null
    let result: unknown
    let trusted: boolean
    try {
      if (head.kind === 'mutation') {
        const route = routeFromPath(head.path)
        if (!route) throw new ApiError('invalid-json', { status: 400 })
        const res = await this.api.run((raw) => dispatchMutation(raw, route, body))
        state = res.player ?? null
        result = res
        trusted = true
      } else {
        const typed = TYPED[head.kind]!
        let req
        try {
          req = fromJson(typed.schema, body as JsonValue, { ignoreUnknownFields: false })
        } catch {
          throw new ApiError('invalid-json', { status: 400 })
        }
        const env = await this.api.run(() => typed.send(this.ops, req as never))
        state = env.state ?? null
        result = env.result
        // An answer for another operation proves nothing about this one.
        trusted = env.result.case === typed.result
      }
    } catch (err) {
      return this.headFailed(head, err)
    }
    this.answered()
    if (!trusted) return this.stalled(untrusted())
    // No state, or one that disagrees with ours at its version: a read must say first.
    const how = state ? this.compare(state) : 'conflict'
    if ((how === 'conflict' || how === 'older') && (await this.reconcile()) !== 'ok') return false
    this.entries = this.entries.filter((e) => e !== head)
    if (state && (how === 'newer' || how === 'equal')) this.adopt(state, head.kind === 'fall' ? { fall: head } : {})
    if (head.kind === 'fall') this.fallSettled(head, result)
    else this.refresh()
    const stored = await this.dispositionSaved()
    // A step's gift (paid once, by the server): the toast follows its answer.
    const gift = head.kind === 'quest-step' && (result as { case?: string; value?: { embers?: number } })?.case === 'questStep' ? (result as { value: { embers: number } }).value.embers : 0
    if (gift > 0) this.emitter(EV.toast, { text: `+${gift} embers — a little warmth from the road.`, icon: 'ember' })
    this.notify(head, { ok: true, state, result })
    return stored
  }

  /**
   * Store a settled head's removal before anything behind it goes. False:
   * the write didn't land; it is retried, and the queue resumes once it does.
   */
  private async dispositionSaved(): Promise<boolean> {
    const r = await this.saveRecord()
    return r === 'saved' || (r === 'failed' && !this.durable)
  }

  /**
   * `idempotency-mismatch`: the key already committed a payload, and the
   * world's reconciliation read says which (lane B,
   * `GET /api/operations/result`). The same payload is this operation,
   * landed: its stored result settles it. A different one is a different
   * action: this one never happened, its prediction goes, and nobody is told
   * it landed. Until the read succeeds the head stays uncertain; with no row
   * left to read (past retention) the queue pauses rather than guess.
   */
  private async resolveMismatch(head: OutboxEntry, err: ApiError): Promise<boolean> {
    if (err.state && this.compare(err.state) === 'newer') this.adopt(err.state)
    let found: Awaited<ReturnType<RawApi['operationResult']>>
    try {
      found = await this.api.run((raw) => raw.operationResult(head.path, head.key))
    } catch (e) {
      this.stopFor(e)
      return false
    }
    if (this.compare(found.state) !== 'older') this.adopt(found.state, { read: true })
    const op = found.operation
    if (!op) {
      console.warn('[glimway] a queued key committed a request the world no longer remembers', head.kind)
      this.emitter(EV.toast, { text: 'The world holds a different version of something this device queued. It’s kept here until that’s sorted out.', kind: 'error' })
      this.pause('mismatch')
      return false
    }
    const same = samePayload(head, op.payload)
    if (same && op.refused) return this.headFailed(head, new ApiError(op.refused, { status: 409, state: found.state }))
    let result: unknown = null
    if (same && head.kind !== 'mutation') {
      try {
        result = fromJson(EnvelopeSchema, { [op.resultCase]: op.result } as JsonValue, { ignoreUnknownFields: true }).result
      } catch {
        result = null
      }
      if ((result as { case?: string } | null)?.case !== TYPED[head.kind]!.result) return this.stalled(untrusted())
    }
    this.entries = this.entries.filter((e) => e !== head)
    if (head.kind === 'fall') this.fallSettled(head, result)
    else this.refresh()
    const stored = await this.dispositionSaved()
    if (!same) {
      console.warn('[glimway] a queued key committed a different request', head.kind)
      if (!this.waiters.has(head.id)) this.emitter(EV.toast, { text: UNDONE[head.kind] ?? 'Something this device queued was already used for something else. It didn’t happen.', kind: 'error' })
      this.notify(head, { ok: false, code: 'idempotency-mismatch' })
    } else if (head.kind === 'mutation') this.notify(head, { ok: false, code: 'resolved' })
    else this.notify(head, { ok: true, state: this.server, result })
    return stored
  }

  /**
   * A fall left the outbox (answered, or given up): the next report goes
   * against the vitals the world now holds, carrying what happened since.
   * This happens whether or not its answer moved the vitals watermark (a
   * replay of a fall the world already held).
   */
  private fallSettled(fall: OutboxEntry, result: unknown): void {
    this.reports.release(fall.id, this.basis())
    this.refresh()
    // The answer says whether a fallen-hero lantern now waits in the Wilds.
    const r = result as { case?: string; value?: { lantern?: string } } | null
    if (r?.case === 'fall') this.emitter(EV.fallSettled, { lantern: r.value?.lantern ?? 'none' })
  }

  /** The head wasn't answered with success. */
  private async headFailed(head: OutboxEntry, err: unknown): Promise<boolean> {
    const code = errorCode(err)
    if (isReloadNeeded(err) || isOutboxClientBug(err) || code === 'superseded' || code === 'playing-elsewhere' || code === 'unauthorized') {
      if (isOutboxClientBug(err)) {
        console.warn('[glimway] the server could not read a queued', head.kind, code)
        this.emitter(EV.toast, { text: 'Something this device queued couldn’t be read by the world. It’s kept here; reload to try again.', kind: 'error' })
      }
      this.stopFor(err)
      return false
    }
    if (needsReconciliation(err)) {
      this.answered()
      return this.resolveMismatch(head, err as ApiError)
    }
    if (isSettledRefusal(err)) {
      this.answered()
      // A step that didn't happen takes the steps after it along (an explicit dependency).
      const dependents = head.kind === 'quest-step' ? this.entries.filter((e) => e !== head && e.kind === 'quest-step' && predictionQuest(e) === predictionQuest(head)) : []
      for (const e of [head, ...dependents]) this.drop(e)
      if (this.compare(err.state!) !== 'older') this.adopt(err.state, { read: true })
      this.refresh()
      // Persist the local disposition before advancing, including stored server refusals.
      const stored = await this.dispositionSaved()
      console.warn('[glimway] the world refused a', head.kind, code)
      const undone = UNDONE[head.kind]
      if (undone && !this.waiters.has(head.id)) this.emitter(EV.toast, { text: undone, kind: 'error' })
      for (const e of [head, ...dependents]) this.notify(e, { ok: false, code })
      return stored
    }
    // An answer that arrived but couldn't be read (a truncated 200): ask again
    // at once with the same key and bytes, once (review 5, finding 2). The
    // server's idempotency answers the replay without doing it twice.
    if (err instanceof ApiError && err.status === 200 && !this.replayed.has(head.id)) {
      this.replayed.add(head.id)
      return this.sendHead(head)
    }
    // Ambiguous: it may have committed. Keep it, retry with the same key and bytes.
    const state = err instanceof ApiError ? err.state : undefined
    if (state && this.compare(state) === 'newer') this.adopt(state)
    return this.stalled(err)
  }

  /**
   * The head can't settle now (no answer, an untrustworthy one, a failed
   * read or write): keep it and retry later. Its caller hears `pending`;
   * work behind it that needs a connection and was never sent goes, with
   * `offline`.
   */
  private stalled(err: unknown): false {
    this.unanswered()
    this.release('transport')
    this.backoff(err)
    return false
  }

  /**
   * Stop for a failure that holds the whole queue (a reload, a client bug,
   * the lease, the sign-in) or loses the connection. Every waiting caller
   * hears back; the operations stay as the failure table says.
   */
  private stopFor(err: unknown): void {
    const code = errorCode(err)
    if (isReloadNeeded(err)) this.pause('reload')
    else if (isOutboxClientBug(err)) this.pause('client-bug')
    else if (code === 'superseded' || code === 'playing-elsewhere') this.leaseLost()
    else if (code === 'unauthorized') this.signedOut()
    else this.stalled(err)
  }

  /**
   * Answer every waiting caller. `transport`: the connection failed, so
   * never-sent work that needs one goes (`offline`) and sent work stays
   * (`pending`). `hold` (paused, taken over, signed out): everything stays,
   * and every caller hears `pending`.
   */
  private release(why: 'transport' | 'hold'): void {
    const gone: OutboxEntry[] = []
    for (const id of [...this.waiters.keys()]) {
      const e = this.entries.find((x) => x.id === id)
      if (e && !e.sent && !e.offline && why === 'transport') {
        this.drop(e)
        gone.push(e)
        this.notify(e, { ok: false, code: 'offline' })
      } else if (e) this.notify(e, { ok: false, code: 'pending' })
      else {
        const w = this.waiters.get(id)
        this.waiters.delete(id)
        w?.({ ok: false, code: 'pending' })
      }
    }
    if (gone.length) {
      this.refresh()
      void this.saveRecord()
    }
  }

  /** Remove an entry from the outbox (and its prediction). */
  private drop(entry: OutboxEntry): void {
    this.entries = this.entries.filter((e) => e !== entry)
    if (entry.kind === 'fall') this.reports.release(entry.id, this.basis())
  }

  /** Tell a waiting caller (once), or the features about a replay nobody waited for. */
  private notify(entry: OutboxEntry, outcome: Outcome): void {
    const waiter = this.waiters.get(entry.id)
    if (waiter) {
      this.waiters.delete(entry.id)
      waiter(outcome)
      return
    }
    this.announce(entry, outcome)
  }

  /** Tell the features about a mutation's outcome nobody waited for (a replay, a lost answer). */
  private announce(entry: OutboxEntry, outcome: Outcome): void {
    if (entry.kind !== 'mutation' || (outcome.ok === false && (outcome.code === 'pending' || outcome.code === 'offline'))) return
    const route = routeFromPath(entry.path)
    if (!route) return
    const op = { ...route, fields: {} } as MutationOp
    if (outcome.ok) this.emitter(EV.mutationResolved, { op, outcome: 'landed', res: outcome.result })
    else if (outcome.code === 'resolved') this.emitter(EV.mutationResolved, { op, outcome: 'landed' })
    else this.emitter(EV.mutationResolved, { op, outcome: 'refused', code: outcome.code })
  }

  /**
   * Drop entries past their lifetime or made under another contract (2.4).
   * Never-sent ones go at once. One that may have been sent is never
   * replayed: it waits at the head until a state read says what the world
   * holds, and only then goes. False: that read failed (stop draining).
   */
  private async expire(): Promise<boolean> {
    const old = expired(this.entries, this.now(), contract.number)
    if (!old.length) return true
    const unsent = old.filter((e) => !e.sent)
    const sent = old.filter((e) => e.sent)
    let ok = true
    if (sent.length && (!this.canSend() || (await this.reconcile()) !== 'ok')) ok = false
    const gone = ok ? old : unsent
    if (!gone.length) return ok
    for (const e of gone) this.drop(e)
    for (const e of gone) this.notify(e, { ok: false, code: 'offline' })
    this.refresh()
    await this.saveRecord()
    this.emitter(EV.toast, { text: 'Something you did offline more than six days ago wasn’t kept.', kind: 'error' })
    return ok
  }

  private pause(why: 'reload' | 'client-bug' | 'mismatch'): void {
    this.paused = why
    this.stopTimers()
    this.release('hold')
    this.emit()
  }

  // ------------------------------------------------------------ reports

  private startReports(): void {
    if (this.reportTimer !== null || this.stopped) return
    this.reportTimer = setInterval(() => this.reportDeadline(), REPORT_INTERVAL_MS)
  }

  /**
   * The periodic report is due (every 10 s): it goes even when nothing
   * changed, since the world counts play time between reports. It still
   * waits its turn behind the outbox and any fall's answer.
   */
  reportDeadline(): void {
    this.noteLive()
    this.reportWanted = true
    this.reportForced = true
    this.pump()
  }

  /** Report soon (after whatever is in flight). */
  reportSoon(): void {
    this.noteLive()
    this.reportWanted = true
    this.pump()
  }

  /**
   * The hero arrived in a scene. A place in another area (or another Wilds
   * region) than the last report named is reported now, from where the
   * hero really stands after the arrival (a fresh region read included).
   */
  arrived(): void {
    this.noteLive()
    const area = this.reports.next.place?.area
    if (area && area !== this.reports.reportedArea) this.reportSoon()
  }

  /** A signature cast happened on screen (counted against the server's cast budget). */
  noteCast(n = 1): void {
    this.reports.cast(n)
  }

  /** Send a report: the captured one, or the next one frozen now. */
  private async sendReport(force: boolean): Promise<{ ok: boolean; sent?: CapturedReport; ack?: ReportAck | null }> {
    const c = this.reports.capture(force)
    if (!c) return { ok: true }
    if ((await this.saveRecord()) === 'fenced') return { ok: false }
    try {
      const env = await this.api.run(() => this.ops.report(this.reportRequest(c)))
      this.answered()
      const ack = env.result.case === 'report' ? (env.result.value as ReportAck) : null
      const retired = ack ? this.reports.ack(ack) : null
      if (!retired) {
        // Not the answer to this report: it stays captured and goes again.
        this.stalled(untrusted())
        return { ok: false }
      }
      this.adopt(env.state, { captured: retired, ack: ack ?? undefined })
      await this.saveRecord()
      return { ok: true, sent: retired, ack }
    } catch (err) {
      const code = errorCode(err)
      if (code === 'superseded' || code === 'playing-elsewhere') {
        // A retired generation: its captured report never moves to a new one.
        this.reports.drop()
      } else if (isOutboxClientBug(err)) {
        // Its values can't be read: drop it rather than send it forever.
        this.reports.drop()
      }
      this.stopFor(err)
      return { ok: false }
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
        if (retired) this.adopt(env.state, { captured: retired, ack: ack ?? undefined })
      },
      () => undefined
    )
  }

  /**
   * The report barrier (2.2): a rest, a consumable or a profile reads the
   * stored vitals, so the server must hold what the screen shows. First the
   * captured report (immutable) is settled, then the next one, covering the
   * live state now, is frozen and flushed. Only its accepted acknowledgment
   * on the current vitals basis is a barrier. Null when it can't be had now:
   * every waiting caller has heard why.
   */
  private async flushBarrier(): Promise<{ client: string; generation: string; seq: number } | null> {
    if (this.reports.captured && !(await this.sendReport(false)).ok) return null
    for (let i = 0; i < BARRIER_TRIES; i++) {
      this.noteLive()
      const r = await this.sendReport(true)
      if (!r.ok) return null
      const ack = r.ack
      if (!r.sent || !ack) break
      if (ack.accepted && !ack.staleBasis && ack.basis >= (this.server.vitals?.vitalsSetVersion ?? 0)) return { client: ack.client, generation: ack.generation, seq: ack.seq }
      // Its basis was older than the server's vitals: report again from the vitals it holds.
      this.reports.reset(this.basis())
    }
    // No fresh acknowledgment to be had: try again later.
    this.stalled(new ApiError('report-required'))
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
  }

  /** A client-namespace mark (seen:, met:, found:, defeated:…; predicted; queues offline). */
  mark(mark: string): void {
    const s = this.session
    if (!s || !isClientMark(mark)) return
    const key = newKey()
    const body = toJson(MarkRequestSchema, create(MarkRequestSchema, { op: { lease: '', key }, mark, where: whereOf(s.state) }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    void this.submit('mark', TYPED.mark!.path, key, body, { offline: true })
  }

  /**
   * Take a paper (predicted). Placed and handed-over papers queue offline;
   * a site paper (`epoch`, `site`) needs the server, and its caller hears
   * whether the world gave it (the site should stay until then).
   */
  async takePaper(paper: string, site?: { epoch: string; site: string }): Promise<{ ok: true } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' | 'resolved' }> {
    const s = this.session
    if (!s) return { ok: false, code: 'unknown' }
    const key = newKey()
    const body = toJson(TakePaperRequestSchema, create(TakePaperRequestSchema, { op: { lease: '', key }, paper, where: whereOf(s.state), epoch: site?.epoch ?? '', site: site?.site ?? '' }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    const { outcome } = await this.submit('take-paper', TYPED['take-paper']!.path, key, body, { offline: !site })
    return outcome.ok ? { ok: true } : outcome
  }

  /**
   * The hero fell where they stand now (the caller samples the place first).
   * The fall is written to the outbox with its predicted recovery and its
   * report boundary in one record write; only then does the hero heal and
   * wake at the village, so a recovery is never shown that can't be kept.
   * Combat captured before it is void; the next report waits for its answer.
   */
  async fall(): Promise<{ hp: number; mana: number } | null> {
    const s = this.session
    if (!s) return null
    const key = newKey()
    const where = whereOf(s.state)
    const point = fallRecovery(this.view(), profileOf(this.server))
    const body = toJson(FallRequestSchema, create(FallRequestSchema, { op: { lease: '', key }, where }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    const before = this.reports.stored()
    const { outcome } = await this.submit('fall', TYPED.fall!.path, key, body, {
      offline: true,
      fall: point,
      prepare: (id) => this.reports.fall(id, VILLAGE_SPAWN, point),
      undo: () => this.reports.restore(before)
    })
    if (!outcome.ok) return null
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
    const { outcome: r } = await this.submit('settle-echo', TYPED['settle-echo']!.path, key, body, { offline: false })
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
    const { outcome: r } = await this.submit('spend', TYPED.spend!.path, key, body, { offline: false, barrier: spend.kind === 'rest' || spend.kind === 'home-rest' })
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
      if (!this.canSend()) return { ok: false, code: 'offline' }
      const barrier = await this.flushBarrier()
      if (!barrier) return { ok: false, code: 'offline' }
      const welcomedBefore = s.state.flags.includes(FLAGS.welcome)
      const env = await this.api.run(() => this.ops.profile(create(ProfileReportSchema, { lease: this.lease ?? '', raw, report: barrier })))
      this.answered()
      if (env.result.case !== 'profile') return { ok: false, code: 'bad-response' }
      this.adopt(env.state)
      void this.saveRecord()
      const res = env.result.value
      // `credit` is the XP credit alone; the welcome is paid beside it (its own ledger line).
      const gained = Math.max(0, res.credit)
      const welcome = !welcomedBefore && s.state.flags.includes(FLAGS.welcome) ? WELCOME_EMBERS : 0
      return { ok: true, status: res.status === 'unchanged' ? 'unchanged' : 'synced', gained, welcome, credit: { hp: res.vitalsCredit?.hp ?? 0, mana: res.vitalsCredit?.mana ?? 0 } }
    } catch (err) {
      const code = errorCode(err)
      const state = err instanceof ApiError ? err.state : undefined
      if (state && this.compare(state) === 'newer') this.adopt(state)
      if (isReloadNeeded(err) || code === 'superseded' || code === 'playing-elsewhere' || code === 'unauthorized') this.stopFor(err)
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
      if (player && this.compare(player) === 'newer') this.adopt(player)
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
   * items, repairs, worlds, the library): its fields plus `op` and the
   * hero's `where`, written to the outbox and sent; the world waits for the
   * answer. When the answer is lost the outbox keeps it and replays it with
   * the same key (`pending`); a refusal changes nothing. Consumables carry a
   * report barrier, since they read the stored vitals.
   */
  async mutate<R extends Snapshot>(op: MutationOp): Promise<MutateResult<R>> {
    const s = this.session
    if (!s || this.stopped) return { ok: false, code: 'unknown' }
    const key = newKey()
    const fields = { ...(op.fields ?? {}) }
    // The domain's own `op` field moves aside for the operation header.
    if (op.kind === 'shelf' && 'op' in fields) {
      fields.action = fields.op
      delete fields.op
    }
    const body: Record<string, unknown> = { ...fields, op: { lease: '', key }, where: whereOf(s.state) }
    const route = routeOf(op)
    const path = ROUTE_PATHS[op.kind](route)
    const earlier = this.pendingOperation
    if (earlier) {
      // An earlier answer is still unknown: settle it first. Asking again for
      // the same thing, once it landed, is that thing, not a second one
      // (review 5, finding 2): the caller hears `resolved`.
      const held = !this.waiters.has(earlier.id)
      const settled = held ? new Promise<Outcome>((r) => this.waiters.set(earlier.id, r)) : null
      this.pump()
      while (this.pumping) await this.pumping
      if (this.pendingOperation) {
        if (held) this.waiters.delete(earlier.id)
        return { ok: false, code: 'pending' }
      }
      if (settled) {
        const outcome = await settled
        const landed = outcome.ok || outcome.code === 'resolved'
        if (landed && sameRequest(earlier, path, body)) return { ok: false, code: 'resolved' }
        this.announce(earlier, outcome)
      }
    }
    const { outcome: r } = await this.submit('mutation', path, key, body, { offline: false, barrier: op.kind === 'items' && op.op === 'use' })
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
    return o.ok ? 'landed' : o.code === 'pending' || o.code === 'offline' ? 'unknown' : 'refused'
  }

  // ------------------------------------------------------------ the Wilds

  /** Region read (a GET: no lease). Adopts a newer state, never moves the hero. */
  async wildsRegion(regionId: string): Promise<WildsRegionResponse> {
    const res = await this.api.run((raw) => raw.wildsRegion(regionId))
    this.contact()
    if (res.player && this.compare(res.player) === 'newer') this.adopt(res.player)
    return res
  }

  /** Claim a camp/node/chest/POI from where the hero stands. */
  async wildsClaim(req: { epoch: string; entityId: string; cycle: number }): Promise<WildsOutcome<WildsClaimResult>> {
    const s = this.session
    if (!s) return { ok: false, code: 'unknown' }
    if (!req.epoch) return { ok: false, code: 'epoch-not-found' }
    const key = newKey()
    const body = toJson(WildsClaimRequestSchema, create(WildsClaimRequestSchema, { op: { lease: '', key }, epoch: req.epoch, entityId: req.entityId, cycle: req.cycle, where: whereOf(s.state) }), { alwaysEmitImplicit: true }) as Record<string, unknown>
    const { outcome: r } = await this.submit('wilds-claim', TYPED['wilds-claim']!.path, key, body, { offline: false })
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
    const { outcome: r } = await this.submit('wilds-lantern', TYPED['wilds-lantern']!.path, key, body, { offline: false })
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

  // ------------------------------------------------------------ lease and reconnect

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
      if (!this.unsaved) this.setStatus('superseded')
      return
    }
    try {
      const play = await this.api.run(() => this.ops.play(create(PlayRequestSchema, { clientId: this.clientId, takeOver })))
      this.contact()
      this.lease = play.lease
      const v = play.state?.vitals
      this.reports.bind(play.reportClient, play.reportGeneration, v?.reportSeq ?? 0, v?.reportGeneration ?? '')
      // Someone played elsewhere while this device held unsent work: say so
      // once. Taking the lease back is the proof (a version gap alone can be
      // this device's own report, landed with its answer lost).
      const elsewhere = takeOver && !!play.state && play.state.version > this.server.version && this.entries.length > 0
      // The play answer is a fresh state read: entries from an earlier page may replay now.
      if (play.state) {
        this.adopt(play.state, { read: true })
        this.needsRead = false
      }
      if (elsewhere) this.emitter(EV.linkNotice, { kind: 'played-elsewhere' })
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
      if (isReloadNeeded(err) || code === 'unauthorized') {
        this.stopFor(err)
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

  /** The server lease went elsewhere: stop sending and keep everything (this tab still owns the outbox here). */
  private leaseLost(): void {
    this.release('hold')
    this.setStatus('superseded')
  }

  private signedOut(): void {
    this.release('hold')
    this.setStatus('signed-out')
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
    await this.reconcile()
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
   * 429, an unfinished route, an untrustworthy answer) is "trouble" and keeps
   * the status.
   */
  private backoff(err: unknown): void {
    this.failures += 1
    const offline = isUnreachable(err) && (err as { status?: number }).status === undefined
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
   * device for this account's next sign-in, and isn't offered meanwhile. A
   * tab that doesn't own the outbox leaves the owner's record alone.
   */
  async keepForNextSignIn(): Promise<void> {
    this.keptForNextSignIn = false
    if (this.fence === null) return
    this.loggedOut = true
    this.keptForNextSignIn = (await this.saveRecord()) === 'saved'
  }

  /** Whether the last `keepForNextSignIn` landed (false: not the owner, or the write failed and is retried). */
  keptForNextSignIn = false

  /**
   * Logging out and dropping the unsent work. Never-sent work goes at once;
   * work that may have been sent goes only after a state read says what the
   * world holds. What can't be settled now stays for the next sign-in.
   * Returns how many operations stayed.
   */
  async dropUnsent(): Promise<{ kept: number }> {
    // Not the owner: the owner's work stays where it is.
    if (this.fence === null) return { kept: (await this.store.load(this.accountId, this.device))?.entries.length ?? 0 }
    const sent = this.entries.filter((e) => e.sent)
    const settledRead = sent.length > 0 && this.canSend() && (await this.reconcile()) === 'ok'
    for (const e of [...this.entries]) if (!e.sent || settledRead) this.drop(e)
    this.refresh()
    if (this.entries.length === 0) {
      const r = await this.store.clear(this.accountId, this.device, this.fence)
      if (r === 'fenced') this.ownershipLost()
      return { kept: 0 }
    }
    this.loggedOut = true
    await this.saveRecord()
    return { kept: this.entries.length }
  }

  stop(): void {
    this.stopped = true
    this.stopTimers()
    if (this.reportTimer !== null) clearInterval(this.reportTimer)
    this.reportTimer = null
    if (this.saveRetry !== null) clearTimeout(this.saveRetry)
    this.saveRetry = null
    for (const [, waiter] of this.waiters) waiter({ ok: false, code: 'pending' })
    this.waiters.clear()
    this.lock?.release()
    this.lock = null
    this.fence = null
    if (this.channel) {
      this.channel.onmessage = null
      this.channel.close()
    }
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
  }
}

/**
 * Whether a committed payload is this entry's own request: the same semantic
 * fields once the `op` header is set aside (proto defaults decoded alike;
 * domain JSON with empty values dropped).
 */
function samePayload(entry: OutboxEntry, payload: Record<string, unknown>): boolean {
  const ours = JSON.parse(entry.body) as Record<string, unknown>
  delete ours.op
  const theirs = { ...payload }
  delete theirs.op
  const typed = TYPED[entry.kind]
  if (typed) {
    try {
      const a = fromJson(typed.schema, ours as JsonValue, { ignoreUnknownFields: true })
      const b = fromJson(typed.schema, theirs as JsonValue, { ignoreUnknownFields: true })
      return equals(typed.schema, a, b)
    } catch {
      return false
    }
  }
  return JSON.stringify(normalized(ours)) === JSON.stringify(normalized(theirs))
}

/** Sorted keys, without empty values (`''`, 0, false, null, [], {}). */
function normalized(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalized)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = normalized((v as Record<string, unknown>)[k])
      const empty = x === '' || x === 0 || x === false || x === null || x === undefined || (Array.isArray(x) && !x.length) || (typeof x === 'object' && x !== null && !Array.isArray(x) && !Object.keys(x).length)
      if (!empty) out[k] = x
    }
    return out
  }
  return v
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
