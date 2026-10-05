import type Phaser from 'phaser'
import { PACKED_BASE, PACKED_MANIFEST_KEY, SCALED_ATLASES } from './atlas-plan.ts'
import { COMMONS_PACKED_KEY } from './commons-pass.ts'
import { RUNTIME_PACKED_KEY } from './runtime-art.ts'

/**
 * Load the packed atlases (scripts/build-atlases.ts writes them; see
 * ./atlas-plan.ts for what each holds): the Commons-pass and runtime-pass
 * native frames, the normalized terrain tileset, and the hero walk, enemy,
 * foreground and props atlases under the texture keys the scenes already
 * use. A file that fails to load leaves the code-drawn fallbacks in charge.
 */
export function preloadPacked(scene: Phaser.Scene, base: string = PACKED_BASE): void {
  scene.load.json(PACKED_MANIFEST_KEY, `${base}atlases.json`)
  scene.load.image(COMMONS_PACKED_KEY, `${base}commons.png`)
  scene.load.image(RUNTIME_PACKED_KEY, `${base}runtime.png`)
  scene.load.image('fingersnap-terrain-runtime', `${base}terrain.png`)
  for (const a of SCALED_ATLASES) scene.load.atlas(a.key, `${base}${a.key}.png`, `${base}${a.key}.json`)
}
