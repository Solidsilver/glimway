/**
 * The deed table, where joint deeds are signed (silas-yard.md 2.6): who
 * stands at it, who you could share your deed with, and which signatures
 * wait on you. Pell's talk and the Manage your deed panel
 * (src/ui/DeedPanel.svelte) both read it. The server checks the table
 * itself (`atTable`, server/internal/api/home_membership.go); this only
 * decides what to offer.
 *
 * The table is read in one place, `deedTable()`: `commons.deedTable`, in
 * Pell's office (pixels in the room's own map).
 */
import { HOMESTEAD_DATA } from '../lib/homestead.ts'
import type { DeedInvite, HomeView } from '../lib/api/types.ts'
import { presence, type Peer } from './presence.ts'
import { lotName, signText } from './homestead.ts'

export interface DeedTable {
  /** The presence area the table stands in. */
  area: string
  x: number
  y: number
  radius: number
}

/** Someone at the table (presence names them by their account id). */
export interface AtTable {
  id: string
  name: string
}

export function deedTable(): DeedTable {
  const t = HOMESTEAD_DATA.commons.deedTable
  return { area: t.area, x: t.x, y: t.y, radius: t.radius }
}

/** Whether a spot in an area is at the table. */
export function standsAtTable(area: string, at: { x: number; y: number }, t: DeedTable = deedTable()): boolean {
  return area === t.area && Math.hypot(at.x - t.x, at.y - t.y) <= t.radius
}

/** The peers at the table now (still in the room, within its radius), from a presence feed's view of its area. */
export function peersAtTable(peers: readonly Pick<Peer, 'accountId' | 'displayName' | 'leftAt' | 'track'>[], now: number, t: DeedTable = deedTable()): AtTable[] {
  const out: AtTable[] = []
  for (const p of peers) {
    if (p.leftAt !== null) continue
    const at = p.track.at(now)
    if (at && Math.hypot(at.x - t.x, at.y - t.y) <= t.radius) out.push({ id: p.accountId, name: p.displayName || 'A neighbour' })
  }
  return out
}

/** Who stands at the table right now (presence, this world), but you. */
export function atTable(): AtTable[] {
  const feed = presence()
  if (!feed) return []
  const t = deedTable()
  return peersAtTable(feed.peersIn(t.area), performance.now(), t)
}

/** Who could share your deed: whoever is at the table and not on it already. */
export function shareCandidates(here: readonly AtTable[], members: readonly { id: string }[]): AtTable[] {
  const on = new Set(members.map((m) => m.id))
  return here.filter((p) => !on.has(p.id))
}

/** A place's name on a sign or a deed: "Tansy’s Place", "Tansy & Bram’s Place", or the lot. */
export function deedPlaceName(home: Pick<HomeView, 'members'> | null, gate: number): string {
  if (!home || home.members.length === 0) return lotName(gate)
  if (home.members.length === 1) return signText(home.members[0].displayName || 'A neighbour')
  return `${home.members.map((m) => m.displayName || 'A neighbour').slice(0, 2).join(' & ')}’s Place`
}

/** The deed's offers as the panel shows them: yours waiting on the other signature, and those waiting on yours. */
export interface DeedOffers {
  /** Offers you made that the other has yet to sign, by their account id. */
  offered: Map<string, DeedInvite>
  /** Offers you made that they signed and your own signature has lapsed: sign again. */
  signBack: DeedInvite[]
  /** Someone else's deed offered to you (you sign it once you're off your own). */
  toMe: DeedInvite[]
}

/**
 * Sort the lane's live invites (`nowS`: Unix seconds) for the deed panel. A
 * signature counts within the confirm window; the second within it amends
 * the deed (`joint`, home_membership.go).
 */
export function deedOffers(invites: readonly DeedInvite[], me: string | null, homeId: string | null, nowS: number, windowS: number = HOMESTEAD_DATA.jointDeed.confirmWindowSeconds): DeedOffers {
  const out: DeedOffers = { offered: new Map(), signBack: [], toMe: [] }
  const fresh = (at: number | null) => at !== null && nowS - at <= windowS
  for (const i of invites) {
    if (i.expiresAt <= nowS) continue
    if (i.to.id === me) {
      out.toMe.push(i)
      continue
    }
    if (i.homeId !== homeId) continue
    if (fresh(i.toConfirmedAt) && !fresh(i.fromConfirmedAt)) out.signBack.push(i)
    else out.offered.set(i.to.id, i)
  }
  return out
}
