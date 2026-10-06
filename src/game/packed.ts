import type Phaser from 'phaser'
import { PACKED_BASE, PACKED_MANIFEST_KEY, SCALED_ATLASES } from './atlas-plan.ts'
import { COMMONS_PACKED_KEY } from './commons-pass.ts'
import { RUNTIME_PACKED_KEY } from './runtime-art.ts'
import { ITEMS_PACKED_KEY } from './items-pass.ts'

/**
 * Load the packed atlases (scripts/build-atlases.ts writes them; see
 * ./atlas-plan.ts for what each holds): the Commons-pass, runtime-pass and
 * items-pass native frames and the normalized terrain tileset as lossless
 * WebP (identical texels, ~35% smaller than PNG), and the hero walk,
 * enemy, foreground and props atlases under the texture keys the scenes
 * already use. A file that fails to load leaves the code-drawn fallbacks in
 * charge.
 */
export function preloadPacked(scene: Phaser.Scene, base: string = PACKED_BASE): void {
  scene.load.json(PACKED_MANIFEST_KEY, `${base}atlases.json`)
  scene.load.image(COMMONS_PACKED_KEY, `${base}commons.webp`)
  scene.load.image(RUNTIME_PACKED_KEY, `${base}runtime.webp`)
  scene.load.image(ITEMS_PACKED_KEY, `${base}items.webp`)
  scene.load.image('fingersnap-terrain-runtime', `${base}terrain.webp`)
  for (const a of SCALED_ATLASES) scene.load.atlas(a.key, `${base}${a.key}.png`, `${base}${a.key}.json`)
}
