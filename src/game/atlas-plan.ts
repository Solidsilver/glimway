/**
 * What the packed atlases (scripts/build-atlases.ts → public/assets/fingersnap/packed/)
 * hold, shared by the build and the runtime so they can't drift apart.
 *
 * Two kinds of art ship:
 *
 *  - Canvas-blitted packs (the Commons pass, the runtime pass, the expansion
 *    terrain): the loaders used to sample each measured source rect into a
 *    native-size canvas at boot. The build does that same blit (in Chromium,
 *    the same canvas code) and packs the results, so the loaders now copy
 *    those pixels 1:1 — identical to what they produced before. A few call
 *    sites sample the Commons pass at other sizes (refitted decorations, the
 *    Wilds decor boxes, a mirrored fence corner): those are baked too
 *    (`commonsBlitPlan`) and fetched by key.
 *  - GPU-scaled atlases (the hero walk, enemies, foreground occluders, the
 *    props): scenes draw these frames with `setScale(display / frame size)`
 *    and the camera zooms the world (1.5–5×, 1.3× more during the lantern
 *    beat in the ruin), so they're sampled at up to 5 (6.5) screen px per
 *    world px. The build bakes each frame at that largest on-screen size
 *    (never above its source), and call sites keep scaling from frame sizes
 *    as before.
 */
import { DECOR_ART } from '../lib/wilds/tangle.ts'
import type { DecorKind } from '../lib/wilds/types.ts'
import { HOMESTEAD_DATA } from '../lib/homestead.ts'
import type { CommonsPassFrame } from './commons-pass.ts'
import { TANGLE_VARIANTS } from './wilds/tangle-key.ts'

export const PACKED_BASE = '/assets/fingersnap/packed/'
/** Bump when the baking itself changes (tests/atlases.test.ts compares it). */
export const ATLAS_GENERATOR_VERSION = 4
export const PACKED_MANIFEST_KEY = 'fingersnap-packed'

/**
 * Texels per world px of the canvas-blitted packs and the terrain (the
 * hero, trees and props are GPU-scaled, below, and denser still). The
 * build box-filters each frame down from its full-resolution sheet to this
 * density; scenes draw it at the same world size (./density.ts).
 */
export const ART_DENSITY = 4
/**
 * What phones keep (./density.ts `artDensity`): they frame the world at 2
 * screen px per world px, so the packs are box-filtered 2:1 at boot.
 */
export const PHONE_ART_DENSITY = 2

/** Largest camera zoom (WorldScene.zoomFor). */
export const MAX_SCREEN_SCALE = 5
/** The lantern beat pushes in 1.3× more (the ruin: hero, shrine, arch, ferns, chest, route stone). */
export const BEAT_SCREEN_SCALE = MAX_SCREEN_SCALE * 1.3

/** A packed rect: x, y, w, h in the atlas image. */
export type PackedRect = [number, number, number, number]

export interface PackedCanvasPack {
  image: string
  size: [number, number]
  /** Texels per world px (ART_DENSITY); rects below are in texels. */
  density: number
  /** Native frame canvases, whole (transparent margins included). */
  frames: Record<string, PackedRect>
  /** Off-native samples of a frame, by `blitKey`. */
  blits?: Record<string, PackedRect>
}

/**
 * The playtest-1 ground tiles: one 16-px world tile each, `cell` texels a
 * side at `density`, in a `cols`-wide grid in the order of GROUND_TILES. Their
 * borders are healed at build time (./ground-heal.ts) so every tile of a
 * family meets every other one without a seam.
 */
export interface PackedGround {
  image: string
  size: [number, number]
  cell: number
  density: number
  cols: number
  /** Cell index by frame name. */
  tiles: Record<string, number>
  /** Whether the borders were healed (an unhealed bake is for comparisons only). */
  healed: boolean
}

/** One frame of the people atlas: a trimmed rect of a `source`-sized canvas (texels). */
export interface PackedPersonFrame {
  /** x, y, w, h in the atlas image. */
  frame: PackedRect
  /** Where the trimmed rect sits on the frame's whole canvas. */
  at: [number, number]
  /** The whole canvas (residents 64×128; held tools HELD_TEXELS a side). */
  source: [number, number]
  /** Held tools: the hand's grip on the canvas (texels). */
  hand?: [number, number]
}

