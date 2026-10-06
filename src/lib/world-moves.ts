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
 * - `mail`: parcels you sent are still on the road (recall them first).
 */
export type MoveBlock = 'offline' | 'pending' | 'area' | 'mail'

export function moveBlocks(o: { area: string; outgoing: number; online: boolean; pending: boolean }): MoveBlock[] {
  const out: MoveBlock[] = []
  if (!o.online) out.push('offline')
  if (o.pending) out.push('pending')
  if (!MOVE_AREAS.includes(o.area)) out.push('area')
  if (o.outgoing > 0) out.push('mail')
  return out
}

/** A refused move, in the move screen's terms. */
export function moveRefusal(code: string): MoveBlock | 'denied' | 'failed' {
  switch (code) {
    case 'not-at-safe-boundary':
      return 'area'
    case 'mail-in-flight':
      return 'mail'
    case 'offline':
    case 'superseded':
      return 'offline'
    case 'pending':
    case 'busy':
    case 'resolved':
    case 'stale-revision':
      return 'pending'
    case 'world-access-denied':
    case 'world-not-found':
    case 'already-in-world':
      return 'denied'
    default:
      return 'failed'
  }
}
