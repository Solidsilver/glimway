/**
 * What the delivered art passes (./commons-pass.ts, ./items-pass.ts,
 * ./runtime-art.ts) share: the manifest shapes, copying each frame's baked
 * texels out of the pass's packed atlas into its own dense texture
 * (./density.ts), and registering the pass's animations.
 */
import type Phaser from 'phaser'
import type { PackedCanvasPack } from './atlas-plan.ts'
import { artDensity, resampleFor, setDensity } from './density.ts'

/** A measured rectangle: on a source sheet (texels) or a native canvas (world px). */
export interface PassRect {
  x: number
  y: number
  w: number
  h: number
}

/** A source sheet the pass was measured on (it stays in assets/generated/). */
export interface PassSource {
  key: string
  file: string
  width: number
  height: number
}

export interface PassAnimation {
  key: string
  frames: string[]
  frameRate: number
  repeat: number
}

/**
 * One native texture per frame the atlas holds, under `keyOf(frame)` at
 * the frame's native world size (existing keys are left alone), then the
 * atlas's GPU copy is released: it was staging. Returns the frames the
 * atlas held, and the atlas image (a pass may keep sampling it), or null
 * when the pass isn't loaded.
 */
export function explodeFrames<F extends { key: string; width: number; height: number }>(
  scene: Phaser.Scene,
  packedKey: string,
  packed: PackedCanvasPack | undefined,
  frames: readonly F[],
  keyOf: (frame: string) => string
): { held: F[]; atlas: CanvasImageSource } | null {
  if (!packed || !scene.textures.exists(packedKey)) return null
  const atlas = scene.textures.get(packedKey).getSourceImage() as CanvasImageSource
  const k = artDensity(scene)
  const held: F[] = []
  for (const item of frames) {
    const r = packed.frames[item.key]
    if (!r) continue
    held.push(item)
    const key = keyOf(item.key)
    if (scene.textures.exists(key)) continue
    const output = scene.textures.createCanvas(key, item.width * k, item.height * k)
    if (!output) continue
    resampleFor(output.context, packed.density ?? 1, k)
    output.context.drawImage(atlas, r[0], r[1], r[2], r[3], 0, 0, item.width * k, item.height * k)
    output.refresh()
    setDensity(output, k)
  }
  scene.textures.remove(packedKey)
  return { held, atlas }
}

/**
 * The pass's looping animations, under `keyOf(animation)` with frames
 * `keyOf(frame)`: each one whose frames all loaded (`has`), unless the
 * key already exists.
 */
export function registerAnims(scene: Phaser.Scene, animations: readonly PassAnimation[], has: (frame: string) => boolean, keyOf: (key: string) => string = (key) => key): void {
  for (const definition of animations) {
    const key = keyOf(definition.key)
    if (scene.anims.exists(key) || !definition.frames.every(has)) continue
    scene.anims.create({
      key,
      frames: definition.frames.map((f) => ({ key: keyOf(f) })),
      frameRate: definition.frameRate,
      repeat: definition.repeat
    })
  }
}
