/**
 * The 0.6 purse pass (assets/generated/purse-pass/, docs/design/
 * purse-and-wardrobe.md 9): interface icons only. Glimway's own gold coin
 * (a lamp stamped on its face; not Habitica's stacked coin), the purse, the
 * wardrobe's peg rail, the shelf's price tag and the gold letter. The build
 * packs each frame's whole canvas at 64 texels per 16-px tile
 * (scripts/build-atlases.ts → purse.webp, loaded as `packed-purse`); at boot
 * each becomes a dense texture `pu-art:<frame>`, and the interface gets them
 * as icon URLs (EV.artIcons). Missing art is never fatal: the interface
 * draws its own coin (src/ui/Icon.svelte `coin`).
 */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'
import { explodeFrames } from './art-pass.ts'
import { TILE } from '../lib/tile.ts'
import { artDataUrl, artSource } from './density.ts'

/** Texture key of the packed purse atlas (./packed.ts loads it). */
export const PURSE_PACKED_KEY = 'packed-purse'

export const puArt = (frame: string): string => `pu-art:${frame}`

/**
 * The interface's icon keys (ui.artIcons, src/ui/ArtIcon.svelte), by the
 * pass's frame. `wardrobe` is lane E's (the Character panel's Wardrobe tab).
 */
export const PURSE_ICONS: Readonly<Record<string, string>> = {
  'purse-gold': 'gold-coin',
  'purse-gold-hud': 'gold-coin-hud',
  purse: 'purse',
  'purse-price-tag': 'price-tag',
  'purse-gold-letter': 'gold-letter',
  wardrobe: 'wardrobe'
}

/** Make the purse textures, once. False when the pack didn't load. */
export function createPurseArt(scene: Phaser.Scene): boolean {
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.purse
  if (!packed) return false
  const perPx = packed.density / TILE
  const frames = Object.entries(packed.frames).map(([key, r]) => ({ key, width: r[2] / perPx, height: r[3] / perPx }))
  return !!explodeFrames(scene, PURSE_PACKED_KEY, { ...packed, density: perPx }, frames, puArt)
}

/** The pass's interface icons (EV.artIcons), drawn at the art's full density. */
export function purseIconUrls(scene: Phaser.Scene): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, frame] of Object.entries(PURSE_ICONS)) {
    const src = artSource(scene, puArt(frame))
    if (!src) continue
    try {
      out[key] = artDataUrl(src, src.density)
    } catch {
      /* an icon is optional: the interface draws its own */
    }
  }
  return out
}
