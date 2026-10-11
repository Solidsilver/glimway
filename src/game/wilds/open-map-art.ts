/**
 * The 0.8 open map pass (assets/generated/open-map-pass/, docs/design/
 * open-map.md 5): meadow props, the landmarks, bank stones, fords, the
 * Lantern Road's paving and verges, laid paths, the dark lamp stone, the
 * frontier veil, the rumour's bundle, the way sign and the Map tab icon.
 * The build packs each frame's whole canvas at 64 texels per 16-px tile
 * (scripts/build-atlases.ts → open-map.webp, loaded as `packed-open-map`);
 * at boot each becomes a dense texture `om-art:<frame>` at its world size,
 * and the ford and veil loops become animations. Missing art is never
 * stood in for: a piece whose texture didn't load is left out.
 */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from '../atlas-plan.ts'
import { explodeFrames, registerAnims } from '../art-pass.ts'
import { TILE } from '../../lib/tile.ts'
import type { DecorKind } from './decor.ts'
import animations from '../../../assets/generated/open-map-pass/animations.json' with { type: 'json' }

/** Texture key of the packed open-map atlas (../packed.ts loads it). */
export const OPEN_MAP_PACKED_KEY = 'packed-open-map'

export const omArt = (frame: string): string => `om-art:${frame}`

/** The ford's and the veil's loops (the pass's animations.json), by their keys. */
export const FORD_H_ANIM = omArt('ford-h-ripple')
export const FORD_V_ANIM = omArt('ford-v-ripple')
export const VEIL_ANIM = omArt('frontier-veil')

/** Make the open map's textures and loops, once. False when the pack didn't load. */
export function createOpenMapArt(scene: Phaser.Scene): boolean {
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.openMap
  if (!packed) return false
  const perPx = packed.density / TILE
  const frames = Object.entries(packed.frames).map(([key, r]) => ({ key, width: r[2] / perPx, height: r[3] / perPx }))
  const made = explodeFrames(scene, OPEN_MAP_PACKED_KEY, { ...packed, density: perPx }, frames, omArt)
  if (!made) return false
  const held = new Set(made.held.map((f) => f.key))
  registerAnims(scene, animations, (f) => held.has(f), omArt)
  return true
}

/** Variants delivered per open-map decor kind (frame `<prefix>-<n>`, or one frame when 1). */
const DECOR_FRAMES: Partial<Record<DecorKind, { prefix: string; variants: number }>> = {
  'meadow-grass': { prefix: 'meadow-grass', variants: 3 },
  'meadow-flowers': { prefix: 'meadow-flowers', variants: 3 },
  'meadow-outcrop': { prefix: 'meadow-outcrop', variants: 2 },
  'meadow-oak': { prefix: 'meadow-oak', variants: 1 },
  'meadow-stone': { prefix: 'meadow-stone', variants: 2 },
  'bank-stones': { prefix: 'bank-stones', variants: 3 },
  'split-oak': { prefix: 'landmark-split-oak', variants: 1 },
  'standing-stone': { prefix: 'landmark-standing-stone', variants: 1 },
}

/** The delivered texture for an open-map decor piece, or null for the code-drawn woods kinds. */
export function openMapDecor(kind: DecorKind, variant: number): string | null {
  const f = DECOR_FRAMES[kind]
  if (!f) return null
  return omArt(f.variants === 1 ? f.prefix : `${f.prefix}-${variant % f.variants}`)
}

/** Every decor kind the pass draws (the rest are the code-drawn woods). */
export const OPEN_MAP_DECOR_KINDS = Object.keys(DECOR_FRAMES) as DecorKind[]

/** Ground tile art laid over the painted ground, by the ground it stands for. */
export const ROAD_PAVING = [0, 1, 2, 3].map((i) => omArt(`road-paving-${i}`))
export const ROAD_VERGE = [0, 1].map((i) => omArt(`road-verge-${i}`))
export const PATH_STONE = [0, 1, 2, 3].map((i) => omArt(`path-stone-${i}`))
export const PATH_PLANK_H = [0, 1].map((i) => omArt(`path-plank-h-${i}`))
export const PATH_PLANK_V = [0, 1].map((i) => omArt(`path-plank-v-${i}`))
export const FORD_H = omArt('ford-h-0')
export const FORD_V = omArt('ford-v-0')
export const LAMP_STONE_DARK = omArt('lamp-stone-dark')
export const VEIL = omArt('frontier-veil-0')
