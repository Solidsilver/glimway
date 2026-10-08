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
import { furnishingFor } from '../lib/furnishings.ts'
import { landDoor } from './homeland.ts'
import type { AreaKind, ExitDef, NpcId, NpcSpot, WorldData } from './worlds.ts'

/** A prop's footprint on the grid: one connected, rectangular group of its letter. */
export interface Footprint {
  /** Its catalogue piece (src/lib/furnishings.ts). */
  art: string
  char: string
  solid: boolean
  /** The facing the room gives it (none: by the wall it stands against, `wallFacing`). */
  facing?: 'front' | 'left' | 'right' | 'diag'
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
    for (const [name, s] of Object.entries(r.spots)) if (s.area === area) out.push({ id: r.id as NpcId, tx: s.tx, ty: s.ty, spot: name, ...(s.seated ? { seated: true } : {}) })
  return out
}

function exitFor(def: Room, door: RoomDoor): ExitDef {
  const [g] = groupsOf(def, door.at)
  if (!g) throw new Error(`[glimway] room ${def.id}: door ${door.id} has no "${door.at}" tiles`)
  // A stair names the floor it reaches; a doorway shows its chevron alone (the HUD already names the room).
  const label = door.kind === 'stair' ? (roomFor(door.to)?.name ?? null) : ''
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
      // Props stand on the floor (a back-wall row's prop on the wall). Only
      // walls are solid tiles: a piece blocks by its base (`bodies`, below).
      g.push(WALLS.has(c) || (prop && y <= 1) ? TERRAIN.planks_dark : c === ':' ? TERRAIN.cobble : TERRAIN.planks)
      s.push(WALLS.has(c) || (!!prop && y <= 1))
    }
    ground.push(g)
    solid.push(s)
  }
  const props: Footprint[] = def.props.flatMap((p) => groupsOf(def, p.char).map((g) => ({ art: p.art, char: p.char, solid: p.solid, ...(p.facing ? { facing: p.facing } : {}), ...g })))
  // The stairs climb along their wall at 45°; the floor above has a railed opening over them (7.0 rule 5).
  const stairs: Footprint[] = ['^', 'v'].flatMap((c) => groupsOf(def, c).map((g) => ({ art: c === '^' ? 'mill-stairs-diag-default' : 'loft-stair-opening-front-default', char: c, solid: false, ...g })))
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
    room,
    bodies: props.filter((p) => p.solid).map(baseBox)
  }
}

/** How far a piece's collision stays in from its base tiles' sides, and from their back (px). */
export const BASE_INSET = { side: 2, back: 4 }

/**
 * Where a piece touches the floor (7.0 rule 4): its catalogue base, the
 * tiles of its footprint it stands on (src/lib/furnishings.ts), drawn in a
 * little at the sides and the back so the hero can walk right up to it.
 * Tall pieces rise above it, and the hero walks behind them by draw order.
 * (A piece the catalogue doesn't know: its footprint's bottom row.)
 */
export function baseBox(f: Footprint): { x: number; y: number; w: number; h: number } {
  const b = furnishingFor(f.art)?.base ?? { x: 0, y: f.th - 1, w: f.tw, h: 1 }
  return {
    x: (f.tx + b.x) * TILE + BASE_INSET.side,
    y: (f.ty + b.y) * TILE + BASE_INSET.back,
    w: b.w * TILE - BASE_INSET.side * 2,
    h: b.h * TILE - BASE_INSET.back
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

/** A room's hearths: the spots that warm whoever stands at them (the kitchen's oven). */
const HEARTH_SPOTS = new Set(['kitchen-hearth'])
/** How near the hero's feet must be: the action button's reach (./entities/interactables.ts). */
const HEARTH_REACH = 34

/**
 * Standing at a room's hearth (docs/design/indoors.md 3.1, "Warm your
 * hands"): the hero's feet within reach of its spot, where the action
 * button would warm them. The hero takes the seated mana bonus there.
 */
export function warmAt(world: WorldData, x: number, y: number): boolean {
  const spots = world.room?.def.spots
  if (!spots) return false
  return Object.entries(spots).some(([id, s]) => HEARTH_SPOTS.has(id) && Math.hypot(x - (s.tx + 0.5) * TILE, y - ((s.ty + 1) * TILE - 4)) < HEARTH_REACH)
}

/**
 * Which way a piece faces by where it stands (7.0 rule 1): a narrow piece
 * against a side wall is side-on, facing into the room; anything else
 * faces front.
 */
export function wallFacing(world: Pick<WorldData, 'width'>, f: Footprint): 'front' | 'left' | 'right' {
  if (f.tw === 1 && f.th > 1 && f.tx <= 1) return 'right'
  if (f.tw === 1 && f.th > 1 && f.tx + f.tw >= world.width - 1) return 'left'
  return 'front'
}
