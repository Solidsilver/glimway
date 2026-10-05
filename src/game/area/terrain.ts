/**
 * Area construction — ground. Paints a WorldData terrain grid into canvas
 * textures, one per bounded chunk (crisp nearest-neighbor).
 */
import type Phaser from 'phaser'
import { TERRAIN, TILE } from '../textures.ts'
import type { WorldData } from '../worlds.ts'
import { buildTangleGround } from '../wilds/tangle-art.ts'

/**
 * Explicit mapping from procedural terrain ids to the delivered expansion's
 * named tiles (indexed by order in the expansion manifest). The runtime
 * tileset is a normalized 4x4 sheet of 32px cells drawn into 16px world tiles.
 */
const TERRAIN_TO_EXPANSION: Record<number, string> = {
  [TERRAIN.grass_a]: 'grass',
  [TERRAIN.grass_b]: 'forest-moss',
  [TERRAIN.grass_c]: 'grass',
  [TERRAIN.flowers]: 'flower-grass',
  [TERRAIN.path_a]: 'packed-dirt',
  [TERRAIN.path_b]: 'packed-dirt',
  [TERRAIN.dirt]: 'packed-dirt',
  [TERRAIN.sand]: 'packed-dirt',
  [TERRAIN.water_a]: 'pond-water',
  [TERRAIN.water_b]: 'pond-water',
  [TERRAIN.bridge]: 'wood-planks',
  [TERRAIN.stone_a]: 'cobblestone',
  [TERRAIN.stone_b]: 'cobblestone',
  [TERRAIN.stone_crack]: 'mossy-cobblestone',
  [TERRAIN.wall_stone]: 'shrine-stone',
  [TERRAIN.wall_moss]: 'mossy-cobblestone',
  [TERRAIN.roof]: 'dark-wood-planks',
  [TERRAIN.roof_edge]: 'dark-wood-planks',
  [TERRAIN.wall_house]: 'wood-planks',
  [TERRAIN.door]: 'dark-wood-planks',
  [TERRAIN.window]: 'dark-wood-planks',
  [TERRAIN.fence]: 'wood-planks',
  [TERRAIN.cobble]: 'cobblestone',
  [TERRAIN.cobble_moss]: 'mossy-cobblestone',
  [TERRAIN.planks]: 'wood-planks',
  [TERRAIN.planks_dark]: 'dark-wood-planks'
}

/**
 * The ground is drawn in chunks no larger than this many tiles a side, so a
 * big map (a Commons with many plots) never asks the GPU for a texture past
 * its size limit (often 4096 or 8192 px). 64 tiles = 1024 px.
 */
export const GROUND_CHUNK_TILES = 64

/** Tile rectangles covering a map in chunks of at most `max` tiles a side. */
export function groundChunks(width: number, height: number, max = GROUND_CHUNK_TILES): { tx: number; ty: number; tw: number; th: number }[] {
  const out: { tx: number; ty: number; tw: number; th: number }[] = []
  for (let ty = 0; ty < height; ty += max) for (let tx = 0; tx < width; tx += max) out.push({ tx, ty, tw: Math.min(max, width - tx), th: Math.min(max, height - ty) })
  return out
}

export function buildGround(scene: Phaser.Scene, world: WorldData): void {
  // The Wilds paint their woods floor per pixel (ragged path edges, shade).
  if (world.groundStyle === 'tangle') return buildTangleGround(scene, world)
  const manifest = scene.cache.json.get('fingersnap-expansion-manifest') as {
    terrain: { tileWidth: number; tiles: Record<string, string> }
  } | null
  const tileIndex: Record<string, number> = {}
  if (manifest) {
    for (const [k, name] of Object.entries(manifest.terrain.tiles)) tileIndex[name] = Number(k)
  }
  const cell = manifest ? manifest.terrain.tileWidth : 32
  const cols = 4
  const sheet = scene.textures.get('fingersnap-terrain-runtime').getSourceImage() as HTMLCanvasElement
  groundChunks(world.width, world.height).forEach((c, i) => {
    const canvas = document.createElement('canvas')
    canvas.width = c.tw * TILE
    canvas.height = c.th * TILE
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    for (let y = c.ty; y < c.ty + c.th; y++) {
      for (let x = c.tx; x < c.tx + c.tw; x++) {
        const id = world.ground[y][x]
        const draw = (name: string) => {
          const idx = tileIndex[name] ?? 0
          ctx.drawImage(sheet, (idx % cols) * cell, Math.floor(idx / cols) * cell, cell, cell, (x - c.tx) * TILE, (y - c.ty) * TILE, TILE, TILE)
        }
        if (id === TERRAIN.bridge) draw('pond-water')
        draw(TERRAIN_TO_EXPANSION[id] ?? 'grass')
      }
    }
    const key = `ground-${world.areaId}-${i}`
    if (scene.textures.exists(key)) scene.textures.remove(key)
    scene.textures.addCanvas(key, canvas)
    scene.add.image(c.tx * TILE, c.ty * TILE, key).setOrigin(0, 0).setDepth(-10)
  })
}
