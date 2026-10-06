/**
 * The layered avatar's motion (playtest 1), kept apart from Phaser so it can
 * be tested: a slow one-pixel breath when still, a one-pixel lift on every
 * other step when walking, nothing floaty. See ./entities/avatar.ts.
 */

/** One pixel of the Habitica art, in canvas px (the art is drawn 3:1 on its grid). */
export const ART_PX = 3
/** Where the walking layers split for the breath: mid-chest, canvas rows. */
export const BREATH_SPLIT = 63
/** One breath, in ms: a slow rise, held, and a slower fall. */
export const BREATH_MS = 3600
/** One step, in ms (two steps a stride, at walking speed). */
export const STEP_MS = 160

/**
 * Pose offsets at a moment (canvas px; negative is up): the breath lifts the
 * upper half, a step lifts the whole body.
 */
export function avatarMotion(time: number, walking: boolean, reducedMotion: boolean): { breath: number; step: number } {
  if (walking) return { breath: 0, step: Math.floor(time / STEP_MS) % 2 === 1 ? -ART_PX : 0 }
  if (reducedMotion) return { breath: 0, step: 0 }
  // In for 45% of the cycle, then out: one pixel, never a glide.
  const phase = (time % BREATH_MS) / BREATH_MS
  return { breath: phase >= 0.3 && phase < 0.75 ? -ART_PX : 0, step: 0 }
}
