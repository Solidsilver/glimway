/**
 * Unmoored: the drift's sway. Too long deep in the Tangle, or a Turning
 * under you, and the land stops holding still: the screen sways and pales
 * at the edges until you rest in lamplight (two minutes in a safe area) or
 * take a remedy (EV.clearUnmoored: a turncap jar clears it at once, a salve
 * eases it off over 45 seconds).
 *
 * The state is the journey's, not the area's: it is kept per session, so it
 * carries through every area this journey walks into and starts afresh
 * for another journey. It crosses to the HUD as EV.unmoored. The first
 * sway and the first recovery each write a journal entry.
 */
import type Phaser from 'phaser'
import { bus, EV } from '../events.ts'
import { emitResidents } from '../residents.ts'
import { isSafeArea } from '../../lib/habitica/sync.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { WILDS_REGION_ID, parseChunkArea } from '../wilds/regions.ts'
import { onSceneEnd } from '../scene-end.ts'
import type { Session } from '../session.ts'
import type { WorldData } from '../worlds.ts'
import { canvasRatio } from '../viewport.ts'

/** Seconds deep in the Tangle before the land lets go of you. */
const DEEP_TANGLE_S = 240
/** Seconds of lamplight (a safe area) that steady you. */
const LAMPLIGHT_S = 120
/** Seconds an easing remedy takes to wear the sway off. */
const EASING_S = 45

/** The hero's sway and its clocks. */
interface UnmooredState {
  active: boolean
  easing: boolean
  deepTimer: number
  lamplightTimer: number
  easingTimer: number
}

/**
 * One state per journey (its session). The clocks outlive a scene build, as
 * they did on the scene itself, which Phaser reuses across restarts: a
 * remedy keeps easing through a doorway, and the deep Tangle and the
 * lamplight count across chunk edges. Another journey gets its own, from zero.
 */
const states = new WeakMap<Session, UnmooredState>()

function stateFor(session: Session): UnmooredState {
  let state = states.get(session)
  if (!state) states.set(session, (state = { active: false, easing: false, deepTimer: 0, lamplightTimer: 0, easingTimer: 0 }))
  return state
}

export interface UnmooredDeps {
  session: Session
  world: WorldData
  reducedMotion: boolean
}

export class Unmoored {
  private readonly scene: Phaser.Scene
  private readonly deps: UnmooredDeps
  /** This journey's sway and clocks. */
  private readonly state: UnmooredState
  /** This area counts as deep in the Tangle (far enough from its entrance). */
  private readonly deep: boolean
  private veil: Phaser.GameObjects.Rectangle | null = null
  private edges: Phaser.GameObjects.Rectangle[] = []

  constructor(scene: Phaser.Scene, deps: UnmooredDeps) {
    this.scene = scene
    this.deps = deps
    this.state = stateFor(deps.session)
    // The HUD follows this journey's state (a new journey starts steady).
    bus.emit(EV.unmoored, { active: this.state.active })
    const chunk = parseChunkArea(deps.world.areaId)
    const wilds = loadWilds()
    const tangle = wilds.regions.find((region) => region.id === WILDS_REGION_ID)
    this.deep = !!(
      chunk &&
      tangle &&
      chunk.region === WILDS_REGION_ID &&
      Math.abs(chunk.cx - tangle.entryX) + Math.abs(chunk.cy - tangle.entryY) >= wilds.deepTangleManhattanDistance
    )
    const onClear = (p: { instant: boolean }) => this.onRemedy(p)
    bus.on(EV.clearUnmoored, onClear)
    const off = () => {
      bus.off(EV.clearUnmoored, onClear)
      this.clearVisuals()
    }
    onSceneEnd(scene, off)
  }

  /** Whether the hero is unmoored now (and a remedy is easing it off). */
  now(): { active: boolean; easing: boolean } {
    return { active: this.state.active, easing: this.state.easing }
  }

  /** Set the sway (and tell the HUD). The playtests' lever, as well as the triggers'. */
  set(active: boolean, easing = false): void {
    if (this.state.active === active && this.state.easing === easing) return
    this.state.active = active
    this.state.easing = active && easing
    bus.emit(EV.unmoored, { active: this.state.active })
  }

