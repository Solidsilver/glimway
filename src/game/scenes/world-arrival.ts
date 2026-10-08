/**
 * Which area a build of the world scene plays, and where the hero arrives:
 * a Wilds chunk (the save keeps region-wide pixels; the chunk and the tile
 * come from them), or a registered area (rooms included: `in:…`). A save in
 * an area this build can't draw comes back in at the Commons arch.
 */
import { tileCenter } from '../../lib/tile'
import { COMMONS_FROM_WILDS } from '../commons'
import { homesteadsFor } from '../homestead'
import type { Session } from '../session'
import { buildArea, hasAreaKind, type WorldData } from '../worlds'
import { OUTER_REGION_ID, isWildsArea, regionOfState, wildsArrivalPosition, wildsSceneEntry } from '../wilds/regions'
import { ensureWildsAreaKinds, setActiveWildsRegion, wildsEpoch } from '../wilds/store'

export interface Arrival {
  world: WorldData
  /** The Wilds chunk and its arrival tile (null outside the Wilds). */
  wildsEntry: ReturnType<typeof wildsSceneEntry>
  /** Where the hero stands (null: the save's position). */
  entry: { tx: number; ty: number } | null
  /** The outer Wilds turned while you were away (the place you left is gone). */
  turnedAway: boolean
}

export function arrive(
  session: Session,
  asked: { entry: Arrival['entry']; turned: boolean }
): Arrival {
  const state = session.state
  let { entry } = asked
  // Wilds: the save's region (the Tangle, or past the crossing) is the one
  // this scene plays in; resolve the region-wide position into its chunk
  // area and a chunk-local arrival tile (see src/game/wilds/regions.ts).
  if (isWildsArea(state.area)) setActiveWildsRegion(regionOfState(state))
  // Back in the outer Wilds after they turned: the place you left is gone,
  // so you arrive at the region's entrance in the new epoch.
  let turnedAway = false
  if (isWildsArea(state.area) && regionOfState(state) === OUTER_REGION_ID) {
    const epoch = wildsEpoch()
    const season = epoch.season
    // This session's last outer season, or (first arrival after a load) the
    // epoch the server last recorded this place in.
    const seenSeason = state.outerSeason ? state.outerSeason !== season : false
    const recorded = !state.outerSeason && !!state.outerEpoch && !!epoch.id && state.outerEpoch !== epoch.id
    if (seenSeason || recorded) {
      turnedAway = !asked.turned
      state.position = wildsArrivalPosition(wildsEpoch())
    }
    state.outerSeason = season
  }
  // Homestead lands read the session's homestead state (world, cleared tiles, desolation).
  homesteadsFor(session)
  const wildsEntry = wildsSceneEntry(state, wildsEpoch())
  if (wildsEntry) ensureWildsAreaKinds(wildsEpoch())
  // A save (or a server relocation) in an area this build can't draw comes
  // back in at the Commons arch.
  if (!wildsEntry && !hasAreaKind(state.area)) {
    const back = hasAreaKind('commons') ? { area: 'commons', at: COMMONS_FROM_WILDS } : { area: 'village', at: { tx: 7, ty: 11 } }
    state.area = back.area
    state.position = tileCenter(back.at.tx, back.at.ty)
    entry = { ...back.at }
    session.saveSoon()
  }
  const world = wildsEntry ? buildArea(wildsEntry.areaId) : buildArea(state.area)
  return { world, wildsEntry, entry, turnedAway }
}
