/**
 * The zero-HP barrier (docs/design/location-seam.md 4): too hurt to fight, a
 * hero on safe ground can't step off it. On the open map that is the
 * Commons' mouth at y = 24, the safe ground's edge the place lookup draws.
 *
 * Arcade moves bodies before the scene's update and writes the step to the
 * sprite after it, so the barrier works on velocity: a step that would carry
 * the feet off safe ground stops on the axis that would cross, before the
 * physics takes it, and the hero slides along the edge on the other. A hero
 * found off it all the same (a shove) goes back to the last safe spot,
 * an axis at a time (`holdOnSafe`).
 */
export type Safe = (x: number, y: number) => boolean

/** The velocity to keep from `at` for a step of `look` seconds: each axis that would leave safe ground stops. */
export function stopAtEdge(safe: Safe, at: { x: number; y: number }, v: { x: number; y: number }, look: number): { x: number; y: number } {
  const nx = at.x + v.x * look
  const ny = at.y + v.y * look
  if (safe(nx, ny)) return v
  const x = safe(nx, at.y) ? v.x : 0
  const y = safe(at.x, ny) ? v.y : 0
  // Only the corner is off (a diagonal into it): stop the slower axis.
  if (x && y) return Math.abs(v.x) < Math.abs(v.y) ? { x: 0, y } : { x, y: 0 }
  return { x, y }
}

/** Where a hero found off safe ground stands again: back from `now` toward `was`, an axis at a time. */
export function holdOnSafe(safe: Safe, was: { x: number; y: number }, now: { x: number; y: number }): { x: number; y: number } {
  if (safe(now.x, now.y)) return now
  if (safe(now.x, was.y)) return { x: now.x, y: was.y }
  if (safe(was.x, now.y)) return { x: was.x, y: now.y }
  return was
}
