/**
 * WorldScene's frame in two halves (docs/design/shared-fights.md 1.8, game
 * step-back F7). Observation always runs: the world others share, drawn
 * (friends walking, enemies their owners show, the open map's window and its
 * camps, the presence sample), and the clocks that never stop. This player's
 * play (input, local enemies, bolts) is held while something else owns the
 * screen, and the hero stands still instead. Pure, so node tests drive it.
 */

/** Why this player's play is held this frame. */
export type PlayHold = 'ui' | 'transition' | 'cinematic' | 'persisting' | 'placing'

/**
 * The hold, or null when play runs. `persisting`: a sync's write owns the
 * save file, so nothing this player does may change it mid-write (a hit, a
 * regen tick, a position); what others do is still observed.
 */
export function playHold(s: { ui: boolean; transitioning: boolean; cinematic: boolean; persisting: boolean; placing: boolean }): PlayHold | null {
  if (s.ui) return 'ui'
  if (s.transitioning) return 'transition'
  if (s.cinematic) return 'cinematic'
  if (s.persisting) return 'persisting'
  if (s.placing) return 'placing'
  return null
}

export interface WorldFrame {
  observe(time: number, dt: number): void
  /** Asked after observing (observation can start or end a hold). */
  hold(): PlayHold | null
  /** Play held: stand still, keep the screen alive. */
  still(time: number, dt: number): void
  play(time: number, dt: number): void
}

export function runFrame(frame: WorldFrame, time: number, dt: number): void {
  frame.observe(time, dt)
  if (frame.hold() !== null) frame.still(time, dt)
  else frame.play(time, dt)
}
