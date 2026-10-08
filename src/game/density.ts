import type Phaser from 'phaser'
import { ART_DENSITY, PHONE_ART_DENSITY } from './atlas-plan.ts'
import { canvasRatio } from './viewport.ts'

/**
 * Dense textures: art that keeps more texture pixels (texels) than world
 * pixels, drawn at its world size.
 *
 * The canvas-built packs (the Commons, runtime and items passes, the
 * terrain) ship at ART_DENSITY texels per world px (scripts/build-atlases.ts
 * box-filters them down from the full-resolution sheets). A dense texture's
 * frame reports its world size — `image.width`, origins, physics bodies,
 * hit areas and depth sorting all see world px, exactly as before — while
 * its UVs span the whole canvas, so the GPU samples every texel (nearest,
 * the game is `pixelArt`). Only code that reads a texture's pixels
 * (`getSourceImage`, canvas composites) has to know: `artSource` gives the
 * image with its density, `artCanvas` a composite canvas whose context is
 * scaled to world px.
 *
 * Phones keep what their canvas shows at boot: see `densityFor`. The
 * Canvas renderer draws a frame's cut rect (world px) straight from the
 * source, so without WebGL everything is built at density 1.
 */

/** Phaser.WEBGL (not imported: these modules also load in node tests). */
const WEBGL = 2

/** CSS px per world px on a phone (zoomFor, ./viewport.ts, gives 1.5–2 under a 600-px short side). */
export const PHONE_SCREEN_SCALE = 2

/** A phone: a screen under 600 CSS px on its short side. */
function phoneScreen(): boolean {
  const s = typeof screen === 'undefined' ? null : screen
  return !!s && Math.min(s.width, s.height) < 600
}

/**
 * Texels per world px worth building: 1 without WebGL; ART_DENSITY on a
 * large screen; on a phone, enough for the canvas px a world px takes
 * (PHONE_SCREEN_SCALE × the canvas ratio, ./viewport.ts). Texels past that
 * would only be skipped by nearest sampling (grain, and texture memory for
 * nothing): a phone whose canvas renders at a ratio of 1 keeps half of
 * ART_DENSITY (the packs box-filtered 2:1), one above 1 (nearly every phone:
 * 2–3) PHONE_ART_DENSITY.
 */
export function densityFor(webgl: boolean, phone: boolean, ratio: number): number {
  if (!webgl) return 1
  if (!phone) return ART_DENSITY
  const half = ART_DENSITY / 2
  return Math.min(ART_DENSITY, PHONE_SCREEN_SCALE * ratio > half ? PHONE_ART_DENSITY : half)
}

/** Each game's density, decided once (`artDensity`). */
const decided = new WeakMap<Phaser.Game, number>()

/**
 * Texels per world px for art built in this game: `densityFor` this screen,
 * decided the first time a scene asks (at boot, at the ratio the canvas
 * starts with) and kept for the game's life. A later change of the device
 * pixel ratio (a window dragged to another screen, browser zoom) resizes
 * the canvas and re-zooms the camera (./main.ts) but keeps the textures
 * built at boot: never a mix of densities, and never a rebuild mid-game. A
 * phone that starts at 1× and moves to 3× shows its 2× art upscaled
 * (crisp, as before this ratio existed); one that starts at 3× and moves to
 * 1× keeps its 4× textures until the next start.
 */
export function artDensity(scene: Phaser.Scene): number {
  const game = scene.sys.game
  let k = decided.get(game)
  if (k === undefined) {
    k = densityFor(game.renderer.type === WEBGL, phoneScreen(), canvasRatio())
    decided.set(game, k)
  }
  return k
}

/**
 * Set a context to copy `from` texels per world px into `to`: crisp when
 * it keeps or adds texels, filtered when it drops them (at 2:1 the
 * browser's bilinear sample is exactly the 2×2 box average).
 */
export function resampleFor(ctx: CanvasRenderingContext2D, from: number, to: number): void {
  ctx.imageSmoothingEnabled = from > to
  ctx.imageSmoothingQuality = from > to * 2 ? 'high' : 'low'
}

/** Texels per world px of a context (its scale: an `artCanvas` context's density). */
export function contextDensity(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform()
  return Math.hypot(m.a, m.b)
}

/**
 * A dense texture is sampled with screen pixel centres falling exactly on
 * texel edges at common zooms (4 texels over 3 px at zoom 3, over 6 on a
 * phone at a device pixel ratio of 3): nearest sampling then picks either side by float noise, which
 * changes as the camera moves (shimmer). Shifting the samples this many
 * texels decides every tie the same way; nothing else moves visibly.
 */
export const TIE_BIAS = 1 / 64

