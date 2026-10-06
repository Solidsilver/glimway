/**
 * Presence feed (phase 6): the one presence socket for a connected session,
 * and the roster of other players it reports.
 *
 * - Runs only while the session's link holds the play lease (status online,
 *   a lease in hand). Losing it (takeover, sign-out, offline) closes the
 *   socket; a new lease starts it again. The client owns retries and
 *   terminal closes for a lease, so the feed's link checks never restart a
 *   stopped lease or cut a backoff short (review-6 #1, #2).
 * - The scene tells it the area (`setArea`, on every area change) and where
 *   the hero is (`position`, every frame; the client paces the wire).
 * - The renderer (entities/remote-players.ts) reads `peersIn(area)` each
 *   frame and listens for emotes on the bus.
 *
 * Presence is presentation only: nothing here touches the save, the economy
 * or gameplay. No Phaser here: the bus, link, socket and timers are injected,
 * so the feed runs under node --test.
 */
import { PresenceClient, type PresenceStatus, type SocketLike, type Timers } from '../lib/presence-client.ts'
import { PeerTrack } from '../lib/presence-interp.ts'
import type { PresenceAvatar, PresencePlayer, PresencePosition } from '../lib/presence.ts'
import { EV, type EmotePayload, type PresencePayload } from './event-names.ts'

/** Peers stay drawn this long after a leave, fading out. */
export const LEAVE_FADE_MS = 400
/** How often the feed re-checks the link (a lease can rotate without a status change). */
export const LINK_CHECK_MS = 2_000

export interface Peer {
  habiticaId: string
  displayName: string
  avatar: PresenceAvatar | null
  area: string
  track: PeerTrack
  /** Set when they left; the renderer fades them out, then they are dropped. */
  leftAt: number | null
}

/** The part of the server link the feed reads (Link implements it). */
export interface FeedLink {
  readonly active: boolean
  readonly status: string
  readonly lease: string | null
  beat(force?: boolean): Promise<void>
}

export interface FeedBus {
  on(event: string, fn: (...args: never[]) => void): unknown
  off(event: string, fn: (...args: never[]) => void): unknown
  emit(event: string, payload?: unknown): unknown
}

export interface FeedDeps {
  link: FeedLink
  bus: FeedBus
  url: string
  makeSocket: (url: string) => SocketLike
  /** Client timers (tests pin them); the link check uses `every`. */
  timers?: Timers
  every?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /** Clock for interpolation samples (ms). */
  now?: () => number
}

export class PresenceFeed {
  readonly client: PresenceClient
  private peers = new Map<string, Peer>()
  private area: string | null = null
  private poll: unknown = null
  private stopped = false
  private localPosition: { x: number; y: number } | null = null
  private readonly link: FeedLink
  private readonly bus: FeedBus
  private readonly now: () => number
  private readonly cancel: (handle: unknown) => void
  private readonly onLink = () => this.reconcile()

  constructor(deps: FeedDeps) {
    this.link = deps.link
    this.bus = deps.bus
    this.now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
    const every = deps.every ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
    this.cancel = deps.cancel ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
    this.client = new PresenceClient({
      url: deps.url,
      makeSocket: deps.makeSocket,
      timers: deps.timers,
      handlers: {
        status: (s) => this.onStatus(s),
        room: (area, players) => this.onRoom(area, players),
        join: (area, player) => this.upsert(area, player),
        leave: (id) => this.markLeft(id),
        pos: (id, pos) => this.onPos(id, pos),
        emote: (id, emote) => {
          const p = this.peers.get(id)
          if (p && p.leftAt === null && p.area === this.area) this.bus.emit(EV.emote, { habiticaId: id, id: emote } satisfies EmotePayload)
        },
        gift: (g) => this.bus.emit(EV.gift, g),
        witness: (w) => this.bus.emit(EV.witness, w)
      }
    })
    this.bus.on(EV.link, this.onLink)
    this.poll = every(() => this.reconcile(), LINK_CHECK_MS)
    this.reconcile()
  }

  /**
   * Socket on exactly while the lease is held. `start` is idempotent per
   * lease (the client keeps its backoff and its terminal latch), so this can
   * run on every link event and poll.
   */
  reconcile(): void {
    if (this.stopped) return
    const link = this.link
    if (link.active && link.status === 'online' && link.lease) this.client.start(link.lease)
    else if (this.client.status !== 'off') this.client.stop()
  }

  setArea(area: string | null): void {
    if (area !== this.area) {
      this.area = area
      // Everyone we knew was somewhere else now.
      this.peers.clear()
      this.publish()
    }
    this.client.setArea(area)
  }

  position(pos: PresencePosition): void {
    this.localPosition = { x: pos.x, y: pos.y }
    this.client.position(pos)
  }

  /** Emote if the cooldown allows; the local hero's bubble shows when it is sent. */
  emote(id: string): boolean {
    const sent = this.client.emote(id)
    if (sent) this.bus.emit(EV.emote, { habiticaId: null, id } satisfies EmotePayload)
    return sent
  }

