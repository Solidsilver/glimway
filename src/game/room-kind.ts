/**
 * Rooms as areas (docs/design/indoors.md 2): the `in:` area family. A
 * village room (`in:village:bakery`, `in:village:mill:2`) is built from its
 * row in the rooms data: the ground and solid grids from its map, props
 * from their footprints, exits from its doorway and stairs, its spots and
 * light pools; the room's art and lights are drawn by ./area/room-art.ts.
 * A cottage (`in:home:<gate>`) keeps its own builder (./cottage.ts).
 *
 * Entering a room is an ordinary area change: the save names the room, the
 * report carries it, presence switches to its room, and a reload comes back
 * inside.
 */
import { roomFootprints, roomFor, type Room, type RoomDoor } from '../lib/rooms.ts'
import { RESIDENTS } from '../lib/residents.ts'
import { TERRAIN, TILE } from '../lib/tile.ts'
import { buildRoom, parseHomeRoom } from './cottage.ts'
import { landDoor } from './homeland.ts'
import type { AreaKind, ExitDef, NpcId, NpcSpot, WorldData } from './worlds.ts'

/** A prop's footprint on the grid: one connected, rectangular group of its letter. */
export interface Footprint {
  art: string
  char: string
  solid: boolean
  tx: number
  ty: number
  tw: number
  th: number
}

/** What the room layer draws from (WorldData.room). */
export interface RoomScene {
  def: Room
  props: Footprint[]
  /** The stair groups (`^`, `v`), drawn with the kit's stair art. */
  stairs: Footprint[]
  /** The doorway gap in the near wall (null: a floor with no way out but stairs). */
  doorway: Footprint | null
  /** Where you arrive through the front door (`@`). */
  arrive: { tx: number; ty: number }
}

const WALLS = new Set(['#', '=', 'w'])
const GROUND = new Set(['#', '=', 'w', '.', ':', 'D', '^', 'v', '@'])

/**
 * Every connected group of `char` on a room's map, as its rectangle (the
 * loader has checked each is one: a prop's art stands on its whole
 * footprint; a hand-made room that isn't throws).
 */
export function groupsOf(room: Room, char: string): { tx: number; ty: number; tw: number; th: number }[] {
  return roomFootprints(room, char).map(({ tx, ty, tw, th }) => {
    if (!tw) throw new Error(`[glimway] room ${room.id}: "${char}" at ${tx},${ty} isn't a rectangle`)
    return { tx, ty, tw, th }
  })
}

type Side = RoomDoor['side']

/** The compass direction of a side, as a unit facing. */
function toward(side: Side): { x: number; y: number } {
  return side === 'north' ? { x: 0, y: -1 } : side === 'south' ? { x: 0, y: 1 } : side === 'west' ? { x: -1, y: 0 } : { x: 1, y: 0 }
}

/**
 * Which way the hero faces arriving through an exit (src/lib/rooms.ts):
 * out through a doorway in the `side` wall, facing on that way, away from
 * the door; off a stair, whose `side` is the side you step onto it from,
 * facing the other way, off the stair on the floor you reach.
 */
export function facingFor(exit: { side: Side; kind?: 'edge' | 'door' | 'stair' }): { x: number; y: number } {
  const f = toward(exit.side)
  return exit.kind === 'stair' ? { x: -f.x || 0, y: -f.y || 0 } : f
}

/** The residents whose cycle has a spot in this area (each stands there only while the cycle says so: ./resident-cycle.ts). */
export function residentSpotsIn(area: string): NpcSpot[] {
  const out: NpcSpot[] = []
  for (const r of RESIDENTS.residents)
    for (const [name, s] of Object.entries(r.spots)) if (s.area === area) out.push({ id: r.id as NpcId, tx: s.tx, ty: s.ty, spot: name })
  return out
}

function exitFor(def: Room, door: RoomDoor): ExitDef {
  const [g] = groupsOf(def, door.at)
  if (!g) throw new Error(`[glimway] room ${def.id}: door ${door.id} has no "${door.at}" tiles`)
  const label = door.kind === 'stair' ? (roomFor(door.to)?.name ?? null) : undefined
  return { ...g, to: door.to, entry: { ...door.entry }, side: door.side, kind: door.kind, ...(label === undefined ? {} : { label }) }
}

/** A village room's WorldData, from its row in the rooms data. */
export function buildRoomArea(def: Room): WorldData {
  const H = def.map.length
  const W = def.map[0].length
  const propChars = new Map(def.props.map((p) => [p.char, p]))
  const ground: number[][] = []
  const solid: boolean[][] = []
  let arrive = { tx: Math.floor(W / 2), ty: H - 2 }
  for (let y = 0; y < H; y++) {
    const g: number[] = []
    const s: boolean[] = []
    for (let x = 0; x < W; x++) {
      const c = def.map[y][x]
      if (c === '@') arrive = { tx: x, ty: y }
      const prop = propChars.get(c)
      if (!prop && !GROUND.has(c)) throw new Error(`[glimway] room ${def.id}: "${c}" at ${x},${y} is in no legend or prop`)
      // Props stand on the floor (a back-wall row's prop on the wall).
      g.push(WALLS.has(c) || (prop && y <= 1) ? TERRAIN.planks_dark : c === ':' ? TERRAIN.cobble : TERRAIN.planks)
      s.push(WALLS.has(c) || (prop ? prop.solid : false))
    }
    ground.push(g)
    solid.push(s)
  }
  const props: Footprint[] = def.props.flatMap((p) => groupsOf(def, p.char).map((g) => ({ art: p.art, char: p.char, solid: p.solid, ...g })))
  const stairs: Footprint[] = ['^', 'v'].flatMap((c) => groupsOf(def, c).map((g) => ({ art: c === '^' ? 'stairs-up' : 'stairs-down', char: c, solid: false, ...g })))
  const [door] = groupsOf(def, 'D')
  const room: RoomScene = { def, props, stairs, doorway: door ? { art: 'doorway', char: 'D', solid: false, ...door } : null, arrive }
  return {
    areaId: def.id,
    width: W,
    height: H,
    widthPx: W * TILE,
    heightPx: H * TILE,
    ground,
    solid,
    trees: [],
    bushes: [],
    rocks: [],
    npcs: residentSpotsIn(def.id),
    enemies: [],
    exits: def.doors.map((d) => exitFor(def, d)),
    props: [],
    discoverySpots: [],
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    emberSpots: [],
    spawn: { ...arrive },
    room
  }
}

/** The area kind for an `in:` id (null for any other id, or a room this build doesn't know). */
export function roomKind(id: string): AreaKind | null {
  const gate = parseHomeRoom(id)
  if (gate !== null) {
    return { build: () => buildRoom(gate, landDoor().doorstep), foreground: () => [] }
  }
  const def = roomFor(id)
  return def ? { build: () => buildRoomArea(def), foreground: () => [] } : null
}

/** Where you arrive coming in through a room's front door (its `@`), facing in. */
export function roomArrival(id: string): { tx: number; ty: number } | null {
  const def = roomFor(id)
  if (!def) return null
  for (let y = 0; y < def.map.length; y++) {
    const x = def.map[y].indexOf('@')
    if (x >= 0) return { tx: x, ty: y }
  }
  return null
}
