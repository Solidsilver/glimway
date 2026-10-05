/**
 * Area construction — ground. Paints a WorldData terrain grid into one
 * canvas texture (one image, one draw surface, crisp nearest-neighbor).
 */
import type Phaser from 'phaser'
import { TERRAIN, TILE } from '../textures'
import type { WorldData } from '../worlds'

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

export function buildGround(scene: Phaser.Scene, world: WorldData): void {
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
  const canvas = document.createElement('canvas')
  canvas.width = world.widthPx
  canvas.height = world.heightPx
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const id = world.ground[y][x]
      const draw = (name: string) => {
        const idx = tileIndex[name] ?? 0
        ctx.drawImage(sheet, (idx % cols) * cell, Math.floor(idx / cols) * cell, cell, cell, x * TILE, y * TILE, TILE, TILE)
      }
      if (id === TERRAIN.bridge) draw('pond-water')
      draw(TERRAIN_TO_EXPANSION[id] ?? 'grass')
    }
  }
  const key = `ground-${world.areaId}`
  if (scene.textures.exists(key)) scene.textures.remove(key)
  scene.textures.addCanvas(key, canvas)
  scene.add.image(0, 0, key).setOrigin(0, 0).setDepth(-10)
}
