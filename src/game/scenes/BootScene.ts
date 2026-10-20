import Phaser from 'phaser'
import { isSteps, stagedDecoded, type Steps } from '../art-pass'
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
import { createHearthwick2Art } from '../hearthwick2-art'
import { drawPortraits } from '../portraits'
import { HOMESTEAD_DATA } from '../../lib/homestead'
import { fixedPlaceOf, prepareFixed } from '../wilds/fixed'
import { chunkOfPixel, isWildsArea } from '../wilds/coords'
import type { Session } from '../session'
import { bus, EV } from '../events'
import { artDensity } from '../density'

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
    // The loading screen follows the fetch (src/ui/loading.svelte.ts).
    bus.emit(EV.loadStage, { stage: 'fetch' })
    this.load.on(Phaser.Loader.Events.PROGRESS, (p: number) => bus.emit(EV.loadStage, { progress: p }))
    // Manifests, then every delivered pack's pixels as game-size atlases
    // (the props atlas included). The scene illustrations are UI-only.
    preloadGlimwayExpansion(this)
    preloadRuntimeArt(this)
    preloadCommonsPass(this)
    preloadItemsPass(this)
    preloadPacked(this)
  }

  create(): void {
    // The Commons is fixed ground on the open map (../wilds/fixed.ts): its
    // reads start now, beside the art below.
    const session = this.registry.get('session') as Session
    const pending = prepareFixed(session)
    // The art is built a slice a frame (BOOT_SLICE_MS), in this order, so
    // boot never holds the page for one long frame: once the staged atlases
    // are decoded (off the main thread), so no slice decodes one.
    const steps = this.artSteps()
    const total = steps.length
    let running: Steps<unknown> | null = null
    const slice = () => {
      const deadline = performance.now() + BOOT_SLICE_MS
      try {
        while (running || steps.length) {
          if (!running) {
            const ran = steps.shift()!()
            running = isSteps(ran) ? ran : null
          } else if (running.next().done) running = null
          if (performance.now() >= deadline) {
            bus.emit(EV.loadStage, { progress: (total - steps.length - (running ? 1 : 0)) / total })
            return
          }
        }
      } catch (err) {
        // The loading screen offers Retry instead of a dark world that never comes.
        this.events.off(Phaser.Scenes.Events.UPDATE, slice)
        bus.emit(EV.loadStage, { failed: true, note: ['boot error', String(err instanceof Error ? err.message : err).slice(0, 200)] })
        throw err
      }
      this.events.off(Phaser.Scenes.Events.UPDATE, slice)
      this.enter(session, pending)
    }
    bus.emit(EV.loadStage, { stage: 'decode', note: ['art', `density ${artDensity(this)}, ${this.sys.game.renderer.type === Phaser.WEBGL ? 'WebGL' : 'Canvas'}`] })
    void stagedDecoded(this).then(() => {
      if (!this.sys.game) return
      bus.emit(EV.loadStage, { stage: 'build' })
      this.events.on(Phaser.Scenes.Events.UPDATE, slice)
      slice()
    })
  }

  /**
   * What `create` builds, in order. A step runs within one slice, or
   * returns `Steps` that run a texture at a time over as many as it needs.
   */
  private artSteps(): (() => unknown)[] {
    return [
      // The terrain tileset ships baked (packed/terrain.webp, preloaded under
      // its runtime key); then code-drawn textures for what nothing delivers.
      () => createGlimwayAnimations(this),
      () => generateTextures(this),
      // The Commons and homesteads: what the Commons pass doesn't deliver (./commons-art).
      () => generateCommonsArt(this),
      () => generateRepairArt(this),
      () => generateDecorationArt(this, HOMESTEAD_DATA.items),
      // Commons pass: native `commons-art:` textures and animations, then the
      // delivered frames installed under the scenes' keys (before the
      // breathing fallback below names them, and before any world sprite).
      () => createCommonsPass(this),
      () => {
        installCommonsPass(this, HOMESTEAD_DATA.items)
        if (!this.anims.exists('silas-breathing')) {
          this.anims.create({ key: 'silas-breathing', frames: [{ key: 'silas-idle-0' }, { key: 'silas-idle-1' }], frameRate: 1.5, repeat: -1 })
        }
      },
      // Native runtime-pass textures + breathing/effect animations, then alias
      // replacement (fallback keys get the delivered art) — both BEFORE any
      // world sprite is created.
      () => createRuntimeArt(this),
      () => installRuntimeAliases(this, { replaceExisting: true }),
      // Native items-pass textures, and the Tolley mill's frames under their keys
      () => createItemsPass(this),
      () => installItemsPass(this),
      // The playtest-1 people: the residents' walking art and the held tools.
      () => createPeople(this),
      // The playtest-1 buildings: the village houses and the Brackenwood footbridge.
      () => createBuildings(this),
      // The 0.4 indoors pass: the rooms' kit and furniture, smoke and lit windows.
      () => createIndoorsArt(this),
      // The 0.5 crafts pass: ability icons and effects, the stable, fishing, HUD icons.
      () => createCraftsArt(this),
      // The 0.6 purse pass: the price tag and the wardrobe (its coin and gold letter are unused since glims).
      () => createPurseArt(this),
      // The 0.6.1 glims pass: a glim, its HUD size, a few glims.
      () => createGlimsArt(this),
      () => createOpenMapArt(this),
      // The Hearthwick 2 pass: the Wick Tree, the town's buildings and dressing, the lot stakes.
      () => createHearthwick2Art(this),
      // The interface's portraits and icons, cut from all of the above (the world sends them).
      () => drawPortraits(this)
    ]
  }

  /**
   * Start the world. A save that starts on the Commons' fixed ground waits
   * for its chunks (a few seconds at most; then the window attaches them
   * when they come); any other start only fetches them ahead.
   */
  private enter(session: Session, pending: Promise<void> | null): void {
    bus.emit(EV.loadStage, { stage: 'arrive' })
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
/** A boot slice's budget (ms): the art steps run until it's spent, one step at least. */
const BOOT_SLICE_MS = 8
