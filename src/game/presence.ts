/**
 * Presence feed (phase 6): the one presence socket for a connected session,
 * and the roster of other players it reports.
 *
 * - Runs only while the session's link holds the play lease (status online,
 *   a lease in hand). Losing it (takeover, sign-out, offline) closes the
 *   socket; a new lease restarts it. Guests never get a feed.
 * - The scene tells it the area (`setArea`, on every area change) and where
 *   the hero is (`position`, every frame; the client paces the wire).
 * - The renderer (entities/remote-players.ts) reads `peersIn(area)` each
 *   frame and listens for emotes on the bus.
 *
 * Presence is presentation only: nothing here touches the save, the economy
 * or gameplay.
 */
import { PresenceClient, type PresenceStatus, type SocketLike } from '../lib/presence-client'
import { PeerTrack } from '../lib/presence-interp'
import type { PresenceAvatar, PresencePlayer, PresencePosition } from '../lib/presence'
import { bus, EV, type EmotePayload, type PresencePayload } from './events'
import type { Link } from './link'

/** Peers stay drawn this long after a leave, fading out. */
export const LEAVE_FADE_MS = 400

export interface Peer {
  habiticaId: string
  displayName: string
  avatar: PresenceAvatar | null
  area: string
  track: PeerTrack
  /** Set when they left; the renderer fades them out, then they are dropped. */
  leftAt: number | null
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class PresenceFeed {
  readonly client: PresenceClient
  private peers = new Map<string, Peer>()
  private area: string | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readonly onLink = () => this.reconcile()

  constructor(
    private readonly link: Link,
    makeSocket: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike
  ) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    this.client = new PresenceClient({
      url,
      makeSocket,
      handlers: {
        status: (s) => this.onStatus(s),
        room: (area, players) => this.onRoom(area, players),
        join: (area, player) => this.upsert(area, player),
        leave: (id) => this.markLeft(id),
        pos: (id, pos) => this.onPos(id, pos),
        emote: (id, emote) => {
          const p = this.peers.get(id)
          if (p && p.leftAt === null && p.area === this.area) bus.emit(EV.emote, { habiticaId: id, id: emote } satisfies EmotePayload)
        }
      }
    })
    // Read-only state for playtests.
    ;(window as unknown as { __fsPresence?: () => unknown }).__fsPresence = () => ({
      status: this.client.status,
      area: this.area,
      peers: [...this.peers.values()].filter((p) => p.leftAt === null).map((p) => p.habiticaId)
    })
    bus.on(EV.link, this.onLink)
    // A lease can rotate without a status change (take over while online).
    this.poll = setInterval(() => this.reconcile(), 2_000)
    this.reconcile()
  }

  /** Socket on exactly while the lease is held. */
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
    this.client.position(pos)
  }

  /** Emote if the cooldown allows; the local hero's bubble shows either way it is sent. */
  emote(id: string): boolean {
    const sent = this.client.emote(id)
    if (sent) bus.emit(EV.emote, { habiticaId: null, id } satisfies EmotePayload)
    return sent
  }

  get live(): boolean {
    return this.client.status === 'live'
  }

  /** Peers to draw in `area`, including ones fading out. */
  peersIn(area: string): Peer[] {
    const t = now()
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

  stop(): void {
    this.stopped = true
    bus.off(EV.link, this.onLink)
    if (this.poll !== null) clearInterval(this.poll)
    this.poll = null
    this.client.stop()
    this.peers.clear()
    this.publish()
  }

  // ------------------------------------------------------------ roster

  private onStatus(status: PresenceStatus): void {
    if (status !== 'live') {
      // A dead or restarting socket can't vouch for anyone.
      if (status !== 'retrying') this.peers.clear()
    }
    // The server says the lease or session is gone: let the link confirm it
    // now (its GET shows the takeover / sign-out screens) instead of waiting.
    if (status === 'superseded' || status === 'unauthorized') void this.link.beat(true)
    this.publish()
  }

  private onRoom(area: string, players: PresencePlayer[]): void {
    const seen = new Set<string>()
    for (const p of players) {
      seen.add(p.habiticaId)
      this.upsert(area, p)
    }
    for (const [id, p] of this.peers) if (!seen.has(id) && p.leftAt === null) this.markLeft(id)
    this.publish()
  }

  private upsert(area: string, player: PresencePlayer): void {
    if (player.habiticaId === this.client.self) return
    const existing = this.peers.get(player.habiticaId)
    const peer: Peer = existing && existing.area === area && existing.leftAt === null
      ? existing
      : { habiticaId: player.habiticaId, displayName: '', avatar: null, area, track: new PeerTrack(), leftAt: null }
    peer.displayName = (player.displayName || 'Traveller').slice(0, 60)
    peer.avatar = player.avatar ?? null
    if (player.pos && peer.track.empty) peer.track.push(player.pos, now())
    this.peers.set(player.habiticaId, peer)
    this.publish()
  }

  private markLeft(id: string): void {
    const p = this.peers.get(id)
    if (!p || p.leftAt !== null) return
    p.leftAt = now()
    this.publish()
  }

  private onPos(id: string, pos: PresencePosition): void {
    const p = this.peers.get(id)
    if (!p || p.leftAt !== null) return
    p.track.push(pos, now())
  }

  private publish(): void {
    let here = 0
    for (const p of this.peers.values()) if (p.leftAt === null && p.area === this.area) here++
    bus.emit(EV.presence, { status: this.client.status, here } satisfies PresencePayload)
  }
}

// ---------------------------------------------------------------- the one feed

let current: PresenceFeed | null = null

/** Start presence for a connected session's link (replacing any older feed). */
export function startPresence(link: Link): PresenceFeed | null {
  stopPresence()
  if (typeof WebSocket === 'undefined') return null
  current = new PresenceFeed(link)
  return current
}

export function stopPresence(): void {
  current?.stop()
  current = null
}

/** The running feed, if this is connected play. */
export function presence(): PresenceFeed | null {
  return current
}