/**
 * The playtest-1 people: the residents' walking, breathing and sitting
 * frames and the held tools, trimmed and packed as one Phaser atlas at
 * `density` (every rect a multiple of 4 texels, so phones and the Canvas
 * renderer scale it down exactly).
 */
export interface PackedPeople {
  image: string
  size: [number, number]
  density: number
  frames: Record<string, PackedPersonFrame>
  animations: { key: string; frames: string[]; frameRate: number; repeat: number }[]
}

export interface PackedManifest {
  version: number
  generator: string
  /** Every input the build read, with its sha256 (the staleness test re-hashes them). */
  inputs: Record<string, string>
  commons: PackedCanvasPack
  runtime: PackedCanvasPack
  items: PackedCanvasPack
  /** The 16 terrain cells, 4×4, each `cell` texels a side (one 16-px world tile at `density`). */
  terrain: { image: string; size: [number, number]; cell: number; density: number }
  ground: PackedGround
  people: PackedPeople
  /** Phaser atlases (image + JSON hash), loaded under their old texture keys. */
  atlases: Record<string, { image: string; json: string }>
  backdrops: Record<string, string>
}

/** The playtest-1 pass (assets/generated/playtest1-pass/): its frame atlas and animations. */
export const PLAYTEST1_DIR = 'assets/generated/playtest1-pass'

// The playtest-1 ground tiles (also read by the ground-painting worker).
export * from './ground-tiles.ts'

/** The residents with walking art (the frame prefix is `resident-<id>-`). */
export const PEOPLE = ['mara', 'pip', 'orrin', 'silas', 'elara', 'finn', 'hazel', 'ada'] as const
export type PersonId = (typeof PEOPLE)[number]

/**
 * Held tools: the delivered frames sit on a 32×32 canvas (8 world px at the
 * pass's density). They're drawn HELD_WORLD world px a side, so the build
 * bakes them at that size (HELD_TEXELS at ART_DENSITY), the destination
 * rects and hand anchors scaled by HELD_TEXELS / 32.
 */
export const HELD_WORLD = 10
export const HELD_TEXELS = HELD_WORLD * ART_DENSITY
export const HELD_SOURCE = 32

/** Key for a baked off-native sample of a frame. */
export function blitKey(frame: string, w: number, h: number, flipX: boolean): string {
  return `${frame}@${w}x${h}${flipX ? '~f' : ''}`
}

/**
 * Delivered Wilds props (Commons pass) that take a decor kind's place, by
 * look (src/game/wilds/tangle-art.ts draws them). The White Quiet keeps its
 * frosted code-drawn woods but for the pale drift-stone and white cairns;
 * turncaps always lean east, so they're never mirrored.
 */
export const DELIVERED_DECOR: Partial<Record<DecorKind, string>> = {
  log: 'fallen-log',
  boulder: 'mossy-boulder',
  cairn: 'cairn',
  turncaps: 'turncaps-east',
  'ring-stump': 'iron-oak-stump',
}
export const DELIVERED_DECOR_QUIET: Partial<Record<DecorKind, string>> = {
  boulder: 'drift-stone',
  cairn: 'cairn-white-stones',
}

/** Odd decor variants are mirrored, except turncaps. */
export function decorFlipped(kind: DecorKind, variant: number): boolean {
  return kind !== 'turncaps' && variant % 2 === 1
}

/**
 * The largest aspect-true rect for a source crop inside a `w`×`h` box,
 * bottom-centred (feet on the box's base).
 */
export function fitRect(sourceRect: { w: number; h: number }, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(w / sourceRect.w, h / sourceRect.h)
  const dw = Math.max(1, Math.round(sourceRect.w * scale))
  const dh = Math.max(1, Math.round(sourceRect.h * scale))
  return { x: Math.floor((w - dw) / 2), y: h - dh, w: dw, h: dh }
}

/** One off-native sample of a Commons-pass frame the runtime asks for. */
export interface CommonsBlit {
  frame: string
  w: number
  h: number
  flipX: boolean
}

/**
 * Every sample of a Commons-pass frame drawn at other than its native
 * destination size, or mirrored: the refitted decorations
 * (`decorationLayout`), the Wilds decor boxes, and the mirrored fence corner
 * at the end of a run. Native-size draws copy the native canvas instead.
 */
