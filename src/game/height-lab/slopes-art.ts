/**
 * Height lab (dev only): the slopes area's textures. The ground's pixels
 * are ./slopes-paint.ts's (the four drawing styles); this makes them level
 * images, and draws the crags' standing rock.
 */
import Phaser from 'phaser'
import { addPixels, type LevelImage, type PaintPart } from './art.ts'
import { BAND, cutBands, paintPart } from './slopes-paint.ts'

function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** One part of the slopes area's surface (map tiles, inclusive), as level images a half level each. */
export function paintSlopes(scene: Phaser.Scene, area: Parameters<typeof paintPart>[0], part: PaintPart): LevelImage[] {
  const { px, z } = paintPart(area, part)
  return cutBands(part, px, z).map((b) => {
    const key = `${part.key}-${b.band}`
    addPixels(scene, key, b.w, b.h, b.px)
    return { key, x: b.x, y: b.y, level: b.band + BAND / 2 }
  })
}

/** Standing rock for crags: `crag-<v>`, 16×22, lit from the south-west. */
export const CRAG_KEY = 'hl-crag'

export function drawCrags(scene: Phaser.Scene): void {
  if (scene.textures.exists(CRAG_KEY)) return
  const fw = 16
  const fh = 22
  const n = 4
  const W = n * (fw + 2)
  const px = new Uint8ClampedArray(W * (fh + 2) * 4)
  for (let v = 0; v < n; v++) {
    const ox = v * (fw + 2) + 1
    // A jagged outline: the rock's top edge per column.
    const top: number[] = []
    for (let x = 0; x < fw; x++) {
      const peak = 1 - Math.abs(x - 7.5) / 8
      top.push(Math.round(fh - 4 - peak * (fh - 7) - hash(x >> 1, v, 26) * 5))
    }
    for (let x = 1; x < fw - 1; x++)
      for (let y = 0; y < fh; y++) {
        if (y < top[x]!) continue
        const lit = x < 7 ? 1.15 : x > 10 ? 0.72 : 0.95
        const rim = y === top[x] ? 1.35 : 1
        const crack = (x === 5 + v || x === 11 - v) && hash(v, y >> 2, 27) < 0.5 ? 0.6 : 1
        const foot = y > fh - 4 ? 0.75 : 1
        const c = (112 + hash(x, y + v * 31, 28) * 26) * lit * rim * crack * foot
        const i = ((y + 1) * W + ox + x) * 4
        px[i] = c
        px[i + 1] = c * 0.97
        px[i + 2] = c * 0.94
        px[i + 3] = 255
      }
  }
  addPixels(scene, CRAG_KEY, W, fh + 2, px)
  const tex = scene.textures.get(CRAG_KEY)
  for (let v = 0; v < n; v++) tex.add(`crag-${v}`, 0, v * (fw + 2) + 1, 1, fw, fh)
}

/** Face tints by the height they rise to, for a range this tall. */
export function slopeFaceTint(z: number): number {
  return z < 2.5 ? 0xf0dcc0 : z < 5 ? 0xd8d0c4 : z < 9 ? 0xc0c4ce : 0xdcdfe6
}
