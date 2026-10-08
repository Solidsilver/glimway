/**
 * The tile grid every area is laid out on: the tile size in world px, the
 * terrain ids, and tile ↔ px conversions. Shared by the game and the
 * Wilds rules in src/lib (and mirrored by the server's 16-px tiles).
 */

/** World px per tile. */
export const TILE = 16

/** Tile ids used by the world builder; values are columns in the terrain sheet. */
export const TERRAIN = {
  grass_a: 0,
  grass_b: 1,
  grass_c: 2,
  flowers: 3,
  path_a: 4,
  path_b: 5,
  dirt: 6,
  sand: 7,
  water_a: 8,
  water_b: 9,
  bridge: 10,
  stone_a: 11,
  stone_b: 12,
  stone_crack: 13,
  wall_stone: 14,
  wall_moss: 15,
  roof: 16,
  roof_edge: 17,
  wall_house: 18,
  door: 19,
  window: 20,
  fence: 21,
  cobble: 22,
  cobble_moss: 23,
  planks: 24,
  planks_dark: 25
} as const

/** The px coordinate of a tile's middle, along one axis. */
export function tileMid(t: number): number {
  return t * TILE + TILE / 2
}

/** The px coordinate of a tile's bottom edge (where things standing on it have their feet). */
export function tileBottom(t: number): number {
  return (t + 1) * TILE
}

/** A tile's middle, in px. */
export function tileCenter(tx: number, ty: number): { x: number; y: number } {
  return { x: tileMid(tx), y: tileMid(ty) }
}

/** Where something standing on a tile has its feet: the middle of its bottom edge, in px. */
export function tileFeet(tx: number, ty: number): { x: number; y: number } {
  return { x: tileMid(tx), y: tileBottom(ty) }
}

/** The tile a px coordinate falls in, along one axis. */
export function tileAt(px: number): number {
  return Math.floor(px / TILE)
}

/** A tile's key in sets and maps: `"tx,ty"`. */
export function tileKey(tx: number, ty: number): string {
  return `${tx},${ty}`
}