export const COMMONS_DECORATION_IDS = new Set([
  'wooden-stool',
  'reading-chair',
  'braided-rug',
  'iron-lantern',
  'oak-table',
  'potted-fern',
  'bookshelf',
  'wash-basin',
  'lantern-post',
  'stone-hearth',
  'carved-bed',
  'woven-basket',
  'display-stand',
  'tool-rack',
  'amber-sconce',
])

export function commonsBlitPlan(frames: readonly CommonsPassFrame[]): CommonsBlit[] {
  const byKey = new Map(frames.map((f) => [f.key, f]))
  const out = new Map<string, CommonsBlit>()
  const add = (frame: CommonsPassFrame, w: number, h: number, flipX: boolean) => {
    if (!flipX && w === frame.destinationRect.w && h === frame.destinationRect.h) return
    out.set(blitKey(frame.key, w, h, flipX), { frame: frame.key, w, h, flipX })
  }
  for (const it of HOMESTEAD_DATA.items) {
    if (!COMMONS_DECORATION_IDS.has(it.id)) continue
    const f = byKey.get(it.id)
    if (!f) continue
    for (const quarter of [false, true]) {
      const { dest } = decorationLayout(it.id, f, it.footprint, quarter)
      add(f, dest.w, dest.h, false)
    }
  }
  for (const table of [DELIVERED_DECOR, DELIVERED_DECOR_QUIET]) {
    for (const [kind, name] of Object.entries(table) as [DecorKind, string][]) {
      const f = byKey.get(name)
      if (!f) continue
      const r = fitRect(f.sourceRect, DECOR_ART[kind].w, DECOR_ART[kind].h)
      for (let v = 0; v < TANGLE_VARIANTS; v++) add(f, r.w, r.h, decorFlipped(kind, v))
    }
  }
  const corner = byKey.get('fence-corner')
  if (corner) add(corner, corner.destinationRect.w, corner.destinationRect.h, true)
  return [...out.values()]
}

/** A GPU-scaled atlas the build re-bakes at its largest on-screen size. */
export interface ScaledAtlasPlan {
  /** Texture key the scenes use. */
  key: string
  /** Source image and Phaser JSON hash under assets/generated/. */
  source: string
  json: string
  /**
   * World-px display size per frame group: frames in one group share one
   * scale (an animation's frames, so they keep their relative size), set by
   * the group's reference frame drawn `height` (or `width`) world px tall,
   * at up to `screen` screen px per world px (MAX_SCREEN_SCALE by default).
   */
  groups: { frames: RegExp; ref: string; height?: number; width?: number; screen?: number }[]
}

/**
 * Display sizes, the largest each frame is drawn in world px (call sites:
 * hero.ts/remote-players.ts 20 px hero; enemies.ts 14/13 px; foreground spots
 * in worlds.ts/commons.ts and the mossy-arch POI; prop `h` values in
 * worlds.ts, commons.ts, homesteads.ts, wilds/entities.ts, wilds/sites.ts).
 * A frame drawn larger than listed would be upsampled on screen.
 */
