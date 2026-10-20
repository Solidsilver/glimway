import type Phaser from 'phaser'
import { PACKED_BASE, PACKED_MANIFEST_KEY, SCALED_ATLASES } from './atlas-plan.ts'
import { loadStaged } from './art-pass.ts'
import { COMMONS_PACKED_KEY } from './commons-pass.ts'
import { RUNTIME_PACKED_KEY } from './runtime-art.ts'
import { ITEMS_PACKED_KEY } from './items-pass.ts'
import { GROUND_PACKED_KEY } from './area/terrain.ts'
import { PEOPLE_PACKED_KEY } from './people.ts'
import { BUILDINGS_PACKED_KEY } from './buildings.ts'
import { INDOORS_PACKED_KEY } from './indoors-art.ts'
import { CRAFTS_PACKED_KEY } from './crafts-art.ts'
import { PURSE_PACKED_KEY } from './purse-art.ts'
import { GLIMS_PACKED_KEY } from './glims-art.ts'
import { OPEN_MAP_PACKED_KEY } from './wilds/open-map-art.ts'
import { HEARTHWICK2_PACKED_KEY } from './hearthwick2-art.ts'

/**
 * Load the packed atlases (scripts/build-atlases.ts writes them; see
 * ./atlas-plan.ts for what each holds): the Commons-pass, runtime-pass and
 * items-pass, indoors-pass and crafts-pass native frames, the normalized terrain tileset, the playtest-1
 * ground tiles and people (residents, held tools) as lossless
 * WebP (identical texels, ~35% smaller than PNG), and the hero walk,
 * enemy, foreground and props atlases under the texture keys the scenes
 * already use. The atlases boot only copies frames out of are staged
 * (./art-pass.ts `loadStaged`): never uploaded as textures of their own.
 * A file that fails to load leaves the code-drawn fallbacks in charge.
 */
export function preloadPacked(scene: Phaser.Scene, base: string = PACKED_BASE): void {
  scene.load.json(PACKED_MANIFEST_KEY, `${base}atlases.json`)
  loadStaged(scene, COMMONS_PACKED_KEY, `${base}commons.webp`)
  loadStaged(scene, RUNTIME_PACKED_KEY, `${base}runtime.webp`)
  loadStaged(scene, ITEMS_PACKED_KEY, `${base}items.webp`)
  scene.load.image('fingersnap-terrain-runtime', `${base}terrain.webp`)
  scene.load.image(GROUND_PACKED_KEY, `${base}ground.webp`)
  loadStaged(scene, PEOPLE_PACKED_KEY, `${base}people.webp`)
  loadStaged(scene, BUILDINGS_PACKED_KEY, `${base}buildings.webp`)
  loadStaged(scene, INDOORS_PACKED_KEY, `${base}indoors.webp`)
  loadStaged(scene, CRAFTS_PACKED_KEY, `${base}crafts.webp`)
  loadStaged(scene, PURSE_PACKED_KEY, `${base}purse.webp`)
  loadStaged(scene, GLIMS_PACKED_KEY, `${base}glims.webp`)
  loadStaged(scene, OPEN_MAP_PACKED_KEY, `${base}open-map.webp`)
  loadStaged(scene, HEARTHWICK2_PACKED_KEY, `${base}hearthwick2.webp`)
  for (const a of SCALED_ATLASES) scene.load.atlas(a.key, `${base}${a.key}.png`, `${base}${a.key}.json`)
}
