/**
 * Inside a cottage: one room, a 12×10 floor (content/homestead.json
 * "indoor", the decoration grid) under a timber-framed back wall with the
 * hearth set into it, and the door in the near wall.
 *
 * The room is a view, not a save area: while you are inside, the save still
 * says you are on the homestead's land (`home:<gate>`), standing on the
 * doorstep, so a home rest by the hearth is a rest at your own place.
 * Reloading puts you outside your door.
 */
import { HOMESTEAD_DATA, homeArea } from '../lib/homestead.ts'
import { TERRAIN, TILE } from './textures.ts'
import type { WorldData } from './worlds.ts'

export const ROOM_COLS = HOMESTEAD_DATA.indoor.width + 2
export const ROOM_ROWS = HOMESTEAD_DATA.indoor.height + 4
/** Top-left tile of the decoration grid inside the room. */
export const ROOM_GRID = { tx: 1, ty: 3 }
/** The doorway in the near wall (two tiles), and where you stand coming in. */
export const ROOM_DOOR = { tx: 6, ty: ROOM_ROWS - 1 }
export const ROOM_ENTRY = { tx: 6, ty: ROOM_ROWS - 3 }
/**
 * The hearth in the back wall, right of the shelf: rest beside it (px; the
 * fire's centre is x + 8, its base fireY, the resting spot y).
 */
export const ROOM_HEARTH = { x: 173, y: 3 * TILE + 4, fireY: 42 }
/** Workshop (tier 2): the storage chest under the window, the bench under the shelf. */
export const ROOM_CHEST = { x: 40 }
export const ROOM_BENCH = { x: 115 }

export function buildRoom(gate: number, doorstep: { tx: number; ty: number }): WorldData {
  const W = ROOM_COLS
  const H = ROOM_ROWS
  const ground: number[][] = []
  const solid: boolean[][] = []
  for (let y = 0; y < H; y++) {
    const g: number[] = []
    const s: boolean[] = []
    for (let x = 0; x < W; x++) {
      const floor = x >= ROOM_GRID.tx && x < ROOM_GRID.tx + HOMESTEAD_DATA.indoor.width && y >= ROOM_GRID.ty && y < ROOM_GRID.ty + HOMESTEAD_DATA.indoor.height
      const door = y === H - 1 && (x === ROOM_DOOR.tx || x === ROOM_DOOR.tx + 1)
      g.push(floor || door ? TERRAIN.planks : TERRAIN.planks_dark)
      s.push(!floor && !door)
    }
    ground.push(g)
    solid.push(s)
  }
  return {
    areaId: 'cottage',
    width: W,
    height: H,
    widthPx: W * TILE,
    heightPx: H * TILE,
    ground,
    solid,
    trees: [],
    bushes: [],
    rocks: [],
    npcs: [],
    enemies: [],
    exits: [{ tx: ROOM_DOOR.tx, ty: ROOM_DOOR.ty, tw: 2, th: 1, to: homeArea(gate), entry: { ...doorstep }, label: null }],
    props: [],
    scenery: [{ key: 'room-walls', x: 0, y: H * TILE, originX: 0, depth: -5 }],
    discoverySpots: [],
    well: null,
    mural: null,
    shrine: null,
    villageLantern: null,
    emberSpots: [],
    spawn: { ...ROOM_ENTRY }
  }
}
