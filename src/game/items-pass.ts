import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'

/**
 * Typed port and loader module for `assets/generated/items-pass/`:
 * inventory icons for tools, supplies, keepsakes, home goods and papers,
 * plus world sprites and the Tolley Mill. The 12 source PNGs stay in
 * assets/generated/items-pass/; the build bakes their native frames into
 * the packed atlas (scripts/build-atlases.ts → packed-items / items.png).
 *
 * Each frame becomes one native-size canvas texture under `items-art:<frame>`,
 * nearest-neighbour blitted from the packed atlas. Tool conditions and item
 * variants are discrete states (never looping animations). Loops are only
 * created for the three authored mill animations: `mill-wheel`,
 * `mill-wheel-mended`, and `mill-froth`.
 *
 * Reused Commons art (`commons:` aliases) points to existing `commons-art:`
 * runtime textures without duplicating them.
 */

export const ITEMS_PASS_BASE = '/assets/fingersnap/items-pass/'

export const ITEMS_PASS_MANIFEST_KEY = 'fingersnap-items-pass'

/** Namespace for every texture and animation this pack creates. */
export const ITEMS_ART_PREFIX = 'items-art:'

/** Texture key of the packed items-pass atlas (./packed.ts loads it). */
export const ITEMS_PACKED_KEY = 'packed-items'

/** Fallback texture key when an item has no art. */
export const ITEM_ART_FALLBACK = 'items-art:fallback'

export interface ItemsPassRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ItemsPassSource {
  key: string
  file: string
  width: number
  height: number
}

export interface ItemsPassFrame {
  key: string
  width: number
  height: number
  origin: [number, number]
  fit?: string
  role?: string
  source: string
  sheet: string
  sourceRect: ItemsPassRect
  itemId?: string
  category?: string
  priority?: string
  name?: string
  state?: string
  look?: string
  destinationRect: ItemsPassRect
  scaleGroup?: string
}

export interface ItemsPassAnimation {
  key: string
  frames: string[]
  frameRate: number
  repeat: number
}

export interface ItemsPassStateGroup {
  key: string
  frames: string[]
  selection: string
}

export interface ItemsPassManifest {
  version: number
  baseUrl: string
  sources: ItemsPassSource[]
  frames: ItemsPassFrame[]
  animations: ItemsPassAnimation[]
  stateGroups: ItemsPassStateGroup[]
  aliases: Record<string, string>
  notes: string[]
}

export const itemsArtKey = (frame: string): string => ITEMS_ART_PREFIX + frame

let aliases: Record<string, string> = {}
let frames = new Map<string, ItemsPassFrame>()
let framesByItemState = new Map<string, ItemsPassFrame>()
let framesByItemId = new Map<string, ItemsPassFrame>()

/**
 * Initialize internal frame and alias mappings from a manifest.
 * Used during scene boot and by unit tests.
 */
export function initItemsManifest(manifest: ItemsPassManifest): void {
  aliases = { ...manifest.aliases }
  frames = new Map()
  framesByItemState = new Map()
  framesByItemId = new Map()
  for (const f of manifest.frames) {
    frames.set(f.key, f)
    if (f.itemId) {
      if (!framesByItemId.has(f.itemId)) {
        framesByItemId.set(f.itemId, f)
      }
      if (f.state) {
        framesByItemState.set(`${f.itemId}:${f.state}`, f)
      }
    }
  }
}

/** The manifest entry for a frame or alias (null when not loaded). */
export function itemsFrame(key: string): ItemsPassFrame | null {
  const resolved = aliases[key] ?? key
  if (resolved.startsWith('commons:')) return null
  return frames.get(resolved) ?? null
}

/** `items-art:<animation>` when that delivered animation exists, else null. */
export function itemsAnim(scene: Phaser.Scene, animation: string): string | null {
  const key = itemsArtKey(animation)
  return scene.anims.exists(key) ? key : scene.anims.exists(animation) ? animation : null
}

