/**
 * Height lab (dev only): the slopes area's textures. The ground's pixels
 * are ./slopes-paint.ts's (the drawing treatments); this paints them as
 * jobs the scene runs a step at a time under a frame budget, keeps the
 * results by settings and chunk (so a chunk is painted once a setting),
 * makes them level images, and draws the crags' standing rock.
 */
import Phaser from 'phaser'
import { addPixels, type LevelImage, type PaintPart } from './art.ts'
import { BAND, cutBandsSteps, paintPartSteps, type BandPixels } from './slopes-paint.ts'

function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

type Area = Parameters<typeof paintPartSteps>[0]


/** Painted chunks, by the settings that paint and the chunk (the field never changes): the most recent CACHE_CHUNKS. */
const CACHE_CHUNKS = 48
const painted = new Map<string, BandPixels[]>()

/** A chunk already painted in these settings (and now the most recent). */
export function paintedChunk(key: string): BandPixels[] | null {
  const b = painted.get(key)
  if (!b) return null
  painted.delete(key)
  painted.set(key, b)
  return b
}

/** A chunk being painted: `step()` does one strip or band (a few ms) and says when it's done; then `bands` are cached. */
export interface PaintJob {
  key: string
  cx: number
  cy: number
  step(): boolean
  bands: BandPixels[] | null
}

export function paintJob(area: Area, part: PaintPart, key: string, cx: number, cy: number): PaintJob {
  const run = (function* (): Generator<void, BandPixels[]> {
    const { px, z } = yield* paintPartSteps(area, part)
    return yield* cutBandsSteps(part, px, z)
  })()
  const job: PaintJob = {
    key,
    cx,
    cy,
    bands: null,
    step() {
      const r = run.next()
      if (!r.done) return false
      job.bands = r.value
      painted.set(key, r.value)
      while (painted.size > CACHE_CHUNKS) painted.delete(painted.keys().next().value!)
      return true
    }
  }
  return job
}

/** A painted chunk's bands as level images (a half level each). */
export function bandImages(scene: Phaser.Scene, partKey: string, bands: BandPixels[]): LevelImage[] {
  return bands.map((b) => {
    const key = `${partKey}-${b.band}`
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
        const lit = 1
        const rim = 1
        const crack = (x === 5 + v || x === 11 - v) && hash(v, y >> 2, 27) < 0.5 ? 0.6 : 1
        const foot = 1
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

/** A lab-only copy: discard the old atlas's translucent contact shadows.
 * The shared atlas and normal game's props remain exactly as authored. */
export function slopeDecorAtlas(scene: Phaser.Scene, sourceKey: string): string {
  const key = `${sourceKey}-sun-albedo`
  if (scene.textures.exists(key)) return key
  const source = scene.textures.get(sourceKey)
  const image = source.getSourceImage() as HTMLCanvasElement
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 3; i < data.data.length; i += 4) if (data.data[i]! < 200) data.data[i] = 0
  ctx.putImageData(data, 0, 0)
  const atlas = scene.textures.addCanvas(key, canvas)!
  for (const name of source.getFrameNames()) {
    const frame = source.get(name)
    atlas.add(name, 0, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight)
  }
  return key
}
