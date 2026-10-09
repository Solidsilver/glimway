/**
 * The pet that walks with a hero (crafts.md 2.1): yours, and every friend's
 * in the room (./remote-players.ts). Habitica pets are one still frame, so
 * everything alive about them is made here, and kept calm:
 *
 * - it trails behind, on the side away from where its hero faces;
 * - it hops in time with the steps (a 2 px lift on every other step frame,
 *   the hero's own STEP_MS), and only while it is moving;
 * - it turns to face where it's going (a flip on x; the art faces left);
 * - it sits when its hero sits: a squash, and a drop to the seat's side;
 * - after about 6 s of its hero standing still it settles beside them, on
 *   the side away from the camera's edge, and stays put.
 *
 * Reduced motion: no hops; it still follows, turns, sits and settles.
 * The motion is a pure function (`followStep`) so it is tested without
 * Phaser; `PetFollower` draws it.
 */
import type Phaser from 'phaser'
import { STEP_MS } from '../hero-motion.ts'

/** Habitica's sprite grid and its on-screen height, as the avatar's (./avatar.ts). */
export const COMPANION_SCALE = 22 / 90
/** Behind the hero, px. */
export const TRAIL_PX = 14
/** Beside a settled or seated hero, px. */
export const BESIDE_PX = 12
/** The hop on a step frame, world px. */
export const HOP_PX = 2
/** The hero stands still this long before the pet settles beside them. */
export const SETTLE_MS = 6_000
/** Following: the share of the gap closed per 60 Hz frame (the old follower's 0.08). */
const EASE = 0.08
/** Slower than this (px/s) the pet counts as standing. */
const MOVING_PX_S = 6

export type PetPose = 'follow' | 'settled' | 'sit'

export interface PetState {
  x: number
  y: number
  /** The art faces left; true flips it to face right. */
  faceRight: boolean
  pose: PetPose
  /** When the hero last moved (ms, the scene clock). */
  stillSince: number
  /** Which side it settled on (-1 left, 1 right); kept while settled. */
  side: -1 | 1
  /** Moving this frame (hops only while it is). */
  moving: boolean
}

export interface FollowInput {
  /** The hero's feet, px. */
  x: number
  y: number
  walking: boolean
  faceRight: boolean
  /** Where the hero sits (the seat's feet point), or null standing. */
  seat: { x: number; y: number; facing: 'down' | 'left' | 'right' } | null
  /** The camera's middle, px: a settled pet sits on the side toward it, away from the edge. */
  viewMidX: number
  /** Scene clock and frame time, ms. */
  time: number
  dt: number
}

export function startState(x: number, y: number): PetState {
  return { x: x - TRAIL_PX, y: y - 2, faceRight: false, pose: 'follow', stillSince: 0, side: -1, moving: false }
}

/** One frame of the follow: where the pet heads and how it stands. */
export function followStep(s: PetState, i: FollowInput): PetState {
  let pose: PetPose
  let tx: number
  let ty: number
  let side = s.side
  let stillSince = s.stillSince
  if (i.walking || i.seat) stillSince = i.time
  if (i.seat) {
    // To the seat's side: the side it faces away from, or the left of a seat facing down.
    side = i.seat.facing === 'left' ? 1 : -1
    pose = 'sit'
    tx = i.seat.x + BESIDE_PX * side
    ty = i.seat.y + 1
  } else if (!i.walking && i.time - stillSince >= SETTLE_MS) {
    if (s.pose !== 'settled') side = i.x > i.viewMidX ? -1 : 1
    pose = 'settled'
    tx = i.x + BESIDE_PX * side
    ty = i.y + 1
  } else {
    pose = 'follow'
    tx = i.x + TRAIL_PX * (i.faceRight ? -1 : 1)
    ty = i.y - 2
  }
  const k = 1 - Math.pow(1 - EASE, Math.max(0, i.dt) / (1000 / 60))
  const x = s.x + (tx - s.x) * k
  const y = s.y + (ty - s.y) * k
  const vx = i.dt > 0 ? ((x - s.x) * 1000) / i.dt : 0
  const vy = i.dt > 0 ? ((y - s.y) * 1000) / i.dt : 0
  const moving = Math.hypot(vx, vy) > MOVING_PX_S
  // Turn to face where it's going; at rest, face its hero.
  let faceRight = s.faceRight
  if (moving && Math.abs(vx) > MOVING_PX_S / 2) faceRight = vx > 0
  else if (!moving && pose !== 'follow') faceRight = i.x > x
  return { x, y, faceRight, pose, stillSince, side, moving }
}

/** The hop on a step frame (px, negative is up): only moving, never with reduced motion. */
export function hopAt(time: number, moving: boolean, reducedMotion: boolean): number {
  if (!moving || reducedMotion) return 0
  return Math.floor(time / STEP_MS) % 2 === 1 ? -HOP_PX : 0
}

/** Drawn: one Habitica pet image following a hero. */
export class PetFollower {
  readonly image: Phaser.GameObjects.Image
  state: PetState
  /** A petting hop in progress until this time (ms). */
  private petHopUntil = 0
  private readonly scene: Phaser.Scene
  private readonly reducedMotion: boolean

  constructor(scene: Phaser.Scene, textureKey: string, at: { x: number; y: number }, reducedMotion: boolean) {
    this.scene = scene
    this.reducedMotion = reducedMotion
    this.state = startState(at.x, at.y)
    this.image = scene.add.image(this.state.x, this.state.y, textureKey).setOrigin(0.5, 1).setScale(COMPANION_SCALE)
  }

  get x(): number {
    return this.state.x
  }

  get y(): number {
    return this.state.y
  }

  get pose(): PetPose {
    return this.state.pose
  }

  update(input: FollowInput): void {
    if (!this.image.active) return
    this.state = followStep(this.state, input)
    const s = this.state
    let lift = hopAt(input.time, s.moving, this.reducedMotion)
    // Petted: one small hop, up and down (a still pet for reduced motion).
    if (input.time < this.petHopUntil && !this.reducedMotion) lift = -Math.round(3 * Math.sin(((this.petHopUntil - input.time) / 320) * Math.PI))
    const squash = s.pose === 'sit' ? 0.86 : s.pose === 'settled' ? 0.94 : 1
    const widen = s.pose === 'sit' ? 1.08 : s.pose === 'settled' ? 1.03 : 1
    this.image
      .setPosition(Math.round(s.x), Math.round(s.y + lift))
      .setScale(COMPANION_SCALE * widen * (s.faceRight ? -1 : 1), COMPANION_SCALE * squash)
      .setDepth(s.y)
  }

  /** Petted: a hop (the heart is the caller's). */
  hop(): void {
    this.petHopUntil = this.scene.time.now + 320
  }

  setVisible(v: boolean): void {
    this.image.setVisible(v)
  }

  destroy(): void {
    this.image.destroy()
  }
}
