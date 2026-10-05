import type Phaser from 'phaser'

/**
 * Typed port of `assets/generated/commons-pass/integration.js`: the Commons
 * and Wilds art pass that replaces the code-drawn placeholders listed in
 * docs/art-requests.md. Like the runtime pass (./runtime-art.ts), the 21
 * source PNGs are high-resolution irregular atlases with individually
 * measured rectangles — never a fixed grid. Each manifest frame becomes one
 * native-size canvas texture (`commons-art:<frame>`), blitting its measured
 * `sourceRect` into its `destinationRect` with nearest-neighbour sampling, so
 * foot-anchored origins stay put between frames. Source PNGs are never
 * modified.
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

/** Source sheet texture keys → files (must match manifest.json `sources`). */
export const COMMONS_PASS_SOURCES: Readonly<Record<string, string>> = {
  'commons-residents': 'fingersnap-residents-v2.png',
  'commons-homes': 'fingersnap-homes.png',
  'commons-interior-wall': 'fingersnap-interior-wall.png',
  'commons-fire': 'fingersnap-fire.png',
  'commons-camp-home': 'fingersnap-camp-home.png',
  'commons-furniture': 'fingersnap-furniture.png',
  'commons-commons': 'fingersnap-commons.png',
  'commons-boundaries': 'fingersnap-boundaries.png',
  'commons-yard': 'fingersnap-yard.png',
  'commons-path-edges': 'fingersnap-path-edges.png',
  'commons-village-buildings': 'fingersnap-village-buildings.png',
  'commons-festivals': 'fingersnap-festivals.png',
  'commons-papers': 'fingersnap-papers.png',
  'commons-wilds-nature': 'fingersnap-wilds-nature.png',
  'commons-resource-nodes': 'fingersnap-resource-nodes.png',
  'commons-wilds-camp': 'fingersnap-wilds-camp.png',
  'commons-echoes': 'fingersnap-echoes.png',
  'commons-icons': 'fingersnap-icons.png',
  'commons-plank-floor': 'fingersnap-plank-floor.png',
  'commons-warden-settled': 'fingersnap-warden-settled.png',
  'commons-portraits': 'fingersnap-portraits.png',
}

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

export function preloadCommonsPass(scene: Phaser.Scene, base: string = COMMONS_PASS_BASE): void {
  for (const [key, file] of Object.entries(COMMONS_PASS_SOURCES)) scene.load.image(key, `${base}${file}`)
  scene.load.json(COMMONS_PASS_MANIFEST_KEY, `${base}manifest.json`)
}

let aliases: Record<string, string> = {}
let frames = new Map<string, CommonsPassFrame>()

/** The manifest entry for a frame or alias (null when the pack isn't loaded). */
export function commonsFrame(key: string): CommonsPassFrame | null {
  return frames.get(aliases[key] ?? key) ?? null
}

/**
 * Build the native textures and the 11 looping animations. Idempotent
 * (existing keys are skipped). Frames whose sheet failed to load are left
 * out, and so are animations missing any frame. Returns the manifest, or
 * null when it didn't load (the placeholders carry on alone).
 */
export function createCommonsPass(scene: Phaser.Scene): CommonsPassManifest | null {
  const manifest = scene.cache.json.get(COMMONS_PASS_MANIFEST_KEY) as CommonsPassManifest | undefined
  if (!manifest || !Array.isArray(manifest.frames)) return null
  aliases = { ...manifest.aliases }
  frames = new Map()
  for (const item of manifest.frames) {
    if (!scene.textures.exists(item.source)) continue
    frames.set(item.key, item)
    const key = artKey(item.key)
    if (scene.textures.exists(key)) continue
    const output = scene.textures.createCanvas(key, item.width, item.height)
    if (!output) continue
    blitFrame(scene, item, output.context, item.destinationRect)
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

/** Draw a frame's measured source rect into `dest` on `context`, nearest-neighbour. */
export function blitFrame(scene: Phaser.Scene, frame: CommonsPassFrame, context: CanvasRenderingContext2D, dest: CommonsPassRect, flipX = false): void {
  const source = scene.textures.get(frame.source).getSourceImage() as CanvasImageSource
  const s = frame.sourceRect
  context.save()
  context.imageSmoothingEnabled = false
  if (flipX) {
    context.translate(dest.x * 2 + dest.w, 0)
    context.scale(-1, 1)
  }
  context.drawImage(source, s.x, s.y, s.w, s.h, dest.x, dest.y, dest.w, dest.h)
  context.restore()
}

/**
 * The largest aspect-true rect for `frame`'s source crop inside a `w`×`h`
 * box, bottom-centred (feet on the box's base). Used where a delivered slot
 * leaves art much smaller than the footprint it stands for.
 */
export function fitRect(sourceRect: { w: number; h: number }, w: number, h: number): CommonsPassRect {
  const scale = Math.min(w / sourceRect.w, h / sourceRect.h)
  const dw = Math.max(1, Math.round(sourceRect.w * scale))
  const dh = Math.max(1, Math.round(sourceRect.h * scale))
  return { x: Math.floor((w - dw) / 2), y: h - dh, w: dw, h: dh }
}

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
