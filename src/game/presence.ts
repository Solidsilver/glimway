/**
 * The one presence feed for this page (phase 6). The feed itself lives in
 * presence-feed.ts (no Phaser, testable); this wires it to the real bus,
 * WebSocket and page, and keeps the single running instance.
 *
 * App starts it when connected play begins and stops it when the App goes
 * away (unmount, hot reload) or a guest journey takes over. Guests never
 * have one.
 */
import type { SocketLike } from '../lib/presence-client.ts'
import { bus } from './events.ts'
import type { Link } from './link.ts'
import { PresenceFeed } from './presence-feed.ts'
import { expose } from './dev-hooks.ts'

export { LEAVE_FADE_MS, PresenceFeed, type Peer } from './presence-feed.ts'

let current: PresenceFeed | null = null

/** Start presence for a connected session's link (replacing any older feed). */
export function startPresence(link: Link): PresenceFeed | null {
  stopPresence()
  if (typeof WebSocket === 'undefined') return null
  current = new PresenceFeed({
    link,
    bus,
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    makeSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike
  })
  const feed = current
  // Read-only state for playtests.
  expose('__fsPresence', () => (feed.running ? feed.debugState() : { status: 'off', area: null, peers: [] }))
  return current
}

/** Close the socket and drop the feed's timers and bus listeners. */
export function stopPresence(): void {
  current?.stop()
  current = null
}

/** The running feed, if this is connected play. */
export function presence(): PresenceFeed | null {
  return current
}