export const SCALED_ATLASES: ScaledAtlasPlan[] = [
  {
    key: 'fingersnap-demo-walk',
    source: 'assets/generated/expansion/fingersnap-demo-walk.png',
    json: 'assets/generated/expansion/fingersnap-demo-walk.atlas.json',
    groups: [{ frames: /^walk-/, ref: 'walk-down-0', height: 20, screen: BEAT_SCREEN_SCALE }],
  },
  {
    key: 'fingersnap-enemies',
    source: 'assets/generated/expansion/fingersnap-enemies.png',
    json: 'assets/generated/expansion/fingersnap-enemies.atlas.json',
    groups: [
      { frames: /^slime-/, ref: 'slime-idle', height: 14 },
      { frames: /^mushroom-/, ref: 'mushroom-idle', height: 14 },
      { frames: /^beetle-/, ref: 'beetle-idle', height: 13 },
    ],
  },
  {
    key: 'fingersnap-foreground',
    source: 'assets/generated/expansion/fingersnap-foreground.png',
    json: 'assets/generated/expansion/fingersnap-foreground.atlas.json',
    groups: [
      { frames: /^oak-canopy$/, ref: 'oak-canopy', width: 64 },
      { frames: /^pine-canopy$/, ref: 'pine-canopy', width: 63 },
      { frames: /^leafy-arch$/, ref: 'leafy-arch', width: 74 },
      { frames: /^stone-arch$/, ref: 'stone-arch', width: 48, screen: BEAT_SCREEN_SCALE },
      { frames: /^fern-cluster$/, ref: 'fern-cluster', width: 28, screen: BEAT_SCREEN_SCALE },
      // Not placed today; kept at a cottage's width.
      { frames: /^cottage-roof$/, ref: 'cottage-roof', width: 96 },
    ],
  },
  {
    key: 'fingersnap-props',
    source: 'assets/generated/fingersnap-props.png',
    json: 'assets/generated/fingersnap-props.atlas.json',
    groups: [
      { frames: /^lantern-post$/, ref: 'lantern-post', height: 32 },
      { frames: /^lantern-shrine$/, ref: 'lantern-shrine', height: 40, screen: BEAT_SCREEN_SCALE },
      { frames: /^trail-sign$/, ref: 'trail-sign', height: 24 },
      { frames: /^stone-milestone$/, ref: 'stone-milestone', height: 22, screen: BEAT_SCREEN_SCALE },
      { frames: /^patched-bench$/, ref: 'patched-bench', height: 18 },
      { frames: /^bread-basket$/, ref: 'bread-basket', height: 12 },
      { frames: /^flower-planter$/, ref: 'flower-planter', height: 16 },
      { frames: /^tool-crate$/, ref: 'tool-crate', height: 16 },
      { frames: /^expedition-backpack$/, ref: 'expedition-backpack', height: 18 },
      { frames: /^treasure-chest$/, ref: 'treasure-chest', height: 20, screen: BEAT_SCREEN_SCALE },
      { frames: /^mushroom-cluster$/, ref: 'mushroom-cluster', height: 12 },
      { frames: /^grappling-rope$/, ref: 'grappling-rope', height: 14 },
    ],
  },
]

/** Title/journal illustrations: source, and the largest width they're shown at (device px). */
export const BACKDROPS: { key: string; source: string; width: number }[] = [
  // The title screen covers the whole viewport: keep every source pixel.
  { key: 'fingersnap-village', source: 'assets/generated/fingersnap-village.png', width: 1536 },
  // Only the journal's 600-px-wide header (×2 for high-density screens).
  { key: 'fingersnap-shrine', source: 'assets/generated/fingersnap-shrine.png', width: 1200 },
]

/**
 * Two-tile pieces whose delivered slot squeezes the art into one tile's
 * width (bookshelf 16 of 32 px, hearth 15, tool rack 21): refit the measured
 * crop to the footprint's width, rising above it like the placeholders did.
 * Max height in px (footprint height + rise).
 */
const DECO_REFIT: Readonly<Record<string, number>> = {
  bookshelf: 32,
  'stone-hearth': 32,
  'tool-rack': 26,
}

/**
 * Where a decoration's delivered art sits on its texture (anchored
 * bottom-left at the footprint's base, as `decoKey` textures are). The
 * delivered slots are footprint-sized; the two-tile pieces in DECO_REFIT are
 * refitted to the footprint's width. A quarter-turned view (90/270) is the
 * same front view fitted to the turned footprint.
 */
export function decorationLayout(
  id: string,
  frame: Pick<CommonsPassFrame, 'width' | 'height' | 'sourceRect' | 'destinationRect'>,
  footprint: [number, number],
  quarter: boolean,
): { width: number; height: number; dest: { x: number; y: number; w: number; h: number } } {
  const [fw, fh] = quarter ? [footprint[1], footprint[0]] : footprint
  const w = fw * 16
  const h = fh * 16
  const refit = DECO_REFIT[id]
  if (!quarter && refit) {
    const height = Math.max(h, refit)
    return { width: w, height, dest: fitRect(frame.sourceRect, w, height) }
  }
  if (!quarter && frame.width === w) {
    const height = Math.max(h, frame.height)
    return { width: w, height, dest: { ...frame.destinationRect, y: frame.destinationRect.y + height - frame.height } }
  }
  const height = Math.max(h, refit ?? h)
  const boxH = Math.min(height, Math.max(h, frame.destinationRect.h))
  const r = fitRect(frame.sourceRect, w, boxH)
  return { width: w, height, dest: { ...r, y: r.y + height - boxH } }
}
