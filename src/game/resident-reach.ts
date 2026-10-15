/**
 * Where a resident's hand-overs work. The server measures a keepsake's
 * return (Ada, Hazel) and a resident's sale (Hazel's kitchen) from the post
 * their cycle has them at, not from where their route has walked them
 * (server/internal/api item_rewards.go, market.go). Out on their route they
 * stop and talk, but offer those only within that reach; elsewhere they say
 * where to find them (H2 fix round, Sol's review finding 2).
 */
import { RESIDENT_REACH_TILES } from '../content/heirlooms'
import { residentAt } from '../lib/residents'
import { residentReaches, sellerReaches } from '../lib/items'
import { serverNow } from './clock'
import { bus, EV } from './events'
import type { Session } from './session'

/** Where the hero stands, as the server will see it (the save, with the hero's spot written in first). */
function here(session: Session): { area: string; x: number; y: number } {
  bus.emit(EV.notePosition)
  const s = session.state
  return { area: s.area, x: s.position.x, y: s.position.y }
}

/** The residents whose keepsake the server takes back by their post (nearResident). */
const RETURNS_AT_POST = new Set(['ada', 'hazel'])

/** Whether giving a keepsake back to this resident works from here, now. */
export function returnReaches(session: Session, id: string, now = serverNow()): boolean {
  if (!RETURNS_AT_POST.has(id)) return true
  const h = here(session)
  return residentReaches(id, RESIDENT_REACH_TILES, h.area, h.x, h.y, now)
}

/** Whether a seller's goods sell from here, now. */
export function sellsHere(session: Session, sellerId: string, now = serverNow()): boolean {
  const h = here(session)
  return sellerReaches(sellerId, h.area, h.x, h.y, now)
}

/** What they say instead, by the post their cycle has them at. */
const ELSEWHERE: Record<string, Record<string, string>> = {
  hazel: {
    hearthwick: 'Not out here, love. Find me by the square for that.',
    'in:village:bakery': 'Not by the oven, love. Find me at the worktable for that.'
  }
}

/** Their line for "not here": where to find them for a hand-over. */
export function elsewhereLine(id: string, now = serverNow()): string {
  const post = residentAt(id, now)
  return (post && ELSEWHERE[id]?.[post.area]) ?? 'Find me at my usual spot for that.'
}
