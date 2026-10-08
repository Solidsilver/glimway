/**
 * The residents on their shared hour (docs/design/indoors.md 4): where
 * Hazel and Finn are is a pure function of the server's clock (`cycleAt`
 * with `serverNow`), so everyone sees them in the same place. Nothing is
 * stored and nothing ticks; the scene only checks once a second whether
 * someone on screen should be somewhere else.
 *
 * At a change, someone you're watching walks to the door (a straight
 * two-leg path) and fades through it, or fades in at the door and walks to
 * their spot. If you weren't watching, they're simply where the clock says.
 * The walk is drawing only.
 *
 * The pure half (where someone is, which door they use, the path) has no
 * Phaser in it: tests run it, and the goal guide and the front doors ask it.
 */
import type Phaser from 'phaser'
import { roomFootprints, roomFor } from '../lib/rooms.ts'
import { RESIDENTS, residentAt, residentById, type ResidentSpot } from '../lib/residents.ts'
import { cycleAt } from '../lib/clock.ts'
import { tileBottom, tileFeet, tileMid } from '../lib/tile.ts'
import { serverNow } from './clock.ts'
import type { WorldData } from './worlds.ts'
import type { NpcEntity, Npcs } from './entities/npcs.ts'

/**
 * Where a resident is at `now` (Unix seconds, the server's clock): the
 * place from the shared loader (src/lib/residents.ts `residentAt`), with
 * its phase's spot name and when they move on; null for no such resident.
 */
export function residentPlace(id: string, now: number = serverNow()): (ResidentSpot & { spot: string; until: number }) | null {
  const def = residentById(id)
  const at = residentAt(id, now)
  if (!def || !at) return null
  const { spot, until } = cycleAt(def, now)
  return { ...at, spot, until }
}

/** The resident who lives in a room (its floors included), if any. */
export function residentOf(roomId: string): string | null {
  return RESIDENTS.residents.find((r) => r.home === roomId)?.id ?? null
}

/** Whether a room's resident is in (in the room or on one of its floors) at `now`. */
export function residentIn(roomId: string, now: number = serverNow()): boolean {
  const id = residentOf(roomId)
  if (!id) return false
  const at = residentPlace(id, now)
  return !!at && (at.area === roomId || at.area.startsWith(`${roomId}:`))
}

/**
 * The tile a resident leaves or arrives by in `area`, heading for (or coming
 * from) `other`: in a room, the doorway or stair that leads there (the
 * doorway when none does); outside, the doorstep of their home's front door
 * and the door tile they vanish into.
 */
export function doorFor(id: string, area: string, other: string): { step: { tx: number; ty: number }; door: { tx: number; ty: number } } | null {
  const room = roomFor(area)
  if (room) {
    const door = room.doors.find((d) => d.to === other) ?? room.doors.find((d) => other.startsWith(d.to) || d.to.startsWith(other)) ?? room.doors.find((d) => d.kind === 'door') ?? room.doors[0]
    if (!door) return null
    const [g] = roomFootprints(room, door.at)
    if (!g) return null
    // A doorway: from the tile inside it, out through the wall.
    if (door.kind !== 'stair') return { step: { tx: g.tx, ty: g.ty - 1 }, door: { tx: g.tx, ty: g.ty } }
    // A stair: from the floor on the side you step onto it from (its `side`), onto its nearest step.
    const x = door.side === 'west' ? g.tx : door.side === 'east' ? g.tx + g.tw - 1 : g.tx
    const y = door.side === 'north' ? g.ty : door.side === 'south' ? g.ty + g.th - 1 : g.ty + g.th - 1
    const step = { tx: x + (door.side === 'west' ? -1 : door.side === 'east' ? 1 : 0), ty: y + (door.side === 'north' ? -1 : door.side === 'south' ? 1 : 0) }
    return { step, door: { tx: x, ty: y } }
  }
  const home = residentById(id)?.home
  const front = home ? roomFor(home)?.doors.find((d) => d.kind === 'door' && d.to === area && d.outside) : null
  return front?.outside ? { step: { ...front.entry }, door: { ...front.outside } } : null
}

