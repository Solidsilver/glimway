import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, blitKey, fitRect, type PackedManifest, type PackedRect } from './atlas-plan.ts'
import { artDataUrl, artSource, contextDensity, drawArt, resampleFor } from './density.ts'
import { explodeFrames, registerAnims, type PassAnimation, type PassRect, type PassSource } from './art-pass.ts'

/**
 * Typed port of `assets/generated/commons-pass/integration.js`: the Commons
 * and Wilds art pass that replaces the code-drawn placeholders listed in
 * docs/art-requests.md. The 21 source PNGs (assets/generated/commons-pass/)
 * are high-resolution irregular atlases with individually measured
 * rectangles — never a fixed grid. Each manifest frame becomes one
 * native-size canvas texture (`commons-art:<frame>`): its measured
 * `sourceRect` box-filtered into its `destinationRect`, so foot-anchored
 * origins stay put between frames. That sampling happens at build time
 * (scripts/build-atlases.ts) at ART_DENSITY texels per world px and ships
 * packed; the loader copies the baked pixels into dense textures
 * (./density.ts) that draw at the native world size. Source PNGs are never
 * modified.
 *
 * The packed art always ships (owner decision, 2026-10-07): the code-drawn
 * placeholders it covers were retired. `installCommonsPass` copies the
 * delivered frames under the keys the scenes draw with (boot only, before
 * any world sprite exists); scene code that needs the new states
 * (animations, depleted nodes, faint echoes, the settled warden) asks for
 * `commons-art:` keys through `commonsArt`.
 */

export const COMMONS_PASS_BASE = '/assets/fingersnap/commons-pass/'

export const COMMONS_PASS_MANIFEST_KEY = 'glimway-commons-pass'

/** Namespace for every texture and animation this pack creates. */
export const COMMONS_ART_PREFIX = 'commons-art:'

export interface CommonsPassFrame {
  key: string
  /** Native canvas size. */
  width: number
  height: number
  origin: [number, number]
  /** Frames sharing a scale group were measured at one common scale. */
  scaleGroup?: string
  source: string
  sourceRect: PassRect
  sheet: string
  destinationRect: PassRect
  /** 'cell': the crop is fitted into its 16-px slot (tiles, boundaries). */
  fit?: 'cell'
  role?: 'transition' | 'glow' | 'tile' | 'portrait'
  /** Faint Echo variants: a suggested runtime alpha (not baked in). */
  alphaMultiplier?: number
}

export interface CommonsPassManifest {
  version: number
  date: string
  baseUrl: string
  specSource: string
  sources: PassSource[]
  frames: CommonsPassFrame[]
  animations: PassAnimation[]
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
/** The packed atlas's pixels, kept for the baked samples `blitFrame` draws later. */
let packedAtlas: CanvasImageSource | null = null
let packedDensity = 1

/** The manifest entry for a frame or alias (null when the pack isn't loaded). */
export function commonsFrame(key: string): CommonsPassFrame | null {
  return frames.get(aliases[key] ?? key) ?? null
}

/**
 * Build the native textures and the 11 looping animations, once at boot
 * (existing keys are skipped; the packed atlas texture is released after,
 * so a second call returns null). Each native texture is copied 1:1 from
 * the packed atlas, which holds the measured source rect box-filtered into
 * the native canvas at ART_DENSITY (scripts/build-atlases.ts), and drawn at
 * its native world size (./density.ts). Frames missing from the atlas are
 * left out, and so are animations missing any frame. Returns the manifest,
 * or null when the pack didn't load.
 */
export function createCommonsPass(scene: Phaser.Scene): CommonsPassManifest | null {
  const manifest = scene.cache.json.get(COMMONS_PASS_MANIFEST_KEY) as CommonsPassManifest | undefined
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.commons
  if (!manifest || !Array.isArray(manifest.frames)) return null
  const made = explodeFrames(scene, COMMONS_PACKED_KEY, packed, manifest.frames, artKey)
  if (!made || !packed) return null
  aliases = { ...manifest.aliases }
  frames = new Map(made.held.map((f) => [f.key, f]))
  packedBlits = packed.blits ?? {}
  packedDensity = packed.density ?? 1
  // The atlas's GPU copy went; its image stays for blitFrame.
  packedAtlas = made.atlas
  registerAnims(scene, manifest.animations, (f) => frames.has(f), artKey)
  return manifest
}

/**
 * Draw a frame's measured source crop into `dest` (world px) on `context`
 * (world px: an `artCanvas` context, or a plain one at density 1), as
 * filtering the source sheet would: at its native destination size that's
 * the native texture's texels; at other sizes (or mirrored) it's a sample
 * baked into the atlas (`commonsBlitPlan`). A size nobody baked resamples
 * the native frame instead — run `npm run atlases` after adding one to the
 * plan.
 */
export function blitFrame(scene: Phaser.Scene, frame: CommonsPassFrame, context: CanvasRenderingContext2D, dest: PassRect, flipX = false): void {
  const native = artSource(scene, artKey(frame.key))
  if (!native) return
  const d = frame.destinationRect
  context.save()
  context.imageSmoothingEnabled = false
  const baked = packedBlits[blitKey(frame.key, dest.w, dest.h, flipX)]
  if (!flipX && dest.w === d.w && dest.h === d.h) {
    drawArt(context, native, dest.x, dest.y, dest.w, dest.h, d.x, d.y, d.w, d.h)
  } else if (baked && packedAtlas) {
    resampleFor(context, packedDensity, contextDensity(context))
    context.drawImage(packedAtlas, baked[0], baked[1], baked[2], baked[3], dest.x, dest.y, dest.w, dest.h)
  } else {
    if (flipX) {
      context.translate(dest.x * 2 + dest.w, 0)
      context.scale(-1, 1)
    }
    drawArt(context, native, dest.x, dest.y, dest.w, dest.h, d.x, d.y, d.w, d.h)
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

/**
 * A crisp data URL of a delivered frame (UI): `scale` image px per world
 * px, or the frame's own density when that is finer.
 */
export function commonsDataUrl(scene: Phaser.Scene, frame: string, scale = 1): string | null {
  const key = commonsArt(scene, frame)
  const src = key ? artSource(scene, key) : null
  return src ? artDataUrl(src, scale) : null
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
