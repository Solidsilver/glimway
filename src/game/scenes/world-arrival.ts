/**
 * Which area a build of the world scene plays, and where the hero arrives:
 * the open map (`wilds`: the save keeps world pixels; the hero stands there,
 * or on the nearest open tile if the land turned), or a registered area
 * (rooms included: `in:…`). A save in an area this build can't draw comes
 * back in at the Commons arch.
 */
import { tileCenter } from '../../lib/tile'
import { COMMONS_FROM_WILDS } from '../commons'
import { homesteadsFor } from '../homestead'
import type { Session } from '../session'
import { buildArea, hasAreaKind, type WorldData } from '../worlds'
import { chunkOfPixel, isWildsArea } from '../wilds/coords'
import { chunkEpoch } from '../wilds/store'

export interface Arrival {
  world: WorldData
  /** Where the hero stands (null: the save's position). */
  entry: { tx: number; ty: number } | null
  /** The Beyond turned while you were away (the land you left is new). */
  turnedAway: boolean
}

export function arrive(
  session: Session,
  asked: { entry: Arrival['entry']; turned: boolean }
): Arrival {
  const state = session.state
  let { entry } = asked
  // Back in the Beyond after it turned: the server recorded your place in
  // an older wick. You stand where you were (or the nearest open tile);
  // the land around you is new (decision 10).
  let turnedAway = false
  if (isWildsArea(state.area)) {
    const at = chunkOfPixel(state.position.x, state.position.y)
    const epoch = chunkEpoch(at.cx, at.cy)
    turnedAway = !asked.turned && !!epoch && epoch.kind === 'wick' && !!state.wickEpoch && state.wickEpoch !== epoch.id
  }
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
  return { world, entry, turnedAway }
}
