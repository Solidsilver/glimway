/** Dev-only slope sunlight. Field axes: east, south, up. The direction is a
 * parameter so a later clock can supply it; no clock or screen-space light here. */
export type SunDirection = readonly [number, number, number]
const n = Math.hypot(0.5, 0.5, 0.7)
export const SUN: SunDirection = [-0.5 / n, -0.5 / n, 0.7 / n]

/** The physical normal: a level rises three tile widths. */
export function sunFacing(gx: number, gy: number, sun: SunDirection = SUN): number {
  return (-3 * gx * sun[0] - 3 * gy * sun[1] + sun[2]) / Math.hypot(3 * gx, 3 * gy, 1)
}
export function facingResponse(gx: number, gy: number, sun: SunDirection = SUN): number {
  return Math.tanh((sunFacing(gx, gy, sun) - sun[2]) * 12)
}

/** A bounded warm/cool tint, multiplied by the sprite's own colour. Even the
 * darkest slope keeps at least 80% of its red and green for hero contrast. */
export function sunTint(gx: number, gy: number, strength = 1, base = 0xffffff, sun: SunDirection = SUN): number {
  const t = facingResponse(gx, gy, sun)
  const s = Math.max(0, Math.min(1, strength))
  const light = t >= 0 ? [1, 1 - 0.025 * t, 1 - 0.07 * t] : [1 + 0.2 * t, 1 + 0.16 * t, 1 + 0.08 * t]
  return light.reduce((out, k, i) => out | Math.round(((base >>> (16 - 8 * i)) & 255) * (1 + (k - 1) * s)) << (16 - 8 * i), 0)
}

/** Intersect a ray from the object's top with the local ground plane.
 * Facing away (falling toward SE) lengthens it; facing the sun shortens it.
 * Bound the approximation on steep/crag ground. Height and result are px. */
export function sunShadow(gx: number, gy: number, height: number, sun: SunDirection = SUN): { dx: number; dy: number; length: number; angle: number } {
  const h = Math.max(0, height)
  const den = Math.max(0.3, sun[2] - 3 * (gx * sun[0] + gy * sun[1]))
  const dx = -sun[0] * h / den
  const dy = -sun[1] * h / den
  return { dx, dy, length: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) }
}
