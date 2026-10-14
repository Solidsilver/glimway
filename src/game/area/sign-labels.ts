/**
 * Sign labels: the words on an exit or gate signpost. A label is rasterized
 * once into a canvas texture keyed by its text, style and resolution, and drawn
 * as an image from that cache — so re-attaching a chunk with a sign costs no
 * font rasterization or WebGL upload (the per-attach hitch `scene.add.text`
 * used to take). The cache lives in the scene's texture manager: entries
 * survive chunk detach/reattach cycles and are reused across scene restarts,
 * never destroyed while a sign still uses them.
 */
import type Phaser from 'phaser'

/** A label's style: the settings `scene.add.text` would be given. */
export interface SignLabelStyle {
  fontFamily: string
  fontSize: number | string
  color: string
  stroke?: string
  strokeThickness?: number
  align?: 'left' | 'center' | 'right'
  lineSpacing?: number
  resolution: number
}

/** A label's cached texture entry, as it lives in the texture manager. */
interface CachedLabel {
  customData: { w?: number; h?: number; resolution?: number }
}

const PREFIX = 'sign-label:'

function keyFor(text: string, s: SignLabelStyle): string {
  return `${PREFIX}${text}\u0000${s.fontFamily}|${parseFloat(s.fontSize.toString())}|${s.color}|${s.stroke ?? ''}|${s.strokeThickness ?? 0}|${s.align ?? 'left'}|${s.lineSpacing ?? 0}|${s.resolution}`
}

/** Whether the label's own font is loaded (the primary family, ignoring fallbacks). */
function fontReady(s: SignLabelStyle): boolean {
  const size = parseFloat(s.fontSize.toString())
  const primary = s.fontFamily.split(',')[0].trim()
  const quoted = /^['"]/.test(primary) ? primary : `"${primary}"`
  // `undefined` (no FontFaceSet, or no document at all) is treated as ready:
  // there is nothing to wait on.
  const fonts = (globalThis as { document?: Document }).document?.fonts
  return fonts?.check(`${size}px ${quoted}`) !== false
}

/**
 * Draw one label at (x, y) with the given origin, from the cached texture for
 * its text and style. Returns the image a caller adds to its drawn list.
 */
export function signLabel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  style: SignLabelStyle,
  originX: number,
  originY: number
): Phaser.GameObjects.Image | Phaser.GameObjects.Text {
  // A label rasterized before its font loads would be cached with the fallback
  // font forever: draw it as a plain Text (uncached) so a later attach caches it.
  if (!fontReady(style)) return scene.add.text(x, y, text, style).setOrigin(originX, originY)
  const key = keyFor(text, style)
  let cached = scene.textures.exists(key) ? (scene.textures.get(key) as CachedLabel) : null
  if (!cached || !cached.customData.w) {
    // A stale entry with no recorded size can't be reused: drop it before re-adding.
    if (cached) scene.textures.remove(key)
    // Rasterize through a throwaway Phaser Text so the label is identical by
    // construction, then keep a copy of its canvas as the cached texture.
    const draft = scene.make.text({ x: 0, y: 0, text, style, add: false })
    const canvas = (globalThis as { document?: Document }).document!.createElement('canvas')
    canvas.width = draft.canvas.width
    canvas.height = draft.canvas.height
    canvas.getContext('2d')!.drawImage(draft.canvas, 0, 0)
    const created = scene.textures.addCanvas(key, canvas) as unknown as CachedLabel
    created.customData.w = draft.width
    created.customData.h = draft.height
    created.customData.resolution = style.resolution
    // The throwaway Text frees its own texture on destroy; only the cached copy stays.
    draft.destroy()
    cached = created
  }
  // The texture is `resolution`× the label's logical size; an image drawn from
  // it shrinks back to that size so it matches a Text of the same resolution.
  return scene.add.image(x, y, key).setOrigin(originX, originY).setScale(1 / cached.customData.resolution!)
}
