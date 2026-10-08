import Phaser from 'phaser'

const EXPANSION_BASE = '/assets/fingersnap/expansion/'

export interface GlimwayAnimationDefinition {
  key: string
  texture: string
  frames: string[]
  frameRate: number
  repeat: number
}

export interface GlimwayExpansionManifest {
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
 * the normalized runtime tileset `createGlimwayTerrain` used to build.
 */
export function preloadGlimwayExpansion(
  scene: Phaser.Scene,
  base: string = EXPANSION_BASE,
): void {
  scene.load.json('glimway-expansion-manifest', `${base}manifest.json`)
  scene.load.json('glimway-expansion-animations', `${base}animations.json`)
}

export function createGlimwayAnimations(scene: Phaser.Scene): void {
  const definitions = scene.cache.json.get(
    'glimway-expansion-animations',
  ) as GlimwayAnimationDefinition[] | undefined
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
 * Occluder texture origins depend on where they attach in the world. Keep
 * canopy depth anchored to its trunk/ground footpoint, not its top-left
 * corner. `addToScene` false leaves it off the display list (the caller
 * adds many at once: src/game/area/bulk.ts).
 */
export function placeGlimwayOccluder(
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
