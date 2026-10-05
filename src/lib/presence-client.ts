/**
 * Presence protocol client (phase 6): one WebSocket to `/ws` for a connected
 * session that holds the play lease. Wire protocol: `.agent/BACKEND-REPORT.md`
 * "Phase 6 server"; shared types and limits: `src/lib/presence.ts`.
 *
 * - Auth goes in the first text message (never the URL); nothing else is sent
 *   until `ready`.
 * - `join` on every area change, paced by the server's join cooldown (the
 *   latest wanted area wins).
 * - Positions at most `positionHz` while moving, plus a final stop; the
 *   latest sample inside a cooldown is sent when it ends, never dropped.
 * - Emotes respect the emote cooldown locally (the server drops excess).
 * - A heartbeat keeps a standing-still socket alive.
 * - Close codes decide: superseded/unauthorized/replaced/protocol errors stop;
 *   transport loss, idle, shutdown and capacity reconnect with backoff.
 *
 * Pure: the socket and timers are injected, so this runs under node --test.
 * It never sees credentials beyond the lease, and never logs messages.
 */
import { PRESENCE, PRESENCE_CLOSE, type PresencePlayer, type PresencePosition, type PresenceServerMessage } from './presence.ts';

/** The WebSocket surface the client uses (the browser's WebSocket fits). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const OPEN = 1;

export type PresenceStatus =
  /** Not running (no lease, guest, or stopped). */
  | 'off'
  | 'connecting'
  | 'live'
  /** Lost the socket; trying again after a backoff. */
  | 'retrying'
  /** Stopped by the server: the lease moved, the session ended, or another socket took over. */
  | 'superseded'
  | 'unauthorized'
  | 'replaced'
  /** Stopped after a protocol rejection (a client bug; no retry loop). */
  | 'rejected';

export interface PresenceHandlers {
  status?(status: PresenceStatus, closeCode?: number): void;
  ready?(habiticaId: string): void;
  room?(area: string, players: PresencePlayer[]): void;
  join?(area: string, player: PresencePlayer): void;
  leave?(habiticaId: string): void;
  pos?(habiticaId: string, pos: PresencePosition): void;
  emote?(habiticaId: string, id: string): void;
}

export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface PresenceClientOptions {
  url: string;
  makeSocket: (url: string) => SocketLike;
  handlers?: PresenceHandlers;
  timers?: Timers;
  /** Jitter source for backoff (tests pin it). */
  random?: () => number;
}

