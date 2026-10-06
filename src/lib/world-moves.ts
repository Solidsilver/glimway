/**
 * Moving to another world (docs/expansion-design.md "Worlds"): what keeps a
 * move from starting, checked in the browser before asking the server, which
 * checks the same things again (server/internal/api/worlds.go).
 */

/** Where a move may start (the server's rules.SafeAreas). Homesteads don't count. */
export const MOVE_AREAS: readonly string[] = ['village', 'commons']

/**
 * - `offline`: no connection (or another device holds the lease);
 * - `pending`: an earlier request's answer is still unknown;
 * - `area`: not in the village or the Commons;
 * - `mail`: parcels you sent are still on the road (recall them first);
 * - `cooldown`: you moved less than a day ago (`opensAt`, unix seconds, is
 *   when the next move is allowed; 0 or past: now).
 */
export type MoveBlock = 'offline' | 'pending' | 'area' | 'mail' | 'cooldown'

export function moveBlocks(o: { area: string; outgoing: number; online: boolean; pending: boolean; opensAt?: number; now?: number }): MoveBlock[] {
  const out: MoveBlock[] = []
  if (!o.online) out.push('offline')
  if (o.pending) out.push('pending')
  if ((o.opensAt ?? 0) > (o.now ?? Date.now() / 1000)) out.push('cooldown')
  if (!MOVE_AREAS.includes(o.area)) out.push('area')
  if (o.outgoing > 0) out.push('mail')
  return out
}

/**
 * A refused move, in the move screen's terms. `here`: already in that world
 * (another device moved first), so the page steps in; `retry`: a passing
 * refusal (busy, stale, taken over) that a second try may clear.
 */
export function moveRefusal(code: string): 'area' | 'mail' | 'cooldown' | 'offline' | 'pending' | 'retry' | 'here' | 'denied' | 'failed' {
  switch (code) {
    case 'move-cooldown':
      return 'cooldown'
    case 'not-at-safe-boundary':
      return 'area'
    case 'mail-in-flight':
      return 'mail'
    case 'offline':
      return 'offline'
    case 'pending':
    case 'resolved':
      return 'pending'
    case 'busy':
    case 'stale-revision':
    case 'superseded':
      return 'retry'
    case 'already-in-world':
      return 'here'
    case 'world-access-denied':
    case 'world-not-found':
      return 'denied'
    default:
      return 'failed'
  }
}
