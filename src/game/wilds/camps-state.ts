import type { CampMember, CampView } from '../../lib/gen/glimway/v1/camps_pb.js'

/**
 * The world's camps as the open map last read them (./camps.ts writes it),
 * so the pack can offer to set a lamp, a piece or a seed down at the camp
 * you stand in. Read when the pack draws; not reactive. `people` are the
 * world's members, read only by a camp's keeper, to name in its rule.
 *
 * The list belongs to the world and account it was read for: asked for by
 * anyone else (a world move, another sign-in on the page), it is empty until
 * their own read, so no other world's camps are drawn or offered.
 */
export interface CampsKnown {
  list: CampView[]
  me: string | null
  people: CampMember[]
}

/** Whose camps: a link, or an operation's world and account. */
export interface CampsOwner {
  worldId: string
  accountId: string
}

const none = (): CampsKnown => ({ list: [], me: null, people: [] })
const ownerKey = (o: CampsOwner) => `${o.worldId}|${o.accountId}`

let owner = ''
let known = none()

/** The camps as read for `who`; empty for anyone else. */
export function campsKnown(who: CampsOwner | null | undefined): CampsKnown {
  return who && ownerKey(who) === owner ? known : none()
}

/** Keep what a read (or an answer) for `who` said; another owner's list is let go. */
export function adoptCamps(who: CampsOwner, next: Partial<CampsKnown>): void {
  const key = ownerKey(who)
  if (key !== owner) {
    owner = key
    known = none()
  }
  Object.assign(known, next)
}

/** Forget the camps (leaving the world). */
export function forgetCamps(): void {
  owner = ''
  known = none()
}
