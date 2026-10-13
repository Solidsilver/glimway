/**
 * The 0.6.1 glims pass (assets/generated/glims-pass/, docs/design/
 * silas-yard.md 1.9): interface icons only. A glim (a round faceted amber
 * bead with a bright core), its HUD size, and a few glims together for the
 * log, letters and the toast. The build packs each frame's whole canvas at
 * 64 texels per 16-px tile (scripts/build-atlases.ts → glims.webp, loaded as
 * `packed-glims`); at boot each becomes a dense texture `gl-art:<frame>`, and
 * the interface gets them as icon URLs (EV.artIcons). Missing art is never
 * fatal: the interface draws its own bead (src/ui/Icon.svelte `glim`).
 */
import type Phaser from 'phaser'
import { createInterfaceArt, interfaceIconUrls } from './interface-art.ts'

/** Texture key of the packed glims atlas (./packed.ts loads it). */
export const GLIMS_PACKED_KEY = 'packed-glims'

export const glArt = (frame: string): string => `gl-art:${frame}`

/** The interface's icon keys (ui.artIcons, src/ui/ArtIcon.svelte), by the pass's frame. */
export const GLIMS_ICONS: Readonly<Record<string, string>> = {
  glim: 'glim',
  'glim-hud': 'glim-hud',
  'glims-few': 'glims-few'
}

/** Make the glims textures, once. False when the pack didn't load. */
export function createGlimsArt(scene: Phaser.Scene): boolean {
  return createInterfaceArt(scene, 'glims', GLIMS_PACKED_KEY, glArt)
}

/** The pass's interface icons (EV.artIcons), drawn at the art's full density. */
export function glimsIconUrls(scene: Phaser.Scene): Record<string, string> {
  return interfaceIconUrls(scene, GLIMS_ICONS, glArt)
}
