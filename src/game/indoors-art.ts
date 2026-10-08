/**
 * The 0.4 indoors pass (assets/generated/indoors-pass/, docs/design/indoors.md
 * 7): the interior kit, the three rooms' furniture, the smoke and lit
 * windows. The build packs every frame's whole canvas at 64 texels per
 * 16-px tile (scripts/build-atlases.ts → indoors.webp, loaded as
 * `packed-indoors`); at boot each becomes a dense texture `in-art:<frame>`
 * at its world size (./density.ts), and the loops below are registered.
 *
 * Missing art is never fatal: rooms draw the kit's placeholder boxes
 * (./area/room-art.ts) for any frame that didn't load.
 */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'
import { explodeFrames, registerAnims, type PassAnimation } from './art-pass.ts'
import { TILE } from '../lib/tile.ts'
import { artDataUrl, artSource } from './density.ts'

/** Texture key of the packed indoors atlas (./packed.ts loads it). */
export const INDOORS_PACKED_KEY = 'packed-indoors'

export const inArt = (frame: string): string => `in-art:${frame}`

/**
 * The loops this game plays. Not the manifest's whole list: the floor and
 * back-wall "animations" are variants (picked per tile), the sponge, the
 * shelves and the hoist are states, and smoke frames 4 and 5 were cropped
 * wrong in the pass (thin slivers), so the plume loops on the first four.
 */
const LOOPS: PassAnimation[] = [
  { key: 'oven-hearth-fire', frames: ['oven-hearth-fire-0', 'oven-hearth-fire-1', 'oven-hearth-fire-2', 'oven-hearth-fire-3'], frameRate: 4, repeat: -1 },
  { key: 'millstones', frames: ['millstones-0', 'millstones-1', 'millstones-2', 'millstones-3'], frameRate: 4, repeat: -1 },
  { key: 'gear-train', frames: ['gear-train-0', 'gear-train-1', 'gear-train-2', 'gear-train-3'], frameRate: 4, repeat: -1 },
  { key: 'tallow-steam', frames: ['tallow-pot-steam-0', 'tallow-pot-steam-1', 'tallow-pot-steam-2'], frameRate: 3, repeat: -1 },
  { key: 'reading-lamp-fire', frames: ['reading-lamp-flame-0', 'reading-lamp-flame-1', 'reading-lamp-flame-2'], frameRate: 6, repeat: -1 },
  { key: 'sack-hoist', frames: ['sack-hoist-swing-0', 'sack-hoist-swing-1', 'sack-hoist-swing-2'], frameRate: 4, repeat: -1 },
  { key: 'chimney-smoke', frames: ['chimney-smoke-0', 'chimney-smoke-1', 'chimney-smoke-2', 'chimney-smoke-3'], frameRate: 4, repeat: -1 }
]

/** Make the indoors textures and loops, once. False when the pack didn't load. */
export function createIndoorsArt(scene: Phaser.Scene): boolean {
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.indoors
  if (!packed) return false
  // The pack's density is texels per tile; the passes' loader counts per world px.
  const perPx = packed.density / TILE
  const frames = Object.entries(packed.frames).map(([key, r]) => ({ key, width: r[2] / perPx, height: r[3] / perPx }))
  const made = explodeFrames(scene, INDOORS_PACKED_KEY, { ...packed, density: perPx }, frames, inArt)
  if (!made) return false
  registerAnims(scene, LOOPS.map((l) => ({ ...l, key: inArt(l.key), frames: l.frames.map(inArt) })), (f) => scene.textures.exists(f))
  return true
}

/** Whether an indoors frame loaded. */
export function hasInArt(scene: Phaser.Scene, frame: string): boolean {
  return scene.textures.exists(inArt(frame))
}

/**
 * The pass's interface icons, for the Quests page and the bag (EV.artIcons,
 * by frame name): the shelf icons, the pin, the gate marks and the
 * opening's two keepsakes. Drawn at the art's full density (they're finer
 * than the 16-px item icons).
 */
export const INDOORS_ICONS = [
  'shelf-icon-road',
  'shelf-icon-village',
  'shelf-icon-craft',
  'pin-unpinned',
  'pin-pinned',
  'gate-waiting',
  'gate-needs-embers',
  'gate-locked',
  'keepsake-east-finger',
  'keepsake-tally-token'
] as const

export function indoorsIconUrls(scene: Phaser.Scene): Record<string, string> {
  const out: Record<string, string> = {}
  for (const frame of INDOORS_ICONS) {
    const src = artSource(scene, inArt(frame))
    if (!src) continue
    try {
      out[frame] = artDataUrl(src, src.density)
    } catch {
      /* an icon is optional: the page draws its own */
    }
  }
  return out
}

/**
 * The floor variants used, by family: only the first. The pass's other
 * variants were seam-healed to it at their borders but keep their own tone
 * in the middle, so each reads as a hard-edged patch on the floor
 * (.agent/ART-FIXES.md); the first tiles cleanly with itself.
 */
export const FLOOR_VARIANTS: Readonly<Record<'plank' | 'flagstone', readonly number[]>> = {
  plank: [0],
  flagstone: [0]
}