/** A straight two-leg walk (across, then up or down: the last leg meets a door head on), in feet px. */
export function twoLegs(from: { tx: number; ty: number }, to: { tx: number; ty: number }): { x: number; y: number }[] {
  return [tileFeet(to.tx, from.ty), tileFeet(to.tx, to.ty)]
}

export interface ResidentCycleDeps {
  world: WorldData
  npcs: Npcs
  reducedMotion: boolean
  /** A resident's collision body at their spot (off while they're elsewhere). */
  block: (tx: number, ty: number, on: boolean) => void
  /** Whether a point is on screen (a change you aren't watching just happens). */
  onScreen: (x: number, y: number) => boolean
}

export class ResidentCycle {
  private listeners: (() => void)[] = []
  private readonly scene: Phaser.Scene
  private readonly deps: ResidentCycleDeps

  constructor(scene: Phaser.Scene, deps: ResidentCycleDeps) {
    this.scene = scene
    this.deps = deps
    // Where the clock says, at once.
    for (const n of this.cycled()) this.place(n, this.due(n))
    scene.time.addEvent({ delay: 1000, loop: true, callback: () => this.check() })
  }

  /** Called after anyone comes or goes (the room's lights, the smoke outside). */
  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  private cycled(): NpcEntity[] {
    return this.deps.npcs.npcs.filter((n) => n.spot !== null)
  }

  /** Should this resident be standing here now? */
  private due(n: NpcEntity, now: number = serverNow()): boolean {
    const def = residentById(n.id)
    return !!def && cycleAt(def, now).spot === n.spot
  }

  private spotTile(n: NpcEntity): { tx: number; ty: number } | null {
    const s = n.spot ? residentById(n.id)?.spots[n.spot] : null
    return s ? { tx: s.tx, ty: s.ty } : null
  }

  private place(n: NpcEntity, present: boolean): void {
    this.deps.npcs.place(n, present)
    const t = this.spotTile(n)
    if (t) this.deps.block(t.tx, t.ty, present)
  }

  /** Once a second: anyone whose phase just changed comes or goes. */
  check(now: number = serverNow()): void {
    let changed = false
    for (const n of this.cycled()) {
      if (n.path) continue
      const due = this.due(n, now)
      if (due === n.present) continue
      changed = true
      const tile = this.spotTile(n)
      const where = residentPlace(n.id, now)
      const door = tile && where ? doorFor(n.id, this.deps.world.areaId, due ? (residentPlace(n.id, now - 120)?.area ?? where.area) : where.area) : null
      const watching = !!n.home && this.deps.onScreen(n.home.x, n.home.y) && !this.deps.reducedMotion
      if (!door || !tile || !watching) {
        this.place(n, due)
        continue
      }
      if (!due) {
        // Leaving: across and to the door, then through it.
        n.present = false
        this.deps.block(tile.tx, tile.ty, false)
        this.deps.npcs.walkPath(n, [...twoLegs(tile, door.step), tileFeet(door.door.tx, door.door.ty)], () => {
          this.scene.tweens.add({ targets: n.sprite, alpha: 0, duration: 320, onComplete: () => this.place(n, false) })
        })
      } else {
        // Arriving: in at the door, then across to the spot.
        n.sprite.setPosition(tileMid(door.door.tx), tileBottom(door.door.ty)).setAlpha(0).setVisible(true)
        this.scene.tweens.add({ targets: n.sprite, alpha: 1, duration: 320 })
        this.deps.npcs.walkPath(n, [tileFeet(door.step.tx, door.step.ty), ...twoLegs(door.step, tile)], () => this.place(n, true))
      }
    }
    if (changed) for (const fn of this.listeners) fn()
  }
}
