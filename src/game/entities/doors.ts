/**
 * Front doors (docs/design/indoors.md 2.4, 2.6): every room whose doorway
 * leads out to this area puts its door here, on the door tile the rooms data
 * names (`outside`). Face it and press: **Go in**. When the room's resident
 * is elsewhere on their cycle, the door says **Knock**, you hear where they
 * are, and you go in anyway: doors never latch. A shop (Silas's Yard) has
 * no knock: it's open whether or not he's behind the counter.
 */
import { ROOMS } from '../../lib/rooms'
import { tileBottom, tileMid } from '../../lib/tile'
import { bus, EV } from '../events'
import { residentIn, residentOf, residentPlace } from '../resident-cycle'
import { KNOCK_LINES } from '../knock-lines'
import { NPC_NAMES } from './npcs'
import type { Interactable, Interactables } from './interactables'
import type { WorldData } from '../worlds'

export interface DoorsDeps {
  world: WorldData
  interactables: Interactables
  /** Walk in (the scene fades and the room builds). */
  enter: (room: string) => void
}

/**
 * The front doors out to `area`, as interaction points: every room whose
 * doorway leads there, on its door tile (`outside`, in the area's content
 * tiles, placed by `where`; null leaves the door out).
 */
export function doorPoints(area: string, enter: (room: string) => void, where: (outside: { tx: number; ty: number }) => { tx: number; ty: number } | null = (t) => t): Interactable[] {
  const points: Interactable[] = []
  for (const room of ROOMS.rooms) {
    const door = room.doors.find((d) => d.kind === 'door' && d.to === area && d.outside)
    const at = door?.outside ? where(door.outside) : null
    if (!at) continue
    const who = residentOf(room.id)
    // A shop stays open while its keeper steps out (Silas's Yard: no knock line, so no knock).
    const out = () => who !== null && !!KNOCK_LINES[who] && !residentIn(room.id)
    points.push({
      id: `door:${room.id}`,
      x: tileMid(at.tx),
      y: tileBottom(at.ty) + 2,
      label: () => (out() ? `Knock at ${room.name}` : `Go into ${room.name}`),
      verb: () => (out() ? 'Knock' : 'Go in'),
      markerOffset: 30,
      activate: () => {
        if (who && out()) {
          const place = residentPlace(who)
          const knock = place ? KNOCK_LINES[who]?.[place.spot] : null
          if (knock) bus.emit(EV.toast, { text: `${NPC_NAMES[who]}, ${knock.from}: “${knock.line}”`, icon: 'speech', kind: 'info' })
        }
        enter(room.id)
      }
    })
  }
  return points
}

export class Doors {
  constructor(deps: DoorsDeps) {
    deps.interactables.register(this, doorPoints(deps.world.areaId, deps.enter))
  }
}
