/**
 * The Hearthwick 2 pass (assets/generated/hearthwick2-pass/, docs/design/
 * hearthwick-2.md 7): the Wick Tree in each Mark, the hearth-stone, the
 * town's new buildings (townhouses, cottages, the inn, chandler, land
 * office, smithy, guildhouse, Orrin's workshop, the barn), the shop signs,
 * the town and farm dressing, the lot stakes and side gateposts, and the
 * wildgate arch.
 * The build packs each frame's whole canvas at 64 texels per 16-px tile
 * (scripts/build-atlases.ts → hearthwick2.webp, loaded as
 * `packed-hearthwick2`); at boot each becomes a dense texture
 * `hw2:<frame>` at its world size, and the pass's loops (the embers, the
 * forge, the washing line, the spring) become animations `hw2:<loop>`.
 * The layouts name these keys as scenery (scripts/export-hearthwick.ts).
 * Missing art is never stood in for: a piece whose texture didn't load is
 * left out.
 */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'
import { explodeFrames, registerAnims } from './art-pass.ts'
import { TILE } from '../lib/tile.ts'

/** Texture key of the packed Hearthwick 2 atlas (./packed.ts loads it). */
export const HEARTHWICK2_PACKED_KEY = 'packed-hearthwick2'

export const hw2Art = (frame: string): string => `hw2:${frame}`

/** A looping piece's first frame's texture key → its loop's animation key. */
const loops = new Map<string, string>()

/** Make the pass's textures and loops, once. False when the pack didn't load. */
export function createHearthwick2Art(scene: Phaser.Scene): boolean {
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.hearthwick2
  if (!packed) return false
  const perPx = packed.density / TILE
  const frames = Object.entries(packed.frames).map(([key, r]) => ({ key, width: r[2] / perPx, height: r[3] / perPx }))
  const made = explodeFrames(scene, HEARTHWICK2_PACKED_KEY, { ...packed, density: perPx }, frames, hw2Art)
  if (!made) return false
  const held = new Set(made.held.map((f) => f.key))
  registerAnims(scene, packed.animations, (f) => held.has(f), hw2Art)
  for (const a of packed.animations) if (a.frames.length && scene.anims.exists(hw2Art(a.key))) loops.set(hw2Art(a.frames[0]!), hw2Art(a.key))
  return true
}

/** The loop a piece drawn with this texture plays (its first frame), or null. */
export function loopOf(key: string): string | null {
  return loops.get(key) ?? null
}

/**
 * Pieces the hero walks under or behind, which fade while someone is
 * beneath them (../area/foreground.ts): the Wick Tree's crown, the fruit
 * trees, the wildgate arches, the living portal.
 */
export function fadesOver(key: string): boolean {
  return /^hw2:(wick-tree|fruit-tree)-|^hw2:wildgate-arch(-side)?$|^hw2:living-portal-/.test(key)
}

/**
 * Pieces drawn smaller than delivered: the forge's fire is a 32×24 px
 * flame, and the smithy's forge mouth is about 14 px across.
 */
export function drawScale(key: string): number {
  return key === 'hw2:forge-glow-0' ? 0.5 : 1
}

/** A lot's side gatepost (../entities/homestead-art.ts draws a pair at each lot gate). */
export const SIDE_GATEPOST = hw2Art('lot-gatepost-side')
/** Where the post stands across its canvas (its body is texels 8..19 of 56; the hook reaches right). */
export const SIDE_GATEPOST_FOOT = 13.5 / 56
