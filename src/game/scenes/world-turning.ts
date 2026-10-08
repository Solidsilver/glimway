/**
 * The Turning: when the outer Wilds' epoch ends (a claim refused as
 * epoch-ended, or the clock passing the wick's end while you stand there),
 * the land shifts under you. The screen pales and shakes, the canon notice
 * is posted, and you come to at the region's entrance in the new epoch.
 */
import type Phaser from 'phaser'
import { SEASON_SHIFT_NOTICE } from '../../content/expansion-writing.ts'
import { TURNED_SINCE_LINE, TURNING_TITLE } from '../../content/echoes.ts'
import { TURNED_FLAG, calendarFind } from '../../lib/wilds/stories.ts'
import { seasonMark } from '../../lib/wilds/outer.ts'
import { bus, EV } from '../events.ts'
import { grantPaper } from '../papers.ts'
import { onSceneEnd } from '../scene-end.ts'
import { sfx } from '../sfx.ts'
import type { Session } from '../session.ts'
import type { WorldData } from '../worlds.ts'
import type { Hero } from '../entities/hero.ts'
import type { Unmoored } from '../entities/unmoored.ts'
import { OUTER_REGION_ID, WILDS_AREA, parseChunkArea, wildsArrivalPosition } from '../wilds/regions.ts'
import { outerTurned, prepareWilds, resetWildsRegion, wildsEpoch } from '../wilds/store.ts'

export interface TurningDeps {
  session: Session
  world: WorldData
  reducedMotion: boolean
  hero: () => Hero
  unmoored: Unmoored
  /** The scene is already leaving (a Turning waits for nothing else). */
  moving: () => boolean
  /** Hold the scene: it is leaving now. */
  hold: () => void
}

export class Turning {
  private readonly scene: Phaser.Scene
  private readonly deps: TurningDeps
  /** Seconds until the next "has the outer Wilds turned?" check. */
  private check = 0

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

  private inOuterWilds(): boolean {
    return parseChunkArea(this.deps.world.areaId)?.region === OUTER_REGION_ID
  }

  private onTurning(): void {
    this.deps.unmoored.trigger()
    if (this.inOuterWilds()) this.play()
  }

  /** Once a second in the outer Wilds: has its epoch ended? */
  update(dt: number): void {
    if (!this.inOuterWilds()) return
    this.check -= dt
    if (this.check > 0) return
    this.check = 1
    if (outerTurned(this.deps.session)) this.play()
  }

  /**
   * "The Wilds shift": the screen pales and shakes, the canon notice is
   * posted, and the player comes to at the outer region's entrance in the
   * new epoch (guests: the calendar's next wick; connected: the server's).
   */
  private play(): void {
    if (this.deps.moving()) return
    this.deps.hold()
    this.deps.hero().halt()
    const cam = this.scene.cameras.main
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
    if (!this.deps.reducedMotion) cam.shake(900, 0.006)
    sfx('settle')
    this.scene.tweens.add({ targets: veil, fillAlpha: 0.92, duration: this.deps.reducedMotion ? 200 : 900 })
    this.scene.tweens.add({ targets: [title, notice], alpha: 1, duration: 500, delay: 300 })
    this.scene.time.delayedCall(this.deps.reducedMotion ? 1200 : 1900, () => {
      resetWildsRegion(OUTER_REGION_ID)
      const state = this.deps.session.state
      state.area = WILDS_AREA
      state.wildsRegion = OUTER_REGION_ID
      void prepareWilds(this.deps.session, 0).finally(() => {
        // The entrance of the region as it is now.
        state.position = wildsArrivalPosition(wildsEpoch(OUTER_REGION_ID))
        state.outerSeason = wildsEpoch(OUTER_REGION_ID).season
        this.deps.session.saveSoon()
        this.scene.scene.restart({ turned: true })
      })
    })
  }

  /** You saw the outer Wilds turn: the canon notice, and what a Turning gives. */
  note(live: boolean): void {
    const s = this.deps.session
    bus.emit(EV.toast, { text: live ? SEASON_SHIFT_NOTICE : `${TURNED_SINCE_LINE} ${SEASON_SHIFT_NOTICE}`, icon: 'map' })
    // Connected, the turning is the server's to record: it writes `wilds:turned`
    // and grants what a turning gives when it sees this place reported.
    if (!s.link) {
      s.addFlag(TURNED_FLAG)
      const ctx = { flags: s.state.flags, late: s.state.quest === 'complete', mark: seasonMark(wildsEpoch(OUTER_REGION_ID).season) }
      const paper = calendarFind('turning', ctx)
      if (paper) this.scene.time.delayedCall(1400, () => grantPaper(s, paper))
    }
    this.deps.unmoored.trigger()
  }
}
