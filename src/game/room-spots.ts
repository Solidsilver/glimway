/**
 * A room's spots (the rooms data's `spots`): the hearth, the sponge bowl,
 * the counting stool, the hoist, the library's shelves and table. Each
 * registers on the interactions path under its spot id (one id space across
 * all content: the quest `use` trigger names them, and the goal guide finds
 * them by id).
 *
 * Quests come first: a quest step that wants the spot (lane C's predictor)
 * gives its own dialogue, label and marker through `setSpotQuests`;
 * otherwise the spot does what it does (warm your hands, sit, open the
 * library panel on its shelves).
 */
import { bus, EV, type DialoguePayload } from './events'
import { openDialogue } from './dialogue'
import { sfx } from './sfx'
import type { SeatPose } from './seats'
import type { Session } from './session'
import type { Interactable, Interactables, MarkerKind } from './entities/interactables'
import type { RoomSpotId, WorldData } from './worlds'
import { TILE, tileBottom, tileMid } from '../lib/tile'

/** A quest's say about a spot (null throughout: no quest wants it now). */
export interface SpotQuests {
  talk(spot: string, session: Session): Omit<DialoguePayload, 'id'> | null
  label(spot: string, session: Session): string | null
  marker(spot: string, session: Session): MarkerKind
}

let quests: SpotQuests = { talk: () => null, label: () => null, marker: () => null }

/** Does the current quest point at this spot (its "!" marker)? Only then may its piece move or glow (docs/design/indoors.md 7.0). */
export function spotWanted(spot: string, session: Session): boolean {
  return quests.marker(spot, session) === 'quest'
}

/** Lane C's quest predictor answers for the spots (set once). */
export function setSpotQuests(q: SpotQuests): void {
  quests = q
}

/** The server mark that lights the reading lamp (A Seat by the Lamp). */
export const LAMP_MARK = 'library:lamp'

/** The reading room, whose lamp needs that oil. */
export const LIBRARY = 'in:village:library'

export interface RoomSpotsDeps {
  world: WorldData
  session: Session
  interactables: Interactables
  hero: () => { readonly isSeated: boolean; sit(pose: SeatPose): void; standUp(): void }
  /** Whether a resident stands in this room now (Finn's count line at the stool). */
  present: (id: string) => boolean
}

/**
 * A seat on the front edge of the furniture a spot stands on (the stool,
 * the window seat; at a table, the chair at the spot's own tile), facing
 * down, the seat's legs in view below.
 */
function seatAt(world: WorldData, spot: { tx: number; ty: number }, edge = 5): SeatPose {
  const f = world.room?.props.find((p) => spot.tx >= p.tx && spot.tx < p.tx + p.tw && spot.ty >= p.ty && spot.ty < p.ty + p.th)
  const baseY = tileBottom(f ? f.ty + f.th - 1 : spot.ty)
  const x = f && f.tw <= 2 ? (f.tx + f.tw / 2) * TILE : tileMid(spot.tx)
  return { x, y: baseY - edge, depth: baseY + 0.5, facing: 'down' }
}

export class RoomSpots {
  constructor(private deps: RoomSpotsDeps) {
    const room = deps.world.room
    if (!room) return
    const points: Interactable[] = []
    for (const [id, spot] of Object.entries(room.def.spots)) {
      const own = this.defaults(id as RoomSpotId, spot.label, spot)
      points.push({
        id: id as RoomSpotId,
        x: tileMid(spot.tx),
        y: tileBottom(spot.ty) - 4,
        label: () => quests.label(id, deps.session) ?? (typeof own.label === 'function' ? own.label() : own.label),
        verb: () => (quests.label(id, deps.session) ? null : own.verb ?? null),
        marker: () => quests.marker(id, deps.session),
        markerOffset: 22,
        activate: () => {
          const q = quests.talk(id, deps.session)
          if (q) return void openDialogue({ id, ...q })
          own.activate()
        }
      })
    }
    deps.interactables.register(this, points)
  }

  private say(id: string, speaker: string, lines: string[]): void {
    openDialogue({ id, speaker, lines })
  }

  private thought(text: string): void {
    bus.emit(EV.toast, { text, icon: 'sparkle', kind: 'thought' })
  }