/**
 * Make a single-frame texture `density` texels per world px: its frame
 * reports `source / density` world px and samples the whole source (biased
 * by TIE_BIAS).
 */
export function setDensity(texture: Phaser.Textures.Texture, density: number): Phaser.Textures.Texture {
  (texture.customData as { density?: number }).density = density
  if (density === 1) return texture
  const src = texture.source[0]
  const w = src.width / density
  const h = src.height / density
  const frame = texture.get()
  frame.setSize(w, h, 0, 0)
  const du = TIE_BIAS / src.width
  const dv = TIE_BIAS / src.height
  frame.setUVs(w, h, du, dv, 1 + du, 1 + dv)
  return texture
}

/** Texels per world px of a texture (1 for ordinary textures). */
export function densityOf(texture: Phaser.Textures.Texture): number {
  return (texture.customData as { density?: number }).density ?? 1
}

/** Register (or replace) a canvas as a texture at `density` texels per world px. */
export function addArtCanvas(scene: Phaser.Scene, key: string, canvas: HTMLCanvasElement, density: number): Phaser.Textures.Texture | null {
  if (scene.textures.exists(key)) scene.textures.remove(key)
  const t = scene.textures.addCanvas(key, canvas)
  return t ? setDensity(t, density) : null
}

/**
 * A blank canvas `w`×`h` world px at `density` texels per world px, its
 * context scaled so drawing code works in world px (pixel reads and writes
 * — getImageData, putImageData — stay in texels).
 */
export function artCanvas(w: number, h: number, density: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = Math.round(w * density)
  c.height = Math.round(h * density)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false
  ctx.setTransform(density, 0, 0, density, 0, 0)
  return [c, ctx]
}

/** A texture's pixels: the source image, its density, its world size. */
export interface ArtSource {
  image: HTMLCanvasElement | HTMLImageElement
  density: number
  /** World px. */
  w: number
  h: number
}

/** The pixels behind a single-frame texture (null when it doesn't exist). */
export function artSource(scene: Phaser.Scene, key: string): ArtSource | null {
  if (!scene.textures.exists(key)) return null
  const t = scene.textures.get(key)
  const image = t.getSourceImage() as HTMLCanvasElement | HTMLImageElement
  const density = densityOf(t)
  return { image, density, w: image.width / density, h: image.height / density }
}

/**
 * Draw a world-px rect of `src` into a world-px rect of `ctx` (an
 * `artCanvas` context, or a plain one at density 1). The whole source when
 * no source rect is given.
 */
export function drawArt(
  ctx: CanvasRenderingContext2D,
  src: ArtSource,
  dx: number,
  dy: number,
  dw = src.w,
  dh = src.h,
  sx = 0,
  sy = 0,
  sw = dw,
  sh = dh,
): void {
  const k = src.density
  const smoothing = ctx.imageSmoothingEnabled
  const quality = ctx.imageSmoothingQuality
  // Filter when the target keeps fewer texels a world px than the source.
  const scale = contextDensity(ctx) * Math.min(dw / sw, dh / sh)
  if (k > scale) resampleFor(ctx, k, scale)
  ctx.drawImage(src.image, sx * k, sy * k, sw * k, sh * k, dx, dy, dw, dh)
  ctx.imageSmoothingEnabled = smoothing
  ctx.imageSmoothingQuality = quality
}

/**
 * A UI data URL of a texture (or a world-px `crop` of it): `scale` image px
 * per world px, the same size it always was (the UI sizes these images by
 * their natural size). Scaled up crisp; scaled down from dense art with the
 * browser's area filter.
 */
export function artDataUrl(src: ArtSource, scale = 1, crop?: { x: number; y: number; w: number; h: number }): string {
  const r = crop ?? { x: 0, y: 0, w: src.w, h: src.h }
  const c = document.createElement('canvas')
  c.width = Math.round(r.w * scale)
  c.height = Math.round(r.h * scale)
  const ctx = c.getContext('2d')!
  const down = src.density > scale
  ctx.imageSmoothingEnabled = down
  if (down) ctx.imageSmoothingQuality = 'high'
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  drawArt(ctx, src, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h)
  return c.toDataURL()
}

/**
 * The opaque part of an art source, in world px (fractions where a texel
 * edge falls inside a world px), or null when it is empty.
 */
export function opaqueBox(src: ArtSource, threshold = 0): { x: number; y: number; w: number; h: number } | null {
  const c = document.createElement('canvas')
  c.width = src.image.width
  c.height = src.image.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src.image, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let x0 = c.width
  let y0 = c.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (d[(y * c.width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return null
  const k = src.density
  return { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k }
}
