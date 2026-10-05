import Phaser from 'phaser'
import { generateTextures } from '../textures'
import { createFingersnapAnimations, createFingersnapTerrain, preloadFingersnapExpansion } from '../expansion'
import { createRuntimeArt, installRuntimeAliases, preloadRuntimeArt } from '../runtime-art'
import { generateCommonsArt, generateDecorationArt } from '../commons-art'
import { createCommonsPass, preloadCommonsPass } from '../commons-pass'
import { installCommonsPass } from '../commons-pass-install'
import { HOMESTEAD_DATA } from '../../lib/homestead'

/**
 * Boot: loads the delivered expansion atlases (terrain, hero walk, enemies,
 * foreground) and the NPC/guardian/class-effect pass, then generates
 * placeholder textures for anything the delivered art does not cover.
 * Drop-in files loaded in `preload` win over generated keys; the runtime-pass
 * helper builds native per-frame textures after the fallbacks and replaces
 * the shared alias keys (`mara`, `guardian0`, `slash`, `bolt`, …) before the
 * world starts. The Commons pass (Silas, homes, the Commons, village life,
 * papers, the Wilds, UI icons) does the same over the code-drawn Commons
 * placeholders. See docs/runtime-asset-spec.md.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot')
  }

  preload(): void {
    preloadFingersnapExpansion(this)
    preloadRuntimeArt(this)
    preloadCommonsPass(this)
    // Earlier delivered art: scene illustrations + props atlas.
    this.load.image('fingersnap-village', '/assets/fingersnap/fingersnap-village.png')
    this.load.image('fingersnap-shrine', '/assets/fingersnap/fingersnap-shrine.png')
    this.load.atlas(
      'fingersnap-props',
      '/assets/fingersnap/fingersnap-props.png',
      '/assets/fingersnap/fingersnap-props.atlas.json'
    )
  }

  create(): void {
    // Normalize the unequal source cells into a uniform runtime tileset first,
    // then generate placeholder textures for uncovered slots.
    createFingersnapTerrain(this, 32)
    createFingersnapAnimations(this)
    generateTextures(this)
    // The Commons and homesteads (code-drawn placeholders; see commons-art).
    generateCommonsArt(this)
    generateDecorationArt(this, HOMESTEAD_DATA.items)
    // Commons pass: native `commons-art:` textures and animations, then the
    // delivered frames copied onto the placeholder keys (before the
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
    this.scene.start('World')
  }
}