  /** Sit (or stand back up). */
  private sit(pose: SeatPose, line?: string): void {
    const hero = this.deps.hero()
    if (hero.isSeated) return hero.standUp()
    hero.sit(pose)
    sfx('settle')
    if (line) this.thought(line)
  }

  private lampLit(): boolean {
    return this.deps.session.state.flags.includes(LAMP_MARK)
  }

  /** What each spot does when no quest wants it. */
  private defaults(id: RoomSpotId, label: string, spot: { tx: number; ty: number }): { label: string | (() => string); verb?: string; activate: () => void } {
    const seated = () => this.deps.hero().isSeated
    const seat = (line?: string) => ({ label: () => (seated() ? 'Stand up' : label), verb: 'Sit', activate: () => this.sit(seatAt(this.deps.world, spot), line) })
    switch (id) {
      case 'kitchen-hearth':
        // Standing here warms you (the seated mana bonus: ./room-kind.ts warmAt); the button says so.
        return { label, verb: 'Warm', activate: () => this.thought('You hold your hands to the oven mouth. The warmth gets into your knuckles and stays.') }
      case 'sponge-bowl':
        return { label, verb: 'Look', activate: () => this.say(id, 'The sponge bowl', ['A cloth over a crock bowl. Under it, something pale and patient that smells of beer.']) }
      case 'tallow-pot':
        return { label, verb: 'Look', activate: () => this.say(id, 'The tallow pot', ['Rendered fat, kept just soft over the coals. Hazel sells it by the dip, if you ask her.']) }
      case 'millstones':
        return { label, verb: 'Look', activate: () => this.say(id, 'The millstones', ['The runner stone turns on the bed stone, close enough to bruise a grain, never to touch. Flour dusts the eye.']) }
      case 'counting-stool':
        return seat(this.deps.present('finn') ? 'Finn counts under his breath, in time with the wheel. You lose the count before he does.' : 'You can hear the wheel from here, every paddle in turn.')
      case 'mill-hoist':
        return { label, verb: 'Look', activate: () => this.say(id, 'The sack hoist', ['A pulley on a beam over the hatch. The rope is kinked hard where it runs through the block, and nothing moves.']) }
      // The sections' shelves (3.3): the panel on that section's papers. (Donating is Elara's now.)
      case 'library-shelf':
        return { label, verb: 'Browse', activate: () => bus.emit(EV.libraryOpen, { focus: 'shelf', section: 'stories' }) }
      case 'shelf-histories':
        return { label, verb: 'Browse', activate: () => bus.emit(EV.libraryOpen, { focus: 'shelf', section: 'histories' }) }
      case 'shelf-recipes':
        return { label, verb: 'Browse', activate: () => bus.emit(EV.libraryOpen, { focus: 'shelf', section: 'recipes' }) }
      case 'shelf-field-notes':
        return { label, verb: 'Browse', activate: () => bus.emit(EV.libraryOpen, { focus: 'shelf', section: 'field-notes' }) }
      case 'reading-table':
        return {
          label: () => (seated() ? 'Stand up' : this.lampLit() ? label : 'Look at the table'),
          verb: 'Sit',
          activate: () => {
            if (seated()) return this.deps.hero().standUp()
            if (!this.lampLit()) return this.say(id, 'The reading table', ['Two chairs and a lamp with no oil in it. Too dark to read by.'])
            this.sit(seatAt(this.deps.world, spot, 2))
            bus.emit(EV.libraryOpen, { focus: 'read' })
          }
        }
      case 'reading-lamp':
        return {
          // Oiling it is the quest's (its label comes through setSpotQuests).
          label: 'Look at the lamp',
          verb: 'Look',
          activate: () => this.say(id, 'The reading lamp', this.lampLit() ? ['Lit, and trimmed low. Somebody paid for the oil.'] : ['A tin tag on the handle: “One glim the oil. Ledger. — M.H.”'])
        }
      // The nook: a plain seat, with a bench's seated regen.
      case 'reading-nook':
        return seat('Cushions, a lamp, and somebody’s book left open on them. The glass is cold.')
    }
  }
}
