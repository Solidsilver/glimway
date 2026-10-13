/**
 * The 0.6 purse pass (assets/generated/purse-pass/, docs/design/
 * purse-and-wardrobe.md 9): interface icons only. Glimway's own gold coin
 * (a lamp stamped on its face; not Habitica's stacked coin), the purse, the
 * wardrobe's peg rail, the shelf's price tag and the gold letter. The build
 * packs each frame's whole canvas at 64 texels per 16-px tile
 * (scripts/build-atlases.ts → purse.webp, loaded as `packed-purse`); at boot
 * each becomes a dense texture `pu-art:<frame>`, and the interface gets them
 * as icon URLs (EV.artIcons). Missing art is never fatal: the interface
 * draws its own (src/ui/Icon.svelte).
 */
import type Phaser from 'phaser'
import { createInterfaceArt, interfaceIconUrls } from './interface-art.ts'

/** Texture key of the packed purse atlas (./packed.ts loads it). */
export const PURSE_PACKED_KEY = 'packed-purse'

export const puArt = (frame: string): string => `pu-art:${frame}`

/**
 * The interface's icon keys (ui.artIcons, src/ui/ArtIcon.svelte), by the
 * pass's frame. `wardrobe` is lane E's (the Character panel's Wardrobe tab).
 * The coin, the purse and the gold letter stay packed but unused: glims
 * replaced the purse's gold (silas-yard.md 1.9, ./glims-art.ts).
 */
export const PURSE_ICONS: Readonly<Record<string, string>> = {
  'purse-price-tag': 'price-tag',
  wardrobe: 'wardrobe'
}

/** Make the purse textures, once. False when the pack didn't load. */
export function createPurseArt(scene: Phaser.Scene): boolean {
  return createInterfaceArt(scene, 'purse', PURSE_PACKED_KEY, puArt)
}

/** The pass's interface icons (EV.artIcons), drawn at the art's full density. */
export function purseIconUrls(scene: Phaser.Scene): Record<string, string> {
  return interfaceIconUrls(scene, PURSE_ICONS, puArt)
}
