/**
 * Which area a build of the world scene plays, and where the hero arrives:
 * the open map (`outdoors`: the save keeps world pixels; the hero stands there,
 * or on the nearest open tile if the land turned; the Turning says so once
 * the Wilds are read), or a registered area (rooms included: `in:…`). A save
 * in an area this build can't draw comes back in at the Commons arch (the
 * anchor `hearthwick:arch`, on the open map).
 */
import { tileCenter } from '../../lib/tile'
import { anchorTile } from '../wilds/fixed'
import { OUTDOORS_AREA } from '../wilds/coords'
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
    const at = anchorTile('hearthwick:arch')
    state.area = OUTDOORS_AREA
    state.position = tileCenter(at.tx, at.ty)
    entry = { ...at }
    session.saveSoon()
  }
  const world = buildArea(state.area)
  return { world, entry }
}
