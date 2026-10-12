/**
 * Where the hero stands right now, for the world map (docs/design/world-map.md
 * 3). The save's position is written about once a second and can lag when a
 * panel opens; this is the scene's own sprite, published every frame (panels
 * up too) by the WorldScene that's running, and cleared when it shuts down.
 *
 * Read-only for everything else: no network, no save. The map samples it
 * while it's open (heroPosition) and falls back to the saved position before
 * a scene publishes, and while a move is under way (moveTo clears it).
 */

export interface MapPosition {
  /** The scene's area (WILDS_AREA out on the open map). */
  area: string
  /** The world the scene belongs to ('' for a guest). */
  world: string
  /** The scene's pixels (world pixels on the open map; 16 a tile). */
  x: number
  y: number
}

let current: MapPosition | null = null
let owner: object | null = null

/** The running scene says where its hero is (cheap: nothing changes when nothing moved). */
export function publishMapPosition(by: object, area: string, world: string, x: number, y: number): void {
  if (owner === by && current && current.area === area && current.world === world && current.x === x && current.y === y) return
  owner = by
  current = { area, world, x, y }
}

/** The scene is going: its position goes with it (a newer scene's stays). */
export function clearMapPosition(by: object): void {
  if (owner !== by) return
  owner = null
  current = null
}

/**
 * Where you are for the map: the scene's sample when it belongs to the
 * session's own area and world, else the save's position (before a scene
 * has said, or while a move is under way and the save already names the
 * next area).
 */
export function heroPosition(state: { area: string; position?: { x: number; y: number } | null }, world: string): Readonly<MapPosition> | null {
  const live = current
  if (live && live.area === state.area && live.world === world) return live
  return state.position ? { area: state.area, world, x: state.position.x, y: state.position.y } : null
}
