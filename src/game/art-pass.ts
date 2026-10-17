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
 * Packed atlases that are only copied out of (into each frame's own
 * texture), by game: loaded as decoded images and never made textures, so
 * the loader doesn't upload them to the GPU only for boot to release them.
 */
const staged = new WeakMap<Phaser.Game, { images: Map<string, CanvasImageSource>; decoding: Promise<unknown>[] }>()

function stagedFor(game: Phaser.Game) {
  let s = staged.get(game)
  if (!s) staged.set(game, (s = { images: new Map(), decoding: [] }))
  return s
}

/**
 * Load a packed atlas as staging (`packedSource` reads it, `releasePacked`
 * drops it). The image decodes off the main thread (`stagedDecoded`).
 */
export function loadStaged(scene: Phaser.Scene, key: string, url: string): void {
  const s = stagedFor(scene.sys.game)
  const onAdd = (added: string, _type: string, _loader: unknown, file: { addToCache(): void; data: HTMLImageElement }) => {
    if (added !== key) return
    file.addToCache = () => {
      s.images.set(key, file.data)
      s.decoding.push(file.data.decode().catch(() => undefined))
    }
  }
  scene.load.on('addfile', onAdd)
  scene.load.image(key, url)
  scene.load.off('addfile', onAdd)
}

/** Every staged atlas loaded so far, decoded (or failed to). */
export function stagedDecoded(scene: Phaser.Scene): Promise<unknown> {
  return Promise.all(stagedFor(scene.sys.game).decoding)
}

/** A packed atlas's image: staged, else its texture's (null when it didn't load). */
export function packedSource(scene: Phaser.Scene, key: string): CanvasImageSource | null {
  const image = staged.get(scene.sys.game)?.images.get(key)
  if (image) return image
  return scene.textures.exists(key) ? (scene.textures.get(key).getSourceImage() as CanvasImageSource) : null
}

/** Drop a packed atlas once it is copied out (a pass may keep the image it had). */
export function releasePacked(scene: Phaser.Scene, key: string): void {
  staged.get(scene.sys.game)?.images.delete(key)
  if (scene.textures.exists(key)) scene.textures.remove(key)
}

/** Work done a step at a time: it yields between steps (BootScene runs it in slices). */
export type Steps<T> = Generator<void, T, void>

/** Whether a value is `Steps` (and not some other result). */
export function isSteps(v: unknown): v is Steps<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { next?: unknown }).next === 'function'
}

/** Run steps to the end at once; their result. */
export function drain<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/**
 * One native texture per frame the atlas holds, under `keyOf(frame)` at
 * the frame's native world size (existing keys are left alone), then the
 * atlas is released (`releasePacked`): it was staging. Returns the frames the
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
  return drain(explodingFrames(scene, packedKey, packed, frames, keyOf))
}

/** `explodeFrames`, yielding after each texture it makes. */
export function* explodingFrames<F extends { key: string; width: number; height: number }>(
  scene: Phaser.Scene,
  packedKey: string,
  packed: PackedCanvasPack | undefined,
  frames: readonly F[],
  keyOf: (frame: string) => string
): Steps<{ held: F[]; atlas: CanvasImageSource } | null> {
  const atlas = packedSource(scene, packedKey)
  if (!packed || !atlas) return null
  const k = artDensity(scene)
  const held: F[] = []
  for (const item of frames) {
    const r = packed.frames[item.key]
    if (!r) continue
    held.push(item)
    const key = keyOf(item.key)
    if (scene.textures.exists(key)) continue
    // Drawn before it becomes a texture, so the GPU gets it in one upload
    // (createCanvas, then refresh, uploaded every frame twice).
    const canvas = document.createElement('canvas')
    canvas.width = item.width * k
    canvas.height = item.height * k
    const context = canvas.getContext('2d')
    if (!context) continue
    resampleFor(context, packed.density ?? 1, k)
    context.drawImage(atlas, r[0], r[1], r[2], r[3], 0, 0, item.width * k, item.height * k)
    const output = scene.textures.addCanvas(key, canvas)
    if (!output) continue
    setDensity(output, k)
    yield
  }
  releasePacked(scene, packedKey)
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
