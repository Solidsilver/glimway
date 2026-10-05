import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, blitKey, fitRect, type PackedManifest, type PackedRect } from './atlas-plan.ts'

/**
 * Typed port of `assets/generated/commons-pass/integration.js`: the Commons
 * and Wilds art pass that replaces the code-drawn placeholders listed in
 * docs/art-requests.md. The 21 source PNGs (assets/generated/commons-pass/)
 * are high-resolution irregular atlases with individually measured
 * rectangles — never a fixed grid. Each manifest frame becomes one
 * native-size canvas texture (`commons-art:<frame>`): its measured
 * `sourceRect` sampled nearest-neighbour into its `destinationRect`, so
 * foot-anchored origins stay put between frames. That sampling now happens
 * at build time (scripts/build-atlases.ts) and ships packed; the loader
 * copies the baked pixels. Source PNGs are never modified.
 *
 * Code-drawn placeholders (./commons-art.ts, ./textures.ts, the Wilds art)
 * stay the fallback layer: every frame is optional, so a pack that fails to
 * load leaves the placeholders in place. `installCommonsPass` deliberately
 * copies delivered frames onto the placeholder keys the scenes already use
 * (boot only, before any world sprite exists); scene code that needs the
 * new states (animations, depleted nodes, faint echoes, the settled warden)
 * asks for `commons-art:` keys through `commonsArt` and falls back itself.
 */

export const COMMONS_PASS_BASE = '/assets/fingersnap/commons-pass/'

export const COMMONS_PASS_MANIFEST_KEY = 'fingersnap-commons-pass'

/** Namespace for every texture and animation this pack creates. */
export const COMMONS_ART_PREFIX = 'commons-art:'

export interface CommonsPassRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CommonsPassSource {
  key: string
  file: string
  width: number
  height: number
}

export interface CommonsPassFrame {
  key: string
  /** Native canvas size. */
  width: number
  height: number
  origin: [number, number]
  /** Frames sharing a scale group were measured at one common scale. */
  scaleGroup?: string
  source: string
  sourceRect: CommonsPassRect
  sheet: string
  destinationRect: CommonsPassRect
  /** 'cell': the crop is fitted into its 16-px slot (tiles, boundaries). */
  fit?: 'cell'
  role?: 'transition' | 'glow' | 'tile' | 'portrait'
  /** Faint Echo variants: a suggested runtime alpha (not baked in). */
  alphaMultiplier?: number
}

export interface CommonsPassAnimation {
  key: string
  frames: string[]
  frameRate: number
  repeat: number
}

export interface CommonsPassManifest {
  version: number
  date: string
  baseUrl: string
  specSource: string
  sources: CommonsPassSource[]
  frames: CommonsPassFrame[]
  animations: CommonsPassAnimation[]
  aliases: Record<string, string>
  pendingSheets: string[]
  notes: string[]
}

export const artKey = (frame: string): string => COMMONS_ART_PREFIX + frame

/** Texture key of the packed Commons-pass atlas (./packed.ts loads it). */
export const COMMONS_PACKED_KEY = 'packed-commons'

/**
 * The manifest (frame metadata). The pixels come packed: see ./packed.ts
 * and ./atlas-plan.ts — the full-resolution source sheets don't ship.
 */
export function preloadCommonsPass(scene: Phaser.Scene, base: string = COMMONS_PASS_BASE): void {
  scene.load.json(COMMONS_PASS_MANIFEST_KEY, `${base}manifest.json`)
}

let aliases: Record<string, string> = {}
let frames = new Map<string, CommonsPassFrame>()
let packedBlits: Record<string, PackedRect> = {}

/** The manifest entry for a frame or alias (null when the pack isn't loaded). */
export function commonsFrame(key: string): CommonsPassFrame | null {
  return frames.get(aliases[key] ?? key) ?? null
}

/**
 * Build the native textures and the 11 looping animations. Idempotent
 * (existing keys are skipped). Each native canvas is copied 1:1 from the
 * packed atlas, which holds exactly what blitting the measured source rect
 * into the native canvas produced (scripts/build-atlases.ts). Frames
 * missing from the atlas are left out, and so are animations missing any
 * frame. Returns the manifest, or null when the pack didn't load (the
 * placeholders carry on alone).
 */
