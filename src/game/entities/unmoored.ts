/**
 * Unmoored: the drift's sway. Too long deep in the Tangle, or a Turning
 * under you, and the land stops holding still: the screen sways and pales
 * at the edges until you rest in lamplight (two minutes in a safe area) or
 * take a remedy (EV.clearUnmoored: a turncap jar clears it at once, a salve
 * eases it off over 45 seconds).
 *
 * The state outlives a scene (it's the hero's, not the area's): it lives
 * here and crosses to the HUD as EV.unmoored. The first sway and the first
 * recovery each write a journal entry.
 */
import type Phaser from 'phaser'
import { bus, EV } from '../events'
import { emitResidents } from '../residents'
import { isSafeArea } from '../../lib/habitica/sync'
import { loadWilds } from '../../lib/wilds/data'
import { WILDS_REGION_ID, parseChunkArea } from '../wilds/regions'
import type { Session } from '../session'
import type { WorldData } from '../worlds'

/** Seconds deep in the Tangle before the land lets go of you. */
const DEEP_TANGLE_S = 240
/** Seconds of lamplight (a safe area) that steady you. */
const LAMPLIGHT_S = 120
/** Seconds an easing remedy takes to wear the sway off. */
const EASING_S = 45

/**
 * The hero's sway and its clocks. They outlive a scene build (as they did
 * on the scene itself, which Phaser reuses across restarts): a remedy keeps
 * easing through a doorway, and the deep Tangle and the lamplight count
 * across chunk edges.
 */
const state = { active: false, easing: false, deepTimer: 0, lamplightTimer: 0, easingTimer: 0 }

/** Whether the hero is unmoored now (and a remedy is easing it off). */
export function unmooredNow(): { active: boolean; easing: boolean } {
  return { active: state.active, easing: state.easing }
}

/** Set the state and tell the HUD. */
export function setUnmoored(active: boolean, easing = false): void {
  if (state.active === active && state.easing === easing) return
  state.active = active
  state.easing = active && easing
  bus.emit(EV.unmoored, { active: state.active })
}

export interface UnmooredDeps {
  session: Session
  world: WorldData
  reducedMotion: boolean
}

export class Unmoored {
  /** This area counts as deep in the Tangle (far enough from its entrance). */
  private readonly deep: boolean
  private veil: Phaser.GameObjects.Rectangle | null = null
  private edges: Phaser.GameObjects.Rectangle[] = []

  constructor(
    private scene: Phaser.Scene,
    private deps: UnmooredDeps
  ) {
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
    scene.events.once('shutdown', off)
    scene.events.once('destroy', off)
  }

  /** The land lets go: the sway starts (and the journal notes it, once). */
  trigger(): void {
    const easing = state.easing
    setUnmoored(true, easing)
    if (!easing) state.lamplightTimer = 0
    const s = this.deps.session
    if (!s.state.flags.includes('unmoored:felt')) {
      s.addFlag('unmoored:felt')
      emitResidents(s)
      bus.emit(EV.toast, { text: 'New in your journal: The Drift’s Sway', icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: 'The Drift’s Sway' } })
    }
  }

  /** Steady again (and the journal notes how, once). */
  clear(): void {
    if (!state.active && !state.easing) return
    setUnmoored(false)
    state.lamplightTimer = 0
    state.deepTimer = 0
    state.easingTimer = 0
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
      state.deepTimer += dt
      if (state.deepTimer >= DEEP_TANGLE_S) {
        this.trigger()
        state.deepTimer = 0
      }
    } else {
      state.deepTimer = 0
    }
    if (!state.active) {
      this.clearVisuals()
      return
    }
    if (isSafeArea(this.deps.world.areaId)) {
      state.lamplightTimer += dt
      if (state.lamplightTimer >= LAMPLIGHT_S) this.clear()
    } else {
      state.lamplightTimer = 0
    }
    if (state.easing) {
      state.easingTimer -= dt
      if (state.easingTimer <= 0) this.clear()
    }
    // A remedy (or the lamplight) above may have cleared it this frame.
    if (state.active) this.drawSway(time)
  }

  private onRemedy(p: { instant: boolean }): void {
    if (!state.active) return
    if (p.instant) {
      this.clear()
    } else {
      setUnmoored(true, true)
      state.easingTimer = EASING_S
    }
  }

  /** The pale veil, the edge bands and the camera's slow sway (a still veil with reduced motion). */
  private drawSway(time: number): void {
    const cam = this.scene.cameras.main
    if (!cam) return
    const factor = state.easing ? Math.max(0, state.easingTimer / EASING_S) : 1.0

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
    if (this.edges.length === 0) {
      const band = (x: number, y: number, w: number, h: number) => this.scene.add.rectangle(x, y, w, h, 0x8fa4b8, 0.22).setScrollFactor(0).setDepth(8501)
      this.edges = [
        band(cam.centerX, ey + 14 / cam.zoom, cam.width * 2, 28 / cam.zoom),
        band(cam.centerX, cam.height - ey - 14 / cam.zoom, cam.width * 2, 28 / cam.zoom),
        band(ex + 14 / cam.zoom, cam.centerY, 28 / cam.zoom, cam.height * 2),
        band(cam.width - ex - 14 / cam.zoom, cam.centerY, 28 / cam.zoom, cam.height * 2)
      ]
    } else {
      const alpha = (0.2 + Math.sin(time * 0.0022) * 0.08) * factor
      this.edges[0].setPosition(cam.centerX, ey + 14 / cam.zoom).setSize(cam.width * 2, 28 / cam.zoom).setAlpha(alpha)
      this.edges[1].setPosition(cam.centerX, cam.height - ey - 14 / cam.zoom).setSize(cam.width * 2, 28 / cam.zoom).setAlpha(alpha)
      this.edges[2].setPosition(ex + 14 / cam.zoom, cam.centerY).setSize(28 / cam.zoom, cam.height * 2).setAlpha(alpha)
      this.edges[3].setPosition(cam.width - ex - 14 / cam.zoom, cam.centerY).setSize(28 / cam.zoom, cam.height * 2).setAlpha(alpha)
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
