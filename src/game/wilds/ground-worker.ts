/**
 * Paints the open map's chunk ground off the main thread (./paint-worker.ts
 * starts one). In: the patch, its packed tiles, the look and the world seed;
 * out: the RGBA, transferred. The same pure painter as the main thread's
 * (./ground-paint.ts), so a chunk paints the same either way.
 */
import { paintGround, unpackGround, type PackedGround, type PaintTable } from './ground-paint.ts'
import { wildsLook } from './wilds-looks.ts'

interface Request {
  id: number
  x0: number
  y0: number
  w: number
  h: number
  tiles: PackedGround
  look: 'tangle' | 'outer'
  mark: string | null
  seed: number
  table: PaintTable
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage: (msg: unknown, transfer: Transferable[]) => void }

ctx.onmessage = (e) => {
  const { id, x0, y0, w, h, tiles, look, mark, seed, table } = e.data
  const start = performance.now()
  const rgba = new Uint8ClampedArray(w * h * 4)
  paintGround(rgba, x0, y0, w, h, unpackGround(tiles), wildsLook(look, mark).ground, seed, table)
  ctx.postMessage({ id, rgba, ms: performance.now() - start }, [rgba.buffer as ArrayBuffer])
}
