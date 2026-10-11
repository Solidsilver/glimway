/**
 * Which area a build of the world scene plays, and where the hero arrives:
 * the open map (`wilds`: the save keeps world pixels; the hero stands there,
 * or on the nearest open tile if the land turned; the Turning says so once
 * the Wilds are read), or a registered area (rooms included: `in:…`). A save
 * in an area this build can't draw comes back in at the Commons arch.
 */
import { tileCenter } from '../../lib/tile'
import { COMMONS_FROM_WILDS } from '../commons'
import { homesteadsFor } from '../homestead'
import type { Session } from '../session'
import { buildArea, hasAreaKind, type WorldData } from '../worlds'

export interface Arrival {
  world: WorldData
  /** Where the hero stands (null: the save's position). */
  entry: { tx: number; ty: number } | null
}

export function arrive(
  session: Session,
  asked: { entry: Arrival['entry'] }
): Arrival {
  const state = session.state
  let { entry } = asked
  // Homestead lands read the session's homestead state (world, cleared tiles, desolation).
  homesteadsFor(session)
  // A save (or a server relocation) in an area this build can't draw comes
  // back in at the Commons arch.
  if (!hasAreaKind(state.area)) {
    const back = hasAreaKind('commons') ? { area: 'commons', at: COMMONS_FROM_WILDS } : { area: 'village', at: { tx: 7, ty: 11 } }
    state.area = back.area
    state.position = tileCenter(back.at.tx, back.at.ty)
    entry = { ...back.at }
    session.saveSoon()
  }
  const world = buildArea(state.area)
  return { world, entry }
}
