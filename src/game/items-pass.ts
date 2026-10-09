import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'
import { addArtCanvas, artCanvas, artDataUrl, artSource, drawArt } from './density.ts'
import { explodeFrames, type PassAnimation, type PassRect, type PassSource } from './art-pass.ts'
import { CRAFTS_WORLD_ART, craftsArt } from '../lib/crafts-art-key.ts'

/**
 * Typed port and loader module for `assets/generated/items-pass/`:
 * inventory icons for tools, supplies, keepsakes, home goods and papers,
 * plus world sprites and the Tolley Mill. The 12 source PNGs stay in
 * assets/generated/items-pass/; the build bakes their native frames into
 * the packed atlas (scripts/build-atlases.ts → items.webp, loaded as
 * `packed-items`).
 *
 * Each frame becomes one canvas texture under `items-art:<frame>`, copied
 * from the packed atlas at the art density and drawn at its native world
 * size (./density.ts). Tool conditions and item
 * variants are discrete states (never looping animations). The manifest's
 * three mill loops aren't registered: the wheel is stepped frame by frame
 * (../entities/village-life.ts).
 *
 * Reused Commons art (`commons:` aliases) points to existing `commons-art:`
 * runtime textures without duplicating them.
 */

export const ITEMS_PASS_BASE = '/assets/fingersnap/items-pass/'

export const ITEMS_PASS_MANIFEST_KEY = 'glimway-items-pass'

/** Namespace for every texture and animation this pack creates. */
export const ITEMS_ART_PREFIX = 'items-art:'

/** Texture key of the packed items-pass atlas (./packed.ts loads it). */
export const ITEMS_PACKED_KEY = 'packed-items'

/** Fallback texture key when an item has no art. */
export const ITEM_ART_FALLBACK = 'items-art:fallback'

export interface ItemsPassFrame {
  key: string
  width: number
  height: number
  origin: [number, number]
  fit?: string
  role?: string
  source: string
  sheet: string
  sourceRect: PassRect
  itemId?: string
  category?: string
  priority?: string
  name?: string
  state?: string
  look?: string
  destinationRect: PassRect
  scaleGroup?: string
}

export interface ItemsPassStateGroup {
  key: string
  frames: string[]
  selection: string
}

export interface ItemsPassManifest {
  version: number
  baseUrl: string
  sources: PassSource[]
  frames: ItemsPassFrame[]
  animations: PassAnimation[]
  stateGroups: ItemsPassStateGroup[]
  aliases: Record<string, string>
  notes: string[]
}

export const itemsArtKey = (frame: string): string => ITEMS_ART_PREFIX + frame

let aliases: Record<string, string> = {}
let frames = new Map<string, ItemsPassFrame>()
let framesByItemState = new Map<string, ItemsPassFrame>()
let framesByItemId = new Map<string, ItemsPassFrame>()
/** World sprites (in-situ art for placed pieces), first per item id and per item id:state. */
let worldByItemId = new Map<string, ItemsPassFrame>()
let worldByItemState = new Map<string, ItemsPassFrame>()

/**
 * Initialize internal frame and alias mappings from a manifest.
 * Used during scene boot and by unit tests.
 */
export function initItemsManifest(manifest: ItemsPassManifest): void {
  aliases = { ...manifest.aliases }
  frames = new Map()
  framesByItemState = new Map()
  framesByItemId = new Map()
  worldByItemId = new Map()
  worldByItemState = new Map()
  for (const f of manifest.frames) {
    frames.set(f.key, f)
    if (f.itemId) {
      if (!framesByItemId.has(f.itemId)) {
        framesByItemId.set(f.itemId, f)
      }
      if (f.state) {
        framesByItemState.set(`${f.itemId}:${f.state}`, f)
      }
      if (f.role === 'world-sprite') {
        if (!worldByItemId.has(f.itemId)) worldByItemId.set(f.itemId, f)
        if (f.state && !worldByItemState.has(`${f.itemId}:${f.state}`)) worldByItemState.set(`${f.itemId}:${f.state}`, f)
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

/**
 * The manifest (frame metadata). The pixels come packed: see ./packed.ts
 * and ./atlas-plan.ts — the full-resolution source sheets don't ship.
 */
export function preloadItemsPass(scene: Phaser.Scene, base: string = ITEMS_PASS_BASE): void {
  scene.load.json(ITEMS_PASS_MANIFEST_KEY, `${base}manifest.json`)
}

/**
 * Build the native canvas textures once at boot (existing keys are
 * skipped; the packed atlas texture is released after). Each is copied 1:1
 * from the packed atlas, dense (./density.ts). State groups are discrete
 * states, never animations.
 */
export function createItemsPass(scene: Phaser.Scene): ItemsPassManifest | null {
  const manifest = scene.cache.json.get(ITEMS_PASS_MANIFEST_KEY) as ItemsPassManifest | undefined
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.items
  if (!manifest || !Array.isArray(manifest.frames) || !explodeFrames(scene, ITEMS_PACKED_KEY, packed, manifest.frames, itemsArtKey)) return null
  initItemsManifest(manifest)

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

  return manifest
}

/** The mill wheel's turn: four frames (one eighth-turn in four steps), 32 px across. */
export const MILL_WHEEL_FRAMES = 4
export const MILL_WHEEL_SIZE = 32

/** The texture keys of one wheel's turn, in order (installed by installItemsPass). */
export function millWheelKeys(mended: boolean): string[] {
  return Array.from({ length: MILL_WHEEL_FRAMES }, (_, i) => `mill-wheel-${mended ? 'mended-' : ''}${i}`)
}

/**
 * Install the delivered mill textures under their own keys
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
    const source = artSource(scene, itemsArtKey(name))
    if (!source) continue
    const [c, ctx] = artCanvas(source.w, source.h, source.density)
    drawArt(ctx, source, 0, 0)
    addArtCanvas(scene, name, c, source.density)
  }
}

/**
 * The delivered world-sprite frame for a placed home good (its footprint
 * art, e.g. `world-writing-desk`), honouring a state (`lit`, `unlit-pane`),
 * else null. Scenes draw placed pieces from this when no runtime `deco-`
 * texture exists.
 */
export function itemWorldArt(itemId: string, state?: string): string | null {
  if (state !== undefined) {
    const byState = worldByItemState.get(`${itemId}:${state}`)
    if (byState) return itemsArtKey(byState.key)
  }
  const byItem = worldByItemId.get(itemId)
  if (byItem) return itemsArtKey(byItem.key)
  // No world sprite: a commons alias (e.g. woodpile → commons:woodpile)
  // names a runtime texture the scenes already have.
  const alias = aliases[itemId]
  if (alias?.startsWith('commons:')) return 'commons-art:' + alias.slice('commons:'.length)
  // The crafts pass's pieces (the stable).
  const crafts = CRAFTS_WORLD_ART[itemId]
  if (crafts) return craftsArt(crafts)
  return null
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

/** A UI data URL of a delivered item frame, `scale` image px per world px. */
export function itemDataUrl(scene: Phaser.Scene, frameOrKey: string, scale = 1): string | null {
  const key = frameOrKey.startsWith(ITEMS_ART_PREFIX) || frameOrKey.startsWith('commons-art:')
    ? frameOrKey
    : (aliases[frameOrKey]?.startsWith('commons:')
        ? 'commons-art:' + aliases[frameOrKey].slice('commons:'.length)
        : itemsArtKey(aliases[frameOrKey] ?? frameOrKey))
  const src = artSource(scene, key)
  return src ? artDataUrl(src, scale) : null
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
