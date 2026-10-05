import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'

/**
 * Typed port of `assets/generated/runtime-pass/integration.js` (art/content
 * agent). The source PNGs are high-resolution sheets with individually
 * measured rectangles — never load them as evenly spaced spritesheets. They
 * stay in assets/generated/; the build bakes their native frames into a
 * packed atlas (scripts/build-atlases.ts). This module builds exact
 * native-size canvas textures (NPCs 16x16 and guardian
 * 24x24 at a bottom-center foot anchor, effects center-anchored) and the
 * manifest-driven animations/aliases. Source PNGs are never modified.
 *
 * Wiring in BootScene/WorldScene (combat states, collisions, facing flips)
 * is runtime-agent work and lives outside this module.
 */

export const RUNTIME_ART_BASE = '/assets/fingersnap/runtime-pass/'

export const RUNTIME_ART_MANIFEST_KEY = 'fingersnap-runtime-art'

export const RUNTIME_ART_SOURCE_KEYS = [
  'fingersnap-npcs',
  'fingersnap-guardian',
  'fingersnap-class-effects',
] as const

export interface RuntimeArtRect {
  x: number
  y: number
  w: number
  h: number
}

export interface RuntimeArtSource {
  key: string
  file: string
  width: number
  height: number
}

export type RuntimeArtRole = 'npc' | 'guardian' | 'effect'

export interface RuntimeArtFrame {
  key: string
  source: string
  sourceRect: RuntimeArtRect
  width: number
  height: number
  destinationRect: RuntimeArtRect
  origin: [number, number]
  role: RuntimeArtRole
}

export interface RuntimeArtAnimation {
  key: string
  frames: string[]
  frameRate: number
  repeat: number
}

export interface RuntimeArtManifest {
  version: number
  baseUrl: string
  specSource: string
  sources: RuntimeArtSource[]
  frames: RuntimeArtFrame[]
  animations: RuntimeArtAnimation[]
  aliases: Record<string, string>
  notes: string[]
}

/** Texture key of the packed runtime-pass atlas (./packed.ts loads it). */
export const RUNTIME_PACKED_KEY = 'packed-runtime'

/**
 * The manifest (frame metadata). The pixels come packed (./packed.ts,
 * ./atlas-plan.ts): the source sheets stay in assets/generated/runtime-pass/.
 */
export function preloadRuntimeArt(
  scene: Phaser.Scene,
  base: string = RUNTIME_ART_BASE,
): void {
  scene.load.json(RUNTIME_ART_MANIFEST_KEY, `${base}manifest.json`)
}

/**
 * Build one canvas texture per manifest frame at its authored native size
 * (`width` x `height`): the measured `sourceRect` sampled nearest-neighbour
 * into the measured `destinationRect`, so foot baselines stay fixed across
 * frames. That sampling is baked at build time (scripts/build-atlases.ts);
 * each canvas is a 1:1 copy from the packed atlas. Then create the manifest
 * animations. Idempotent: existing texture/animation keys are left alone.
 * Returns the manifest, or null when the pack didn't load (the procedural
 * placeholders stay).
 */
export function createRuntimeArt(scene: Phaser.Scene): RuntimeArtManifest | null {
  const manifest = scene.cache.json.get(
    RUNTIME_ART_MANIFEST_KEY,
  ) as RuntimeArtManifest | undefined
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.runtime
  if (!manifest || !packed || !scene.textures.exists(RUNTIME_PACKED_KEY)) return null
  const atlas = scene.textures.get(RUNTIME_PACKED_KEY).getSourceImage() as CanvasImageSource
  for (const item of manifest.frames) {
    const r = packed.frames[item.key]
    if (!r || scene.textures.exists(item.key)) continue
    const output = scene.textures.createCanvas(item.key, item.width, item.height)
    if (!output) throw new Error(`Cannot create texture ${item.key}`)
    output.context.imageSmoothingEnabled = false
    output.context.drawImage(atlas, r[0], r[1], r[2], r[3], 0, 0, r[2], r[3])
    output.refresh()
  }
  for (const definition of manifest.animations) {
    if (scene.anims.exists(definition.key) || !definition.frames.every((f) => scene.textures.exists(f))) continue
    scene.anims.create({
      key: definition.key,
      frames: definition.frames.map((key) => ({ key })),
      frameRate: definition.frameRate,
      repeat: definition.repeat,
    })
  }
  return manifest
}

/**
 * Only call this deliberately after procedural fallback textures are
 * installed. This gives existing scene references their expected keys
 * (`mara`, `pip`, `orrin`, `guardian0`, `guardian1`, `slash`, `bolt`). It
 * does not wire new combat states or alter collisions, which remain
 * runtime-agent work. By default existing textures are left alone.
 */
export function installRuntimeAliases(
  scene: Phaser.Scene,
  { replaceExisting = false }: { replaceExisting?: boolean } = {},
): void {
  const manifest = scene.cache.json.get(
    RUNTIME_ART_MANIFEST_KEY,
  ) as RuntimeArtManifest | undefined
  if (!manifest) return
  for (const [alias, key] of Object.entries(manifest.aliases)) {
    if (!scene.textures.exists(key)) continue
    if (scene.textures.exists(alias)) {
      if (!replaceExisting) continue
      scene.textures.remove(alias)
    }
    const source = scene.textures.get(key).getSourceImage()
    const output = scene.textures.createCanvas(alias, source.width, source.height)
    if (!output) throw new Error(`Cannot create alias ${alias}`)
    output.context.imageSmoothingEnabled = false
    output.context.drawImage(source as CanvasImageSource, 0, 0)
    output.refresh()
  }
}
