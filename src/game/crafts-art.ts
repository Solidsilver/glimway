/**
 * The 0.5 crafts pass (assets/generated/crafts-pass/, docs/design/crafts.md
 * 9): ability icons and effects, the stable's layers, fishing, the HUD
 * icons and the pet heart. The build packs every frame's whole canvas at 64
 * texels per 16-px tile (scripts/build-atlases.ts → crafts.webp, loaded as
 * `packed-crafts`); at boot each becomes a dense texture `crafts-art:<frame>`
 * at its world size (./density.ts), so `scene.add.image(x, y,
 * craftsArt('saddle'))` draws it at 16 × 16 world px with no scaling.
 *
 * Missing art is never fatal: callers check `craftsFrame` and draw a
 * placeholder (or nothing) when a frame didn't load.
 */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'
import { explodeFrames, registerAnims, type PassAnimation } from './art-pass.ts'
import { TILE } from '../lib/tile.ts'
import { artDataUrl, artSource } from './density.ts'
import { CRAFTS_ART_PREFIX, craftsArt } from '../lib/crafts-art-key.ts'

export { CRAFTS_ART_PREFIX, craftsArt }
export { stableLayout, bayFrontPiece, stableFootprint, type StableLayout, type StablePiece, type StableBay } from '../lib/stable-layout.ts'

/** Texture key of the packed crafts atlas (./packed.ts loads it). */
export const CRAFTS_PACKED_KEY = 'packed-crafts'

/** The pass's density: texels per 16-px world tile (4 per world px). */
export const CRAFTS_DENSITY = 64

/**
 * The pass's loops, as frame strips (left to right). Effects for lane F,
 * fishing for lane G; the pet heart rises once (repeat 0). Nothing here
 * plays on its own: callers start them.
 */
export const CRAFTS_ANIMS: PassAnimation[] = [
  { key: 'stand-ground-ring', frames: ['stand-ground-ring-0', 'stand-ground-ring-1', 'stand-ground-ring-2', 'stand-ground-ring-3'], frameRate: 8, repeat: 0 },
  { key: 'kindle-hollow-light', frames: ['kindle-hollow-light-0', 'kindle-hollow-light-1', 'kindle-hollow-light-2', 'kindle-hollow-light-3'], frameRate: 5, repeat: -1 },
  { key: 'ward-light-pulse', frames: ['ward-light-circle-1', 'ward-light-circle-2', 'ward-light-circle-3'], frameRate: 8, repeat: 0 },
  { key: 'float-bob', frames: ['float-0', 'float-1', 'float-2', 'float-3'], frameRate: 3, repeat: -1 },
  { key: 'float-bite', frames: ['float-4', 'float-5'], frameRate: 6, repeat: -1 },
  { key: 'water-rings', frames: ['water-rings-0', 'water-rings-1', 'water-rings-2'], frameRate: 3, repeat: -1 },
  { key: 'landing-splash', frames: ['landing-splash-0', 'landing-splash-1', 'landing-splash-2', 'landing-splash-3'], frameRate: 10, repeat: 0 },
  { key: 'pet-heart', frames: ['pet-heart-0', 'pet-heart-1', 'pet-heart-2'], frameRate: 6, repeat: 0 }
]

/** Make the crafts textures and loops (`crafts-art:<anim>`), once. False when the pack didn't load. */
export function createCraftsArt(scene: Phaser.Scene): boolean {
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.crafts
  if (!packed) return false
  // The pack's density is texels per tile; the passes' loader counts per world px.
  const perPx = packed.density / TILE
  const frames = Object.entries(packed.frames).map(([key, r]) => ({ key, width: r[2] / perPx, height: r[3] / perPx }))
  const made = explodeFrames(scene, CRAFTS_PACKED_KEY, { ...packed, density: perPx }, frames, craftsArt)
  if (!made) return false
  registerAnims(scene, CRAFTS_ANIMS.map((a) => ({ ...a, key: craftsArt(a.key), frames: a.frames.map(craftsArt) })), (f) => scene.textures.exists(f))
  return true
}

/** Whether a crafts frame loaded (by frame name, e.g. `stable-bay-back`). */
export function craftsFrame(scene: Phaser.Scene, name: string): boolean {
  return scene.textures.exists(craftsArt(name))
}

/** The HUD icons the UI shows (EV-free: callers emit them where they need them). */
export const CRAFTS_ICONS = [
  'companions-tab',
  'saddle',
  'go-home',
  'ability-warrior-cleave',
  'ability-warrior-stand',
  'ability-mage-fingersnap',
  'ability-mage-kindle',
  'ability-healer-mend',
  'ability-healer-ward-light',
  'ability-rogue-shadowstep',
  'ability-rogue-echo',
  'rod-icon',
  'mill-roach',
  'millers-fry',
  'recipe-card-millers-fry'
] as const

/** Data URLs of crafts frames for Svelte UI (by frame name), at the art's full density. */
export function craftsIconUrls(scene: Phaser.Scene, names: readonly string[] = CRAFTS_ICONS): Record<string, string> {
  const out: Record<string, string> = {}
  for (const frame of names) {
    const src = artSource(scene, craftsArt(frame))
    if (!src) continue
    try {
      out[frame] = artDataUrl(src, src.density)
    } catch {
      /* an icon is optional: the UI draws its own */
    }
  }
  return out
}
