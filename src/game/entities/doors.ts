/**
 * Front doors (docs/design/indoors.md 2.4, 2.6): every room whose doorway
 * leads out to this area puts its door here, on the door tile the rooms data
 * names (`outside`). Face it and press: **Go in**. When the room's resident
 * is elsewhere on their cycle, the door says **Knock**, you hear where they
 * are, and you go in anyway: doors never latch.
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

export class Doors {
  constructor(deps: DoorsDeps) {
    const points: Interactable[] = []
    for (const room of ROOMS.rooms) {
      const door = room.doors.find((d) => d.kind === 'door' && d.to === deps.world.areaId && d.outside)
      if (!door?.outside) continue
      const who = residentOf(room.id)
      const out = () => who !== null && !residentIn(room.id)
      points.push({
        id: `door:${room.id}`,
        x: tileMid(door.outside.tx),
        y: tileBottom(door.outside.ty) + 2,
        label: () => (out() ? `Knock at ${room.name}` : `Go into ${room.name}`),
        verb: () => (out() ? 'Knock' : 'Go in'),
        markerOffset: 30,
        activate: () => {
          if (who && out()) {
            const at = residentPlace(who)
            const knock = at ? KNOCK_LINES[who]?.[at.spot] : null
            if (knock) bus.emit(EV.toast, { text: `${NPC_NAMES[who]}, ${knock.from}: “${knock.line}”`, icon: 'speech', kind: 'info' })
          }
          deps.enter(room.id)
        }
      })
    }
    deps.interactables.register(this, points)
  }
}
