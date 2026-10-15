import type { Light } from '../lib/homestead-land.ts'
import { TILE } from '../lib/tile.ts'

/** A single mask over the land up to its fence, excluding the public lanes. */
export function shadePixels(lights: readonly Light[], bounds: { x: number; y: number; w: number; h: number }, opacity: number): Uint8ClampedArray {
  const width = bounds.w * TILE, height = bounds.h * TILE
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const x = bounds.x + (px + 0.5) / TILE - 0.5
    const y = bounds.y + (py + 0.5) / TILE - 0.5
    let shade = 1
    // A one-tile transition replaces the staircase at integer tile centres.
    for (const light of lights) shade = Math.min(shade, Math.max(0, Math.min(1, Math.hypot(x - light.x, y - light.y) - light.radius + 0.5)))
    const i = (py * width + px) * 4
    pixels[i] = 12; pixels[i + 1] = 12; pixels[i + 2] = 24
    pixels[i + 3] = Math.round(255 * opacity * shade)
  }
  return pixels
}
