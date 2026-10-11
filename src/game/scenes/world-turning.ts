/**
 * The Turning on the open map (docs/design/open-map.md decision 10): when
 * the wick ends (a near read naming a new wick, a claim refused as
 * epoch-ended, or the clock passing the wick's end while you're out), the
 * Beyond turns. The screen pales and shakes, the canon notice is posted, and
 * the land changes under you in place: the store starts over, the window
 * loads the new land, and if you were standing in something now solid you
 * step to the nearest open tile ("The drift turned while you stood in it.").
 * You're never sent home. In the Tangle (which never turns) the change is
 * quiet: only the land past its edge is new.
 */
import type Phaser from 'phaser'
import { SEASON_SHIFT_NOTICE } from '../../content/expansion-writing.ts'
import { TURNED_SINCE_LINE, TURNING_TITLE } from '../../content/echoes.ts'
import { TURNED_FLAG, calendarFind } from '../../lib/wilds/stories.ts'
import { seasonMark } from '../../lib/wilds/outer.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { epochKindAt } from '../../lib/wilds/coords.ts'
import { bus, EV } from '../events.ts'
import { grantPaper } from '../papers.ts'
import { onSceneEnd } from '../scene-end.ts'
import { sfx } from '../sfx.ts'
import type { Session } from '../session.ts'
import type { WorldData } from '../worlds.ts'
import type { Hero } from '../entities/hero.ts'
import type { Unmoored } from '../entities/unmoored.ts'
import { chunkOfPixel } from '../wilds/coords.ts'
import { prepareWilds, resetWilds, wickEnded, wildsEpoch } from '../wilds/store.ts'
import { forgetGround, standAt } from '../wilds/ground-view.ts'
import type { WildsWindow } from '../wilds/window.ts'
import type { WildsEntities } from '../wilds/entities.ts'
import { roadStep } from '../../lib/quests.ts'

export interface TurningDeps {
  session: Session
  world: WorldData
  reducedMotion: boolean
  hero: () => Hero
  unmoored: Unmoored
  /** The open map's window and entities (null in curated areas). */
  window: () => WildsWindow | null
  wilds: () => WildsEntities | null
  /** The scene is already leaving (a Turning waits for nothing else). */
  moving: () => boolean
  /** Hold the scene still while the land turns (and let it go after). */
  hold: (on: boolean) => void
}

export class Turning {
  private readonly scene: Phaser.Scene
  private readonly deps: TurningDeps
  /** Seconds until the next "has the wick ended?" check. */
  private check = 0
  private playing = false
  /** The wick a Turning last played for: the clock alone never plays it twice. */
  private playedFor = ''

  constructor(scene: Phaser.Scene, deps: TurningDeps) {
    this.scene = scene
    this.deps = deps
    const onClock = () => {
      this.check = 0
    }
    const onTurning = () => this.onTurning()
    bus.on(EV.turning, onTurning)
    bus.on(EV.clock, onClock)
    const off = () => {
      bus.off(EV.turning, onTurning)
      bus.off(EV.clock, onClock)
    }
    onSceneEnd(scene, off)
  }

  private get open(): boolean {
    return !!this.deps.world.open
  }

  /** Standing in the Beyond (land that turns), not the Tangle. */
  private inBeyond(): boolean {
    const h = this.deps.hero().sprite
    const at = chunkOfPixel(h.x, h.y)
    return epochKindAt(at.cx, at.cy) === 'wick'
  }

  private onTurning(): void {
    this.deps.unmoored.trigger()
    if (this.open) this.play()
  }

  /** Once a second on the open map: has the wick ended? */
  update(dt: number): void {
    if (!this.open) return
    this.check -= dt
    if (this.check > 0) return
    this.check = 1
    // Past the wick's end by this page's clock: turn, unless this wick has
    // already turned and the server still names it (its clock is behind ours).
    if (wickEnded() && wildsEpoch('wick').id !== this.playedFor) this.play()
  }