  get live(): boolean {
    return this.client.status === 'live'
  }

  get currentArea(): string | null {
    return this.area
  }

  /** Whether player is currently in the same area without having left. */
  isNearby(habiticaId: string): boolean {
    if (!this.area) return false
    return Array.from(this.peers.values()).some((p) => p.habiticaId === habiticaId && p.area === this.area && p.leftAt === null)
  }

  /** Whether a live peer is within the server's pixel radius of our last position. */
  isWithin(habiticaId: string, radius: number): boolean {
    if (!this.area || !this.localPosition) return false
    const t = this.now()
    return Array.from(this.peers.values()).some((p) => {
      if (p.habiticaId !== habiticaId || p.leftAt !== null || p.area !== this.area) return false
      const at = p.track.at(t)
      return !!at && Math.hypot(at.x - this.localPosition!.x, at.y - this.localPosition!.y) <= radius
    })
  }

  /** Peers to draw in `area`, including ones fading out. */
  peersIn(area: string): Peer[] {
    const t = this.now()
    const out: Peer[] = []
    for (const [id, p] of this.peers) {
      if (p.leftAt !== null && t - p.leftAt > LEAVE_FADE_MS * 2) {
        this.peers.delete(id)
        continue
      }
      if (p.area === area) out.push(p)
    }
    return out
  }

  /** Players here now, standing within radius px of (x, y): who you could hand something to. */
  nearby(x: number, y: number, radius: number): { habiticaId: string; displayName: string }[] {
    if (!this.area) return []
    const t = this.now()
    const out: { habiticaId: string; displayName: string }[] = []
    for (const p of this.peers.values()) {
      if (p.leftAt !== null || p.area !== this.area) continue
      const at = p.track.at(t)
      if (at && Math.hypot(at.x - x, at.y - y) <= radius) out.push({ habiticaId: p.habiticaId, displayName: p.displayName })
    }
    return out
  }

  /** Close the socket and drop every timer and listener (session over, App unmount). */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.bus.off(EV.link, this.onLink)
    if (this.poll !== null) this.cancel(this.poll)
    this.poll = null
    this.client.stop()
    this.peers.clear()
    this.publish()
  }

  get running(): boolean {
    return !this.stopped
  }

  /** Read-only state for playtests. */
  debugState(): { status: PresenceStatus; area: string | null; peers: string[] } {
    return {
      status: this.client.status,
      area: this.area,
      peers: [...this.peers.values()].filter((p) => p.leftAt === null).map((p) => p.habiticaId)
    }
  }

  // ------------------------------------------------------------ roster

  private onStatus(status: PresenceStatus): void {
    // A dead socket can't vouch for anyone (a retrying one keeps them until
    // the reconnect roster says otherwise).
    if (status !== 'live' && status !== 'retrying') this.peers.clear()
    // The server says the lease or session is gone: let the link confirm it
    // now (its GET shows the takeover / sign-out screens) instead of waiting.
    if (status === 'superseded' || status === 'unauthorized') void this.link.beat(true)
    this.publish()
  }

  /** The authoritative roster for our room (after every join, including reconnects). */
  private onRoom(area: string, players: PresencePlayer[]): void {
    const seen = new Set<string>()
    for (const p of players) {
      seen.add(p.habiticaId)
      this.upsert(area, p)
    }
    for (const [id, p] of this.peers) if (!seen.has(id) && p.leftAt === null) this.markLeft(id)
    this.publish()
  }

  /**
   * Add or update a peer from a roster entry or join announcement. Its
   * position is current: an existing peer moves there (gliding, or snapping
   * on a long jump), and a null position means none is known, so the old
   * track is dropped rather than drawn stale (review-6 #3).
   */
  private upsert(area: string, player: PresencePlayer): void {
    if (player.habiticaId === this.client.self) return
    const existing = this.peers.get(player.habiticaId)
    const peer: Peer = existing && existing.area === area && existing.leftAt === null
      ? existing
      : { habiticaId: player.habiticaId, displayName: '', avatar: null, area, track: new PeerTrack(), leftAt: null }
    peer.displayName = (player.displayName || 'Traveller').slice(0, 60)
    peer.avatar = player.avatar ?? null
    if (player.pos) peer.track.push(player.pos, this.now())
    else if (!peer.track.empty) peer.track = new PeerTrack()
    this.peers.set(player.habiticaId, peer)
    this.publish()
  }

  private markLeft(id: string): void {
    const p = this.peers.get(id)
    if (!p || p.leftAt !== null) return
    p.leftAt = this.now()
    this.publish()
  }

  private onPos(id: string, pos: PresencePosition): void {
    const p = this.peers.get(id)
    if (!p || p.leftAt !== null) return
    p.track.push(pos, this.now())
  }

  private publish(): void {
    let here = 0
    for (const p of this.peers.values()) if (p.leftAt === null && p.area === this.area) here++
    this.bus.emit(EV.presence, { status: this.client.status, here } satisfies PresencePayload)
  }
}