  /** The land lets go: the sway starts (and the journal notes it, once). */
  trigger(): void {
    const easing = this.state.easing
    this.set(true, easing)
    if (!easing) this.state.lamplightTimer = 0
    const s = this.deps.session
    if (!s.state.flags.includes('unmoored:felt')) {
      s.addFlag('unmoored:felt')
      emitResidents(s)
      bus.emit(EV.toast, { text: 'New in your journal: The Drift’s Sway', icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: 'The Drift’s Sway' } })
    }
  }

  /** Steady again (and the journal notes how, once). */
  clear(): void {
    if (!this.state.active && !this.state.easing) return
    this.set(false)
    this.state.lamplightTimer = 0
    this.state.deepTimer = 0
    this.state.easingTimer = 0
    this.clearVisuals()
    const s = this.deps.session
    if (!s.state.flags.includes('unmoored:cleared')) {
      s.addFlag('unmoored:cleared')
      emitResidents(s)
      bus.emit(EV.toast, { text: 'New in your journal: Finding the Anchor', icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: 'Finding the Anchor' } })
    }
  }

  /** Every frame (panels open or not): the timers, and the sway on screen. */
  update(time: number, dt: number): void {
    if (this.deep) {
      this.state.deepTimer += dt
      if (this.state.deepTimer >= DEEP_TANGLE_S) {
        this.trigger()
        this.state.deepTimer = 0
      }
    } else {
      this.state.deepTimer = 0
    }
    if (!this.state.active) {
      this.clearVisuals()
      return
    }
    if (isSafeArea(this.deps.world.areaId)) {
      this.state.lamplightTimer += dt
      if (this.state.lamplightTimer >= LAMPLIGHT_S) this.clear()
    } else {
      this.state.lamplightTimer = 0
    }
    if (this.state.easing) {
      this.state.easingTimer -= dt
      if (this.state.easingTimer <= 0) this.clear()
    }
    // A remedy (or the lamplight) above may have cleared it this frame.
    if (this.state.active) this.drawSway(time)
  }

  private onRemedy(p: { instant: boolean }): void {
    if (!this.state.active) return
    if (p.instant) {
      this.clear()
    } else {
      this.set(true, true)
      this.state.easingTimer = EASING_S
    }
  }

  /** The pale veil, the edge bands and the camera's slow sway (a still veil with reduced motion). */
  private drawSway(time: number): void {
    const cam = this.scene.cameras.main
    if (!cam) return
    const factor = this.state.easing ? Math.max(0, this.state.easingTimer / EASING_S) : 1.0

    if (this.deps.reducedMotion) {
      if (!this.veil) {
        this.veil = this.scene.add.rectangle(cam.centerX, cam.centerY, cam.width * 2, cam.height * 2, 0xa8b4c0, 0.18 * factor).setScrollFactor(0).setDepth(8500)
      } else {
        this.veil.setPosition(cam.centerX, cam.centerY).setSize(cam.width * 2, cam.height * 2).setAlpha(0.18 * factor)
      }
      cam.setRotation(0)
      return
    }

    if (!this.veil) {
      this.veil = this.scene.add.rectangle(cam.centerX, cam.centerY, cam.width * 2, cam.height * 2, 0xd0dbe6, 0.12 * factor).setScrollFactor(0).setDepth(8500)
    } else {
      this.veil.setPosition(cam.centerX, cam.centerY).setSize(cam.width * 2, cam.height * 2).setAlpha((0.12 + Math.sin(time * 0.0015) * 0.04) * factor)
    }

    const ex = (cam.width / 2) * (1 - 1 / cam.zoom)
    const ey = (cam.height / 2) * (1 - 1 / cam.zoom)
    // Bands 28 CSS px deep along each edge (scroll-factor-0, so still zoomed).
    const b = (28 * canvasRatio()) / cam.zoom
    if (this.edges.length === 0) {
      const band = (x: number, y: number, w: number, h: number) => this.scene.add.rectangle(x, y, w, h, 0x8fa4b8, 0.22).setScrollFactor(0).setDepth(8501)
      this.edges = [
        band(cam.centerX, ey + b / 2, cam.width * 2, b),
        band(cam.centerX, cam.height - ey - b / 2, cam.width * 2, b),
        band(ex + b / 2, cam.centerY, b, cam.height * 2),
        band(cam.width - ex - b / 2, cam.centerY, b, cam.height * 2)
      ]
    } else {
      const alpha = (0.2 + Math.sin(time * 0.0022) * 0.08) * factor
      this.edges[0].setPosition(cam.centerX, ey + b / 2).setSize(cam.width * 2, b).setAlpha(alpha)
      this.edges[1].setPosition(cam.centerX, cam.height - ey - b / 2).setSize(cam.width * 2, b).setAlpha(alpha)
      this.edges[2].setPosition(ex + b / 2, cam.centerY).setSize(b, cam.height * 2).setAlpha(alpha)
      this.edges[3].setPosition(cam.width - ex - b / 2, cam.centerY).setSize(b, cam.height * 2).setAlpha(alpha)
    }

    cam.setRotation(Math.sin(time * 0.0018) * 0.007 * factor)
  }

  private clearVisuals(): void {
    this.scene.cameras?.main?.setRotation(0)
    this.veil?.destroy()
    this.veil = null
    for (const r of this.edges) r.destroy()
    this.edges = []
  }
}