/**
 * The manifest (frame metadata). The pixels come packed: see ./packed.ts
 * and ./atlas-plan.ts — the full-resolution source sheets don't ship.
 */
export function preloadItemsPass(scene: Phaser.Scene, base: string = ITEMS_PASS_BASE): void {
  scene.load.json(ITEMS_PASS_MANIFEST_KEY, `${base}manifest.json`)
}

/**
 * Build native canvas textures and the three looping mill animations.
 * Idempotent (existing keys are skipped). Each native canvas is copied 1:1
 * from the packed atlas.
 *
 * State groups are discrete states (never animations). Loops are only created
 * for the three mill animations (mill-wheel, mill-wheel-mended, mill-froth).
 */
export function createItemsPass(scene: Phaser.Scene): ItemsPassManifest | null {
  const manifest = scene.cache.json.get(ITEMS_PASS_MANIFEST_KEY) as ItemsPassManifest | undefined
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.items
  if (!manifest || !Array.isArray(manifest.frames) || !packed || !scene.textures.exists(ITEMS_PACKED_KEY)) return null
  const atlas = scene.textures.get(ITEMS_PACKED_KEY).getSourceImage() as CanvasImageSource

  initItemsManifest(manifest)

  for (const item of manifest.frames) {
    const r = packed.frames[item.key]
    if (!r) continue
    const key = itemsArtKey(item.key)
    if (scene.textures.exists(key)) continue
    const output = scene.textures.createCanvas(key, item.width, item.height)
    if (!output) continue
    output.context.imageSmoothingEnabled = false
    output.context.drawImage(atlas, r[0], r[1], r[2], r[3], 0, 0, r[2], r[3])
    output.refresh()
  }

  // Fallback 16×16 texture for items without art
  if (!scene.textures.exists(ITEM_ART_FALLBACK)) {
    const fallbackCanvas = scene.textures.createCanvas(ITEM_ART_FALLBACK, 16, 16)
    if (fallbackCanvas) {
      const ctx = fallbackCanvas.context
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = '#3a2a28'
      ctx.fillRect(2, 2, 12, 12)
      ctx.fillStyle = '#8a6642'
      ctx.fillRect(3, 3, 10, 10)
      ctx.fillStyle = '#d0a86c'
      ctx.fillRect(4, 4, 8, 8)
      ctx.fillStyle = '#ffd98a'
      ctx.fillRect(6, 6, 4, 4)
      fallbackCanvas.refresh()
    }
  }

  // The three authored looping mill animations (mill-wheel, mill-wheel-mended, mill-froth)
  for (const definition of manifest.animations) {
    const key = itemsArtKey(definition.key)
    if (!scene.anims.exists(key) && definition.frames.every((f) => frames.has(f))) {
      scene.anims.create({
        key,
        frames: definition.frames.map((f) => ({ key: itemsArtKey(f) })),
        frameRate: definition.frameRate,
        repeat: definition.repeat,
      })
    }
    // Also create under the bare animation key if not already defined
    if (!scene.anims.exists(definition.key) && definition.frames.every((f) => scene.textures.exists(f) || frames.has(f))) {
      scene.anims.create({
        key: definition.key,
        frames: definition.frames.map((f) => ({ key: scene.textures.exists(f) ? f : itemsArtKey(f) })),
        frameRate: definition.frameRate,
        repeat: definition.repeat,
      })
    }
  }

  return manifest
}

/**
 * Install delivered mill textures onto the placeholder keys
 * (`mill-house`, `mill-hopper`, `mill-wheel-0..3`, `mill-wheel-mended-0..3`, `mill-froth-0..1`).
 */