export function createCommonsPass(scene: Phaser.Scene): CommonsPassManifest | null {
  const manifest = scene.cache.json.get(COMMONS_PASS_MANIFEST_KEY) as CommonsPassManifest | undefined
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.commons
  if (!manifest || !Array.isArray(manifest.frames) || !packed || !scene.textures.exists(COMMONS_PACKED_KEY)) return null
  const atlas = scene.textures.get(COMMONS_PACKED_KEY).getSourceImage() as CanvasImageSource
  aliases = { ...manifest.aliases }
  frames = new Map()
  packedBlits = packed.blits ?? {}
  for (const item of manifest.frames) {
    const r = packed.frames[item.key]
    if (!r) continue
    frames.set(item.key, item)
    const key = artKey(item.key)
    if (scene.textures.exists(key)) continue
    const output = scene.textures.createCanvas(key, item.width, item.height)
    if (!output) continue
    output.context.imageSmoothingEnabled = false
    output.context.drawImage(atlas, r[0], r[1], r[2], r[3], 0, 0, r[2], r[3])
    output.refresh()
  }
  for (const definition of manifest.animations) {
    const key = artKey(definition.key)
    if (scene.anims.exists(key) || !definition.frames.every((f) => frames.has(f))) continue
    scene.anims.create({
      key,
      frames: definition.frames.map((f) => ({ key: artKey(f) })),
      frameRate: definition.frameRate,
      repeat: definition.repeat,
    })
  }
  return manifest
}

/**
 * Draw a frame's measured source crop into `dest` on `context`, as sampling
 * the source sheet nearest-neighbour would: at its native destination size
 * that's the native canvas's pixels; at other sizes (or mirrored) it's a
 * sample baked into the atlas (`commonsBlitPlan`). A size nobody baked
 * resamples the native frame instead — run `npm run atlases` after adding
 * one to the plan.
 */
export function blitFrame(scene: Phaser.Scene, frame: CommonsPassFrame, context: CanvasRenderingContext2D, dest: CommonsPassRect, flipX = false): void {
  const key = artKey(frame.key)
  if (!scene.textures.exists(key)) return
  const native = scene.textures.get(key).getSourceImage() as CanvasImageSource
  const d = frame.destinationRect
  context.save()
  context.imageSmoothingEnabled = false
  const baked = packedBlits[blitKey(frame.key, dest.w, dest.h, flipX)]
  if (!flipX && dest.w === d.w && dest.h === d.h) {
    context.drawImage(native, d.x, d.y, d.w, d.h, dest.x, dest.y, dest.w, dest.h)
  } else if (baked && scene.textures.exists(COMMONS_PACKED_KEY)) {
    const atlas = scene.textures.get(COMMONS_PACKED_KEY).getSourceImage() as CanvasImageSource
    context.drawImage(atlas, baked[0], baked[1], baked[2], baked[3], dest.x, dest.y, dest.w, dest.h)
  } else {
    if (flipX) {
      context.translate(dest.x * 2 + dest.w, 0)
      context.scale(-1, 1)
    }
    context.drawImage(native, d.x, d.y, d.w, d.h, dest.x, dest.y, dest.w, dest.h)
  }
  context.restore()
}

export { fitRect }

/** `commons-art:<frame>` when that delivered texture exists, else null. */
export function commonsArt(scene: Phaser.Scene, frame: string): string | null {
  const key = artKey(aliases[frame] ?? frame)
  return scene.textures.exists(key) ? key : null
}

/** `commons-art:<animation>` when that delivered animation exists, else null. */
export function commonsAnim(scene: Phaser.Scene, animation: string): string | null {
  const key = artKey(animation)
  return scene.anims.exists(key) ? key : null
}

/** A crisp data URL of a delivered frame, scaled up by a whole number (UI). */
export function commonsDataUrl(scene: Phaser.Scene, frame: string, scale = 1): string | null {
  const key = commonsArt(scene, frame)
  if (!key) return null
  const src = scene.textures.get(key).getSourceImage() as HTMLCanvasElement
  const o = document.createElement('canvas')
  o.width = src.width * scale
  o.height = src.height * scale
  const ctx = o.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(src, 0, 0, o.width, o.height)
  return o.toDataURL()
}

/**
 * The residents' delivered dialogue busts (src/content/residents.ts): the
 * dialogue box finds portraits by speaker name, and they speak by first
 * name like Mara and Pip. Silas's comes from the homestead layer.
 */
export const COMMONS_RESIDENT_PORTRAITS: Readonly<Record<string, string>> = {
  Elara: 'portrait-elara',
  Finn: 'portrait-finn',
  Hazel: 'portrait-hazel',
  Ada: 'portrait-ada',
}

/** Every delivered 16-px UI icon (`icon-*` frames) as a data URL. */
export function commonsIconUrls(scene: Phaser.Scene): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of frames.keys()) {
    if (!key.startsWith('icon-')) continue
    const url = commonsDataUrl(scene, key)
    if (url) out[key] = url
  }
  return out
}
