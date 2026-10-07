import Phaser from 'phaser'

export const FINGERSNAP_EXPANSION_BASE = '/assets/fingersnap/expansion/'

export const FINGERSNAP_EXPANSION_ATLASES = [
  'fingersnap-terrain',
  'fingersnap-foreground',
  'fingersnap-demo-walk',
  'fingersnap-enemies',
] as const

export interface FingersnapAnimationDefinition {
  key: string
  texture: string
  frames: string[]
  frameRate: number
  repeat: number
}

export interface FingersnapExpansionManifest {
  version: number
  baseUrl: string
  terrain: {
    texture: string
    image: string
    data: string
    runtimeTexture: string
    tileWidth: number
    tileHeight: number
    tiles: Record<string, string>
    note?: string
  }
  suggestedWorldTileSize: number
  suggestedCharacterHeight: number
  foregroundFrames: string[]
  characterFrames: string[]
  enemyFrames: string[]
}

/**
 * The manifest and animation definitions. The art comes packed
 * (./packed.ts): the walk, enemy and foreground atlases re-baked at their
 * largest on-screen size under their old texture keys, and the terrain as
 * the normalized runtime tileset `createFingersnapTerrain` used to build.
 */
export function preloadFingersnapExpansion(
  scene: Phaser.Scene,
  base: string = FINGERSNAP_EXPANSION_BASE,
): void {
  scene.load.json('fingersnap-expansion-manifest', `${base}manifest.json`)
  scene.load.json('fingersnap-expansion-animations', `${base}animations.json`)
}

export function createFingersnapAnimations(scene: Phaser.Scene): void {
  const definitions = scene.cache.json.get(
    'fingersnap-expansion-animations',
  ) as FingersnapAnimationDefinition[] | undefined
  for (const definition of definitions ?? []) {
    if (scene.anims.exists(definition.key) || !scene.textures.exists(definition.texture)) continue
    scene.anims.create({
      key: definition.key,
      frames: definition.frames.map((frame) => ({
        key: definition.texture,
        frame,
      })),
      frameRate: definition.frameRate,
      repeat: definition.repeat,
    })
  }
}

/**
 * The generator produced a 1254px sheet, not an evenly divisible 4x4 grid.
 * Named atlas rectangles are authoritative. Construct a uniform tileset for
 * Phaser rather than treating the PNG as 32px source cells. The build bakes
 * that tileset (scripts/build-atlases.ts) and it loads under the runtime key,
 * so this returns it; it only builds one from a loaded `fingersnap-terrain`
 * source atlas (none ships). Null when neither is there.
 */
export function createFingersnapTerrain(
  scene: Phaser.Scene,
  tileSize: number = 32,
): Phaser.Textures.Texture | null {
  const manifest = scene.cache.json.get(
    'fingersnap-expansion-manifest',
  ) as FingersnapExpansionManifest | undefined
  const key = manifest?.terrain.runtimeTexture ?? 'fingersnap-terrain-runtime'
  if (scene.textures.exists(key)) return scene.textures.get(key)
  if (!manifest || !scene.textures.exists('fingersnap-terrain')) return null
  const output = scene.textures.createCanvas(key, tileSize * 4, tileSize * 4)
  if (!output) throw new Error('Could not create Fingersnap terrain texture')
  const context = output.context
  context.imageSmoothingEnabled = false
  const source = scene.textures.get('fingersnap-terrain')
  for (let index = 0; index < 16; index++) {
    const name = manifest.terrain.tiles[index]
    const frame = source.get(name)
    context.drawImage(
      frame.source.image as CanvasImageSource,
      frame.cutX,
      frame.cutY,
      frame.cutWidth,
      frame.cutHeight,
      (index % 4) * tileSize,
      Math.floor(index / 4) * tileSize,
      tileSize,
      tileSize,
    )
  }
  output.refresh()
  return output
}

/**
 * Occluder texture origins depend on where they attach in the world. Keep
 * canopy depth anchored to its trunk/ground footpoint, not its top-left
 * corner. `addToScene` false leaves it off the display list (the caller
 * adds many at once: src/game/area/bulk.ts).
 */
export function placeFingersnapOccluder(
  scene: Phaser.Scene,
  frame: string,
  x: number,
  footY: number,
  displayWidth: number = 96,
  addToScene = true,
): Phaser.GameObjects.Image {
  const image = scene.make.image({ x, y: footY, key: 'fingersnap-foreground', frame }, addToScene)
  image.setOrigin(0.5, 1).setScale(displayWidth / image.width).setDepth(footY)
  return image
}