export function installItemsPass(scene: Phaser.Scene): void {
  const millFrames = [
    'mill-house',
    'mill-hopper',
    'mill-wheel-0',
    'mill-wheel-1',
    'mill-wheel-2',
    'mill-wheel-3',
    'mill-wheel-mended-0',
    'mill-wheel-mended-1',
    'mill-wheel-mended-2',
    'mill-wheel-mended-3',
    'mill-froth-0',
    'mill-froth-1',
  ]
  for (const name of millFrames) {
    const deliveredKey = itemsArtKey(name)
    if (!scene.textures.exists(deliveredKey)) continue
    if (scene.textures.exists(name)) {
      scene.textures.remove(name)
    }
    const source = scene.textures.get(deliveredKey).getSourceImage()
    const output = scene.textures.createCanvas(name, source.width, source.height)
    if (output) {
      output.context.imageSmoothingEnabled = false
      output.context.drawImage(source as CanvasImageSource, 0, 0)
      output.refresh()
    }
  }
}

/**
 * Resolve an item ID and optional state to its texture key.
 *
 * Respects `commons:` aliases (resolving to `commons-art:...` textures),
 * discrete states (e.g. `worn`, `lit`, `dried-out`), and falls back to
 * `ITEM_ART_FALLBACK` (or custom fallback) when no art matches.
 */
export function itemIcon(itemId: string, state?: string, fallback: string = ITEM_ART_FALLBACK): string {
  // If state is requested, look for the frame matching that itemId and state
  if (state !== undefined) {
    const byState = framesByItemState.get(`${itemId}:${state}`)
    if (byState) return itemsArtKey(byState.key)
    // Check if itemId is directly a frame key that has that state
    const directFrame = frames.get(itemId)
    if (directFrame && directFrame.state === state) return itemsArtKey(directFrame.key)
    return fallback
  }

  // Default / state-less lookup: check aliases first
  const alias = aliases[itemId]
  if (alias) {
    if (alias.startsWith('commons:')) {
      return 'commons-art:' + alias.slice('commons:'.length)
    }
    if (frames.has(alias)) {
      return itemsArtKey(alias)
    }
  }

  // Check frames by itemId
  const byItem = framesByItemId.get(itemId)
  if (byItem) return itemsArtKey(byItem.key)

  // Check direct frame key
  if (frames.has(itemId)) return itemsArtKey(itemId)

  return fallback
}

/** A crisp data URL of a delivered item frame, scaled up by a whole number (UI). */
export function itemDataUrl(scene: Phaser.Scene, frameOrKey: string, scale = 1): string | null {
  const key = frameOrKey.startsWith(ITEMS_ART_PREFIX) || frameOrKey.startsWith('commons-art:')
    ? frameOrKey
    : (aliases[frameOrKey]?.startsWith('commons:')
        ? 'commons-art:' + aliases[frameOrKey].slice('commons:'.length)
        : itemsArtKey(aliases[frameOrKey] ?? frameOrKey))
  if (!scene.textures.exists(key)) return null
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
 * Every delivered item inventory icon as a data URL for Svelte UI.
 * Keyed by frame key (`item-bench-axe-whole`, …), and by item ID alias (`bench-axe`, …).
 */
export function itemIconUrls(scene: Phaser.Scene): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [frameKey, frame] of frames) {
    if (frame.role !== 'inventory-icon' && !frameKey.startsWith('item-')) continue
    const url = itemDataUrl(scene, frameKey)
    if (url) {
      out[frameKey] = url
      if (frame.itemId && !frame.state) {
        out[frame.itemId] = url
      }
    }
  }
  // Include resolved aliases (e.g. 'bench-axe' -> 'item-bench-axe-whole', or 'timber' -> 'commons:icon-timber')
  for (const [alias, target] of Object.entries(aliases)) {
    if (target.startsWith('commons:')) {
      const commonsKey = 'commons-art:' + target.slice('commons:'.length)
      if (scene.textures.exists(commonsKey)) {
        const url = itemDataUrl(scene, commonsKey)
        if (url) out[alias] = url
      }
    } else if (out[target]) {
      out[alias] = out[target]
    }
  }
  // Include fallback icon URL
  if (scene.textures.exists(ITEM_ART_FALLBACK)) {
    const fallbackUrl = itemDataUrl(scene, ITEM_ART_FALLBACK)
    if (fallbackUrl) out[ITEM_ART_FALLBACK] = fallbackUrl
  }
  return out
}
