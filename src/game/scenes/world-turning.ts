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
import { forgetGround } from '../wilds/ground-view.ts'
import type { WildsWindow } from '../wilds/window.ts'
import type { WildsEntities } from '../wilds/entities.ts'
import { roadStep } from '../../lib/quests.ts'

/** The longest the veil waits for the new land's window (ms): its paints settle within paint-worker.ts's deadline. */
export const LAND_WAIT_MS = 8000

export interface TurningDeps {
  session: Session
  world: WorldData
  reducedMotion: boolean
  hero: () => Hero
  unmoored: Unmoored
  /** The open map's window and entities (null in curated areas). */
  window: () => WildsWindow | null
  wilds: () => WildsEntities | null
  /** The scene is leaving (a move, not a held Turning): a Turning waits for nothing else. */
  moving: () => boolean
  /**
   * Hold the scene still while the land turns, and let it go after. Letting
   * go applies a relocation the server sent meanwhile (the hero may stand
   * elsewhere, or the scene leave).
   */
  hold: (on: boolean) => void
}

export class Turning {
  private readonly scene: Phaser.Scene
  private readonly deps: TurningDeps
  /** Seconds until the next "has the wick ended?" check. */
  private check = 0
  private playing = false
  /**
   * This scene build has ended (a fall, say, while the land loaded). A
   * restarted scene is active again, so its loads must not land into the next build.
   */
  private ended = false
  /** The wick a Turning last played for: the clock alone never plays it twice. */
  private playedFor = ''
  /**
   * The wick the server last recorded this player's place in, as this scene
   * build began (null once checked): coming back to land that has turned
   * since gets its note when the Wilds are first read.
   */
  private recorded: string | null

  constructor(scene: Phaser.Scene, deps: TurningDeps) {
    this.scene = scene
    this.deps = deps
    this.recorded = deps.world.open ? deps.session.state.wickEpoch ?? '' : null
    const onClock = () => {
      this.check = 0
    }
    const onTurning = () => this.onTurning()
    bus.on(EV.turning, onTurning)
    bus.on(EV.clock, onClock)
    const off = () => {
      bus.off(EV.turning, onTurning)
      bus.off(EV.clock, onClock)
      this.ended = true
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

  /**
   * Back in the Beyond after it turned while you were away: the server
   * recorded your place in an older wick than the one the Wilds now name.
   * You stand where you were (or the nearest open tile); the land is new.
   */
  private arrivedAfterTurning(): void {
    if (this.recorded === null) return
    const wick = wildsEpoch('wick').id
    if (!wick) return
    const was = this.recorded
    this.recorded = null
    if (was && was !== wick && this.inBeyond()) this.note(false)
  }

  private onTurning(): void {
    this.deps.unmoored.trigger()
    if (this.open) this.play()
  }

  /** Once a second on the open map: has the wick ended? */
  update(dt: number): void {
    if (!this.open) return
    this.arrivedAfterTurning()
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
        if (this.ended || !this.scene.sys.isActive()) return
        const w = this.deps.window()
        w?.update(0)
        w?.settle()
        // The window's ready, or LAND_WAIT_MS at most: a chunk that never
        // comes in can't keep the veil down and the hero held.
        const waited = new Promise<void>((resolve) => this.scene.time.delayedCall(LAND_WAIT_MS, resolve))
        void Promise.race([w?.ready() ?? Promise.resolve(), waited]).then(() => {
          if (!this.ended && this.scene.sys.isActive()) this.landed(loud, parts)
        })
      })
    })
  }

  /** The new land is in: lift the hold and the veil, step off anything solid, say what happened. */
  private landed(loud: boolean, parts: Phaser.GameObjects.GameObject[]): void {
    // Let go first: a relocation the server sent while the land turned (a
    // ways-home answer, a settled reach) puts the hero there now, or starts
    // a move away. The spot to clear is then the hero's new one.
    this.deps.hold(false)
    this.playing = false
    this.scene.tweens.add({ targets: parts, alpha: 0, duration: 400, onComplete: () => parts.forEach((p) => p.destroy()) })
    let moved = false
    if (!this.deps.moving()) {
      const hero = this.deps.hero().sprite
      const at = this.deps.world.open?.standAt(hero.x, hero.y)
      moved = !!at && (at.x !== hero.x || at.y !== hero.y)
      if (at && moved) {
        hero.setPosition(at.x, at.y)
        hero.setVelocity(0, 0)
      }
      this.deps.session.saveSoon()
    }
    // The next wick's rumour: the state names it (read again, it changed without a version bump).
    void this.deps.session.link?.refreshState()
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
