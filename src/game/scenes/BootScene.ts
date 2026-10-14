import Phaser from 'phaser'
import { generateTextures } from '../textures'
import { createGlimwayAnimations, preloadGlimwayExpansion } from '../expansion'
import { createRuntimeArt, installRuntimeAliases, preloadRuntimeArt } from '../runtime-art'
import { generateCommonsArt, generateDecorationArt } from '../commons-art'
import { generateRepairArt } from '../repairs-art'
import { createCommonsPass, preloadCommonsPass } from '../commons-pass'
import { installCommonsPass } from '../commons-pass-install'
import { createItemsPass, installItemsPass, preloadItemsPass } from '../items-pass'
import { preloadPacked } from '../packed'
import { createPeople } from '../people'
import { createBuildings } from '../buildings'
import { createIndoorsArt } from '../indoors-art'
import { createCraftsArt } from '../crafts-art'
import { createPurseArt } from '../purse-art'
import { createGlimsArt } from '../glims-art'
import { createOpenMapArt } from '../wilds/open-map-art'
import { HOMESTEAD_DATA } from '../../lib/homestead'
import { fixedPlaceOf, prepareFixed } from '../wilds/fixed'
import { chunkOfPixel, isWildsArea } from '../wilds/coords'
import type { Session } from '../session'

/**
 * Boot: loads the delivered art (the expansion atlases, the runtime pass of
 * NPCs, the guardian and class effects, the Commons and items passes, all
 * packed), then draws in code only what the delivered art doesn't cover.
 * The runtime pass then replaces the shared alias keys (`mara`,
 * `guardian0`, `slash`, `bolt`, …) and the Commons pass installs its frames
 * under the keys the scenes draw with, before the world starts. The packed
 * art always ships. See docs/runtime-asset-spec.md.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot')
  }

  preload(): void {
    // Manifests, then every delivered pack's pixels as game-size atlases
    // (the props atlas included). The scene illustrations are UI-only.
    preloadGlimwayExpansion(this)
    preloadRuntimeArt(this)
    preloadCommonsPass(this)
    preloadItemsPass(this)
    preloadPacked(this)
  }

  create(): void {
    // The terrain tileset ships baked (packed/terrain.webp, preloaded under
    // its runtime key); then code-drawn textures for what nothing delivers.
    createGlimwayAnimations(this)
    generateTextures(this)
    // The Commons and homesteads: what the Commons pass doesn't deliver (./commons-art).
    generateCommonsArt(this)
    generateRepairArt(this)
    generateDecorationArt(this, HOMESTEAD_DATA.items)
    // Commons pass: native `commons-art:` textures and animations, then the
    // delivered frames installed under the scenes' keys (before the
    // breathing fallback below names them, and before any world sprite).
    createCommonsPass(this)
    installCommonsPass(this, HOMESTEAD_DATA.items)
    if (!this.anims.exists('silas-breathing')) {
      this.anims.create({ key: 'silas-breathing', frames: [{ key: 'silas-idle-0' }, { key: 'silas-idle-1' }], frameRate: 1.5, repeat: -1 })
    }
    // Native runtime-pass textures + breathing/effect animations, then alias
    // replacement (fallback keys get the delivered art) — both BEFORE any
    // world sprite is created.
    createRuntimeArt(this)
    installRuntimeAliases(this, { replaceExisting: true })

    // Native items-pass textures, and the Tolley mill's frames under their keys
    createItemsPass(this)
    installItemsPass(this)

    // The playtest-1 people: the residents' walking art and the held tools.
    createPeople(this)
    // The playtest-1 buildings: the village houses and the Brackenwood footbridge.
    createBuildings(this)
    // The 0.4 indoors pass: the rooms' kit and furniture, smoke and lit windows.
    createIndoorsArt(this)
    // The 0.5 crafts pass: ability icons and effects, the stable, fishing, HUD icons.
    createCraftsArt(this)
    // The 0.6 purse pass: the price tag and the wardrobe (its coin and gold letter are unused since glims).
    createPurseArt(this)
    // The 0.6.1 glims pass: a glim, its HUD size, a few glims.
    createGlimsArt(this)
    createOpenMapArt(this)

    // The Commons is fixed ground on the open map (../wilds/fixed.ts): a save
    // that starts on it waits for its chunks (a few seconds at most; then the
    // window attaches them when they come); any other start only fetches
    // them ahead.
    const session = this.registry.get('session') as Session
    const pending = prepareFixed(session)
    const start = () => this.scene.start('World')
    const at = chunkOfPixel(session.state.position.x, session.state.position.y)
    if (!pending || !isWildsArea(session.state.area) || !fixedPlaceOf(at.cx, at.cy)) {
      start()
      return
    }
    let started = false
    const once = () => {
      if (started || !this.sys.game) return
      started = true
      start()
    }
    void pending.finally(once)
    this.time.delayedCall(COMMONS_WAIT_MS, once)
  }
}

/** How long a start in the Commons waits for its chunks. */
const COMMONS_WAIT_MS = 4000