  /**
   * "The Wilds shift": in the Beyond the screen pales and shakes and the
   * canon notice is posted while the new land loads; in the Tangle only the
   * notice. Then the window is built again where you stand.
   */
  private play(): void {
    if (this.playing || this.deps.moving()) return
    this.playing = true
    this.playedFor = wildsEpoch('wick').id
    const loud = this.inBeyond()
    this.deps.hold(true)
    this.deps.hero().halt()
    const cam = this.scene.cameras.main
    const parts: Phaser.GameObjects.GameObject[] = []
    if (loud) {
      const cx = cam.width / 2
      const cy = cam.height / 2
      const veil = this.scene.add.rectangle(cx, cy, cam.width * 2, cam.height * 2, 0xdfe8ec, 0).setScrollFactor(0).setDepth(9000)
      const title = this.scene.add
        .text(cx, cy - 6, TURNING_TITLE, { fontFamily: '"Pixelify Sans", monospace', fontSize: '12px', color: '#2b2238', resolution: 8 })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(9001)
        .setAlpha(0)
      const notice = this.scene.add
        .text(cx, cy + 10, SEASON_SHIFT_NOTICE, { fontFamily: 'Nunito, sans-serif', fontSize: '6px', color: '#4a4058', resolution: 8, align: 'center', wordWrap: { width: Math.min(220, cam.width / cam.zoom - 24) } })
        .setOrigin(0.5, 0)
        .setScrollFactor(0)
        .setDepth(9001)
        .setAlpha(0)
      parts.push(veil, title, notice)
      if (!this.deps.reducedMotion) cam.shake(900, 0.006)
      sfx('settle')
      this.scene.tweens.add({ targets: veil, fillAlpha: 0.92, duration: this.deps.reducedMotion ? 200 : 900 })
      this.scene.tweens.add({ targets: [title, notice], alpha: 1, duration: 500, delay: 300 })
    }
    this.scene.time.delayedCall(loud ? (this.deps.reducedMotion ? 1200 : 1900) : 0, () => {
      // The new land: the store starts over (the near read names the new
      // wick), and the window loads it around you.
      resetWilds({ quiet: true })
      forgetGround()
      this.deps.window()?.reload()
      this.deps.wilds()?.detachAll()
      void prepareWilds(this.deps.session, 0).finally(() => {
        if (!this.scene.sys.isActive()) return
        const w = this.deps.window()
        w?.update(0)
        w?.settle()
        void (w?.ready() ?? Promise.resolve()).then(() => this.landed(loud, parts))
      })
    })
  }

  /** The new land is in: step off anything solid, lift the veil, say what happened. */
  private landed(loud: boolean, parts: Phaser.GameObjects.GameObject[]): void {
    const hero = this.deps.hero().sprite
    const at = standAt(hero.x, hero.y)
    const moved = !!at && (at.x !== hero.x || at.y !== hero.y)
    if (at && moved) {
      hero.setPosition(at.x, at.y)
      hero.setVelocity(0, 0)
    }
    this.deps.session.saveSoon()
    this.scene.tweens.add({ targets: parts, alpha: 0, duration: 400, onComplete: () => parts.forEach((p) => p.destroy()) })
    this.deps.hold(false)
    this.playing = false
    if (loud) this.note(true)
    else bus.emit(EV.toast, { text: SEASON_SHIFT_NOTICE, icon: 'map' })
    if (moved) bus.emit(EV.toast, { text: loadWilds().words.turned, icon: 'map', kind: 'thought' })
  }

  /** You saw the Beyond turn: the canon notice, and what a Turning gives. */
  note(live: boolean): void {
    const s = this.deps.session
    bus.emit(EV.toast, { text: live ? SEASON_SHIFT_NOTICE : `${TURNED_SINCE_LINE} ${SEASON_SHIFT_NOTICE}`, icon: 'map' })
    // Connected, the turning is the server's to record: it writes `wilds:turned`
    // and grants what a turning gives when it sees this place reported.
    if (!s.link) {
      s.addFlag(TURNED_FLAG)
      const ctx = { flags: s.state.flags, late: roadStep(s.state) === 'complete', mark: seasonMark(wildsEpoch('wick').season) }
      const paper = calendarFind('turning', ctx)
      if (paper) this.scene.time.delayedCall(1400, () => grantPaper(s, paper))
    }
    this.deps.unmoored.trigger()
  }
}