/** Wait before reconnect attempt `n` (1-based): 1 s doubling to 30 s, ±20% jitter. */
export function presenceBackoff(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/**
 * What a close code means for the client. Only definite answers stop it;
 * everything else backs off and retries, keeping sign-in and lease state.
 */
export function closeAction(code: number, reason = ''): 'retry' | 'superseded' | 'unauthorized' | 'replaced' | 'rejected' {
  if (code === PRESENCE_CLOSE.superseded) return 'superseded';
  if (code === PRESENCE_CLOSE.unauthorized) return 'unauthorized';
  if (code === PRESENCE_CLOSE.replaced) return 'replaced';
  // A sustained message flood (1008 rate-limited): back off, then try again.
  if (code === 1008 && reason === 'rate-limited') return 'retry';
  // Protocol violations: retrying would only repeat them.
  if (code === 1003 || code === 1008 || code === 1009) return 'rejected';
  // 1000 ordinary, 1001 shutdown, 1006 transport loss or a refused upgrade
  // (429 presence-session/player-limit, which a browser can't read), 1011
  // internal or auth-unavailable, 1013 capacity, 4004 idle/pong timeout.
  return 'retry';
}

/** Server-accepted presence areas (curated areas and Wilds chunks). */
const AREA_RE = /^(village|woodland|ruin|commons|wilds:[a-z0-9-]+:(0|[1-9]\d*):(0|[1-9]\d*))$/;

export function isPresenceArea(area: string): boolean {
  return AREA_RE.test(area);
}

/**
 * The presence room for a scene's area id: curated areas as they are, and a
 * Wilds chunk (`chunk:<region>:<cx>:<cy>`, the Wilds client's area ids) as the
 * server's `wilds:<region>:<cx>:<cy>`. Anything else has no room (null).
 */
export function presenceAreaFor(areaId: string): string | null {
  const chunk = /^chunk:([a-z0-9-]+):(\d+):(\d+)$/.exec(areaId);
  const area = chunk ? `wilds:${chunk[1]}:${Number(chunk[2])}:${Number(chunk[3])}` : areaId;
  return isPresenceArea(area) ? area : null;
}

/** A unit facing vector the server accepts (|f|² within 0.01 of 1); else facing down. */
export function normalFacing(f: { x: number; y: number }): { x: number; y: number } {
  const len = Math.hypot(f.x, f.y);
  if (!Number.isFinite(len) || len < 1e-6) return { x: 0, y: 1 };
  return { x: f.x / len, y: f.y / len };
}

const POS_GAP = Math.ceil(1000 / PRESENCE.positionHz); // 125 ms at 8 Hz
const HEARTBEAT_MS = 20_000;

export class PresenceClient {
  status: PresenceStatus = 'off';
  /** Our own Habitica ID once `ready`. */
  self: string | null = null;
  private socket: SocketLike | null = null;
  private lease: string | null = null;
  private ready = false;
  private attempts = 0;
  private retryTimer: unknown = null;
  /** The area we want to be in (null: none) and the one last sent. */
  private area: string | null = null;
  private sentArea: string | null = null;
  private lastJoinAt = -Infinity;
  private joinTimer: unknown = null;
  /** Position pacing: the last sent, the latest wanted, and its timer. */
  private lastPosAt = -Infinity;
  private lastPos: PresencePosition | null = null;
  private pendingPos: PresencePosition | null = null;
  private posTimer: unknown = null;
  private lastEmoteAt = -Infinity;
  private lastSentAt = 0;
  private heartbeatTimer: unknown = null;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly handlers: PresenceHandlers;
  private readonly opts: PresenceClientOptions;

  constructor(opts: PresenceClientOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
    this.random = opts.random ?? Math.random;
    this.handlers = opts.handlers ?? {};
  }

  /** Connect (or reconnect) with this lease. A different lease restarts the socket. */
  start(lease: string): void {
    if (this.lease === lease && this.socket && this.status !== 'off') return;
    this.stop();
    this.lease = lease;
    this.attempts = 0;
    this.open();
  }

  /** Close for good (lease lost, sign-out, leaving connected play). */
  stop(): void {
    this.lease = null;
    this.clearTimers();
    this.ready = false;
    this.sentArea = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000, 'disconnected');
      } catch {
        /* already closed */
      }
    }
    this.setStatus('off');
  }

  /** The area the hero is in now (null: somewhere presence doesn't cover). */
  setArea(area: string | null): void {
    const next = area && isPresenceArea(area) ? area : null;
    if (next !== this.area) {
      this.area = next;
      // A new area starts with no position until we say where we stand.
      this.lastPos = null;
      this.pendingPos = null;
    }
    this.flushJoin();
  }

  /**
   * Where the hero is, every frame or so. Sent at most `positionHz` while
   * moving; standing still sends one final stop. The latest sample inside a
   * cooldown goes out when it ends.
   */
  position(pos: PresencePosition): void {
    const sample: PresencePosition = {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      facing: normalFacing(pos.facing),
      moving: pos.moving,
    };
    if (!sample.moving && this.lastPos && !this.lastPos.moving && !this.pendingPos) {
      // Already told them we stopped; only a new spot is worth a message.
      if (sample.x === this.lastPos.x && sample.y === this.lastPos.y) return;
    }
    this.pendingPos = sample;
    this.flushPos();
  }

  /** Send an emote if the cooldown allows. Returns false when it would be dropped. */
  emote(id: string): boolean {
    if (!PRESENCE.emotes.includes(id)) return false;
    if (!this.ready || !this.sentArea) return false;
    const now = this.timers.now();
    if (now - this.lastEmoteAt < PRESENCE.emoteCooldownMs) return false;
    this.lastEmoteAt = now;
    this.send({ type: 'emote', id });
    return true;
  }

  /** Milliseconds until another emote is accepted (0 = now). */
  emoteWait(): number {
    return Math.max(0, PRESENCE.emoteCooldownMs - (this.timers.now() - this.lastEmoteAt));
  }

  // ------------------------------------------------------------ socket

  private open(): void {
    if (!this.lease) return;
    this.setStatus(this.attempts > 0 ? 'retrying' : 'connecting');
    let socket: SocketLike;
    try {
      socket = this.opts.makeSocket(this.opts.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || !this.lease) return;
      // The lease rides in the first message, never in the URL.
      this.raw({ type: 'auth', lease: this.lease });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.onMessage(ev.data);
    };
    socket.onerror = () => {
      /* onclose follows with the code */
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.sentArea = null;
      this.clearTimers();
      const action = closeAction(ev.code, ev.reason ?? '');
      if (action === 'retry' && this.lease) {
        this.scheduleRetry();
        return;
      }
      this.lease = null;
      this.setStatus(action === 'retry' ? 'off' : action, ev.code);
    };
  }

  private scheduleRetry(): void {
    this.attempts += 1;
    this.setStatus('retrying');
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null;
      if (this.lease) this.open();
    }, presenceBackoff(this.attempts, this.random));
  }

  private onMessage(data: unknown): void {
    let m: PresenceServerMessage;
    try {
      m = JSON.parse(String(data)) as PresenceServerMessage;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.attempts = 0;
        this.self = typeof m.habiticaId === 'string' ? m.habiticaId : null;
        this.setStatus('live');
        this.handlers.ready?.(this.self ?? '');
        this.armHeartbeat();
        // (Re)announce the area; the server may have resumed it, a join is harmless.
        this.flushJoin();
        break;
      case 'room':
        if (m.area !== this.sentArea || !Array.isArray(m.players)) return;
        this.handlers.room?.(m.area, m.players.filter((p) => p && typeof p.habiticaId === 'string'));
        // Peers see us right away, even standing still.
        this.announcePosition();
        break;
      case 'join':
        if (m.area !== this.sentArea || !m.player || typeof m.player.habiticaId !== 'string') return;
        this.handlers.join?.(m.area, m.player);
        break;
      case 'leave':
        if (typeof m.habiticaId === 'string') this.handlers.leave?.(m.habiticaId);
        break;
      case 'pos':
        if (typeof m.habiticaId !== 'string' || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
        this.handlers.pos?.(m.habiticaId, {
          x: m.x,
          y: m.y,
          facing: normalFacing(m.facing ?? { x: 0, y: 1 }),
          moving: m.moving === true,
        });
        break;
      case 'emote':
        if (typeof m.habiticaId === 'string' && PRESENCE.emotes.includes(m.id)) this.handlers.emote?.(m.habiticaId, m.id);
        break;
    }
  }

  // ------------------------------------------------------------ pacing

  private flushJoin(): void {
    if (this.joinTimer !== null) return;
    if (!this.ready || !this.area || this.area === this.sentArea) return;
    const wait = this.lastJoinAt + PRESENCE.joinCooldownMs - this.timers.now();
    if (wait > 0) {
      this.joinTimer = this.timers.set(() => {
        this.joinTimer = null;
        this.flushJoin();
      }, wait);
      return;
    }
    this.lastJoinAt = this.timers.now();
    this.sentArea = this.area;
    this.lastPos = null;
    this.send({ type: 'join', area: this.area });
  }

  /** After a room roster: make sure the room knows where we stand. */
  private announcePosition(): void {
    if (this.lastPos) return; // already told this room
    this.flushPos();
  }

  private flushPos(): void {
    if (this.posTimer !== null) return;
    if (!this.ready || !this.sentArea || this.sentArea !== this.area || !this.pendingPos) return;
    const wait = this.lastPosAt + POS_GAP - this.timers.now();
    if (wait > 0) {
      this.posTimer = this.timers.set(() => {
        this.posTimer = null;
        this.flushPos();
      }, wait);
      return;
    }
    const p = this.pendingPos;
    this.pendingPos = null;
    this.lastPosAt = this.timers.now();
    this.lastPos = p;
    this.send({ type: 'pos', x: p.x, y: p.y, facing: p.facing, moving: p.moving });
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.timers.clear(this.heartbeatTimer);
    const due = this.lastSentAt + HEARTBEAT_MS - this.timers.now();
    this.heartbeatTimer = this.timers.set(() => {
      this.heartbeatTimer = null;
      if (!this.ready) return;
      if (this.timers.now() - this.lastSentAt >= HEARTBEAT_MS - 50) this.send({ type: 'heartbeat' });
      this.armHeartbeat();
    }, Math.max(1_000, due));
  }

  private send(m: object): void {
    if (!this.ready) return;
    this.raw(m);
  }

  private raw(m: object): void {
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return;
    try {
      s.send(JSON.stringify(m));
      this.lastSentAt = this.timers.now();
    } catch {
      /* onclose will follow */
    }
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.joinTimer, this.posTimer, this.heartbeatTimer]) if (t !== null) this.timers.clear(t);
    this.retryTimer = this.joinTimer = this.posTimer = this.heartbeatTimer = null;
  }

  private setStatus(status: PresenceStatus, code?: number): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.status?.(status, code);
  }
}
