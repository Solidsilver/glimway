/** Dev-only sunlight. Axes are east, south, up; one level is three tiles high. */
export type SunDirection = readonly [number, number, number]
export type RGB = readonly [number, number, number]
export interface DaySun { direction: SunDirection; color: RGB; daylight: number; time: number }
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const n = Math.hypot(0.5, 0.5, 0.7)
export const SUN: SunDirection = [-0.5 / n, -0.5 / n, 0.7 / n]
export const AMBIENT: RGB = [0.45, 0.49, 0.58]
export const NIGHT: RGB = [0.16, 0.19, 0.28]

/** Lowest and highest sun elevation (radians): above the horizon at dawn,
 * well below the zenith at noon, so azimuth never has to race. */
export const SUN_ELEVATION = { min: 0.08, max: 66 * Math.PI / 180 } as const
/** Dawn=0, noon=.5, dusk=1. A tilted arc: east to west through north.
 * Azimuth turns at one steady rate (15° an hour); elevation alone sets
 * shadow length, so noon shadows are short rather than spinning. */
export function sunAt(time: number, daylight = 1): DaySun {
  const t = clamp(time), az = Math.PI * t
  const e = SUN_ELEVATION.min + (SUN_ELEVATION.max - SUN_ELEVATION.min) * Math.pow(Math.sin(az), 1.5)
  const warm = Math.pow(Math.abs(2 * t - 1), 2)
  return { direction: [Math.cos(e) * Math.cos(az), -Math.cos(e) * Math.sin(az), Math.sin(e)], color: [1, 0.98 - 0.24 * warm, 0.94 - 0.40 * warm], daylight: clamp(daylight), time: t }
}

/** Existing game/server clock, UTC like the calendar: sunrise 06:00, sunset 18:00.
 * Civil twilight fades the direct light over the half hour at either end. */
export function clockSun(unix: number): DaySun {
  const hour = ((unix % 86400) + 86400) % 86400 / 3600
  return sunAt((hour - 6) / 12, clamp((hour - 5.5) * 2) * clamp((18.5 - hour) * 2))
}
export function sunFacing(gx: number, gy: number, sun: SunDirection = SUN): number {
  return (-3 * gx * sun[0] - 3 * gy * sun[1] + sun[2]) / Math.hypot(3 * gx, 3 * gy, 1)
}
/** Lambert plus a cool fill. Direct light alone is occluded; no normal can
 * drop below the ambient floor. Strength is 0–2; night has ambient only. */
export function surfaceLight(lambert: number, visible: number, sun: DaySun, strength = 1): RGB {
  return AMBIENT.map((a, c) => {
    const ambient = NIGHT[c]! + (a - NIGHT[c]!) * sun.daylight
    return clamp(ambient + 0.65 * Math.max(0, lambert) * clamp(visible) * clamp(strength, 0, 2) * sun.daylight * sun.color[c]!)
  }) as unknown as RGB
}
export function lightTint(rgb: RGB, base = 0xffffff): number {
  return rgb.reduce((out, k, i) => out | Math.round(((base >>> (16 - 8 * i)) & 255) * clamp(k)) << (16 - 8 * i), 0)
}
/** Compatibility helper; actual scene sprites sample their feet's light map. */
export function sunTint(gx: number, gy: number, strength = 1, base = 0xffffff, sun: SunDirection = SUN): number {
  return lightTint(surfaceLight(sunFacing(gx, gy, sun), 1, { ...sunAt(0.5), direction: sun }, strength), base)
}

/** Intersect the top-to-sun ray with the local receiving plane. Bound
 * near-parallel intersections, rather than letting a hillside explode it. */
export function sunShadow(gx: number, gy: number, height: number, sun: SunDirection = SUN): { dx: number; dy: number; length: number; angle: number } {
  const h = Math.max(0, height)
  const den = Math.max(0.12, sun[2] - 3 * (gx * sun[0] + gy * sun[1]))
  const dx = -sun[0] * h / den, dy = -sun[1] * h / den
  return { dx, dy, length: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) }
}
/** Canvas affine projection of the actual alpha silhouette. Source foot is
 * (width/2,height); the top moves by the ray, the width stays readable.
 * The tiny flattening term keeps noon shadows from disappearing entirely. */
export function silhouetteTransform(width: number, height: number, dx: number, dy: number): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const length = Math.hypot(dx, dy)
  const ux = length ? dx / length : 0, uy = length ? dy / length : 1
  // The billboard's width lies across the shadow, so a westward sun
  // cannot collapse a broad tree into a horizontal thread.
  const a = uy, b = -ux, vx = ux * Math.max(2, length), vy = uy * Math.max(2, length)
  return { a, b, c: -vx / height, d: -vy / height, e: vx - a * width / 2, f: vy - b * width / 2 }
}
/** A shaded foot cannot cast a second full-strength shadow. */
export function shadowOpacity(visible: number, strength: number, daylight = 1): number {
  return 0.46 * clamp(visible) * clamp(strength, 0, 2) / Math.max(1, strength * 0.75) * clamp(daylight)
}

/** Visible silhouette bounds, excluding transparent atlas padding. The last
 * occupied row is the real foot, rather than the frame's bottom edge. */
export function silhouetteBounds(px: Uint8ClampedArray, width: number, height: number): { x: number; y: number; w: number; h: number } {
  let left = width, right = -1, top = height, bottom = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (px[(y * width + x) * 4 + 3]! < 20) continue
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  return right < left ? { x: 0, y: 0, w: 1, h: 1 } : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}
