import { MAX_WALK_SLOPE } from './slopes.ts'

/** Actual field velocity, never projected screen velocity. Lean is a one-pixel
 * body offset; its shadow and logical feet stay planted. No extra art needed. */
export function slopeGait(gx: number, gy: number, vx: number, vy: number, baseSpeed: number) {
  const speed = Math.hypot(vx, vy)
  const ux = speed > 0.01 ? vx / speed : 0
  const uy = speed > 0.01 ? vy / speed : 0
  const along = Math.max(-1, Math.min(1, (gx * ux + gy * uy) / MAX_WALK_SLOPE))
  const lean = speed > 1 ? along : 0
  return {
    cadence: baseSpeed > 0 ? speed / baseSpeed : 0,
    x: ux * lean,
    y: uy * lean - Math.max(0, lean) * 0.4,
    scuff: speed > 1 && Math.hypot(gx, gy) >= MAX_WALK_SLOPE * 0.72,
    along
  }
}
