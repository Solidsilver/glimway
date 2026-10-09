/**
 * A mount on the lead (crafts.md 3.1): the mount that's out walks behind its
 * hero, beside the pet, with a rope from the hand to its head drawn in code.
 * It keeps some slack: while the hero stands, sits, fights, chops or fishes
 * it stops where it is, and comes on again when they move off. Enemies
 * ignore it; it has no body. Go home walks it off the edge of the screen.
 *
 * Drawn from Habitica's mount art (body and head layers, no rider) at the
 * avatar's scale. The art faces left; walking right flips it. Calm by
 * default: a 1 px lift on every other step while it walks, none with
 * reduced motion. The follow is pure (`leadStep`) and tested.
 */
import type Phaser from 'phaser'
import { loadCompanion } from '../avatar-render.ts'
import { STEP_MS } from '../hero-motion.ts'
import { COMPANION_SCALE } from './pet-follower.ts'

/** Behind the hero on the lead, px: past the pet (14), a little lower so the two stand side by side. */
export const LEAD_BEHIND = 26
export const LEAD_DROP = 3
/** It stands until its spot is this far off (the rope's slack), px. */
export const LEAD_SLACK = 10
/** Its walking pace, px/s (the hero walks at 110). */
export const LEAD_PACE = 120
/** Walking home off the screen, px/s. */
const HOME_PACE = 60

/**
 * Where the Habitica mount canvas (135 px, body and head) sits on its feet,
 * in canvas px from the canvas centre: the art's feet are near row 110, its
 * middle near column 61 (Mount_Body_Wolf-Base and Mount_Head_Wolf-Base).
 */
const MOUNT_FEET = { x: -6, y: 42.5 }
/** The head's neck, where the rope ties on (canvas px from the centre, unmirrored). */
const MOUNT_NECK = { x: -27.5, y: 2.5 }

export interface LeadState {
  x: number
  y: number
  faceRight: boolean
  moving: boolean
}

export interface LeadInput {
  /** The hero's feet. */
  x: number
  y: number
  faceRight: boolean
  /** Sitting: it waits. */
  seated: boolean
  dt: number
}

/** One frame on the lead: it walks toward its spot behind the hero once the rope's slack is taken up. */
export function leadStep(s: LeadState, i: LeadInput): LeadState {
  const tx = i.x + LEAD_BEHIND * (i.faceRight ? -1 : 1)
  const ty = i.y + LEAD_DROP
  const dx = tx - s.x
  const dy = ty - s.y
  const d = Math.hypot(dx, dy)
  // Waiting: seated, or close enough that the rope hangs slack.
  if (i.seated || d <= (s.moving ? 1 : LEAD_SLACK)) return { ...s, moving: false, faceRight: s.moving ? s.faceRight : i.x > s.x }
  // Faster the further it's left behind (it never loses its hero on a ride).
  const pace = LEAD_PACE * Math.min(2.5, Math.max(1, d / (LEAD_SLACK * 3)))
  const step = Math.min(d, (pace * Math.max(0, i.dt)) / 1000)
  const x = s.x + (dx / d) * step
  const y = s.y + (dy / d) * step
  return { x, y, moving: step > 0.01, faceRight: Math.abs(dx) > 0.5 ? dx > 0 : s.faceRight }
}

/** The rope's sag below the straight line, px: slack when close, near taut at a stretch. */
export function ropeSag(distance: number): number {
  return Math.max(1, 8 - distance / 6)
}

export class LedMount {
  readonly key: string
  state: LeadState
  private readonly scene: Phaser.Scene
  private readonly reducedMotion: boolean
  private body: Phaser.GameObjects.Container
  private rope: Phaser.GameObjects.Graphics
  private gone = false
  private leaving = false

  constructor(scene: Phaser.Scene, key: string, at: { x: number; y: number }, reducedMotion: boolean) {
    this.scene = scene
    this.key = key
    this.reducedMotion = reducedMotion
    this.state = { x: at.x, y: at.y, faceRight: false, moving: false }
    this.body = scene.add.container(at.x, at.y).setDepth(at.y)
    this.rope = scene.add.graphics()
    void this.load()
  }

  private async load(): Promise<void> {
    const keys = await loadCompanion(this.scene, this.key, 'mount')
    if (this.gone || !keys || !this.body.active) return
    const s = COMPANION_SCALE
    for (const k of keys) this.body.add(this.scene.add.image(-MOUNT_FEET.x * s, -MOUNT_FEET.y * s, k).setScale(s))
  }

  /** Read-only, for playtests: drawn (its art loaded) and where. */
  get drawn(): boolean {
    return this.body.length > 0
  }

  /** Where the rope ties on, world px. */
  neck(): { x: number; y: number } {
    const s = COMPANION_SCALE
    const flip = this.state.faceRight ? -1 : 1
    return { x: this.state.x + flip * (MOUNT_NECK.x - MOUNT_FEET.x) * s, y: this.state.y + (MOUNT_NECK.y - MOUNT_FEET.y) * s }
  }

  update(i: LeadInput & { hand: { x: number; y: number } | null; time: number }): void {
    if (this.gone || this.leaving) return
    this.state = leadStep(this.state, i)
    const lift = this.state.moving && !this.reducedMotion && Math.floor(i.time / STEP_MS) % 2 === 1 ? -1 : 0
    this.body.setPosition(Math.round(this.state.x), Math.round(this.state.y + lift)).setDepth(this.state.y)
    this.body.setScale(this.state.faceRight ? -1 : 1, 1)
    this.drawRope(i.hand)
  }

  /** A slack curve from the hand to the head (crafts.md 9.4: code, no art). */
  private drawRope(hand: { x: number; y: number } | null): void {
    const g = this.rope
    g.clear()
    if (!hand || !this.drawn) return
    const n = this.neck()
    const d = Math.hypot(n.x - hand.x, n.y - hand.y)
    const sag = ropeSag(d)
    const cx = (hand.x + n.x) / 2
    const cy = Math.max(hand.y, n.y) + sag
    g.lineStyle(1, 0x6b4a2b, 1)
    g.beginPath()
    g.moveTo(hand.x, hand.y)
    const steps = 10
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      const x = (1 - t) * (1 - t) * hand.x + 2 * (1 - t) * t * cx + t * t * n.x
      const y = (1 - t) * (1 - t) * hand.y + 2 * (1 - t) * t * cy + t * t * n.y
      g.lineTo(x, y)
    }
    g.strokePath()
    g.setDepth(Math.max(this.state.y, hand.y) + 0.6)
  }

  /** Go home: it walks off the nearer edge of the screen, then it's gone (drawing only). */
  walkOff(): void {
    if (this.gone || this.leaving) return
    this.leaving = true
    this.rope.clear()
    const view = this.scene.cameras.main.worldView
    const right = this.state.x > view.centerX
    const toX = right ? view.right + 30 : view.left - 30
    this.body.setScale(right ? -1 : 1, 1)
    this.scene.tweens.add({
      targets: this.body,
      x: toX,
      duration: (Math.abs(toX - this.state.x) / HOME_PACE) * 1000,
      onComplete: () => this.destroy()
    })
    if (!this.reducedMotion) this.scene.tweens.add({ targets: this.body, y: this.body.y - 1, duration: STEP_MS, yoyo: true, repeat: -1 })
  }

  destroy(): void {
    if (this.gone) return
    this.gone = true
    this.scene.tweens.killTweensOf(this.body)
    this.body.destroy()
    this.rope.destroy()
  }
}
