/**
 * The open map's ground painter thread (open-map.md 4: no dropped frames
 * crossing an edge): one worker (./ground-worker.ts) paints chunks while
 * the hero walks; the main thread only puts the pixels into a texture. If
 * the worker can't start or fails, painting falls back to the main thread
 * for the page (the pure painter is the same, so nothing looks different).
 */
import { paintGround, packGround, unpackGround, type GroundSource, type PaintTable } from './ground-paint.ts'
import { wildsLook } from './wilds-looks.ts'

export interface PaintJob {
  x0: number
  y0: number
  w: number
  h: number
  look: 'tangle' | 'outer'
  mark: string | null
  seed: number
  /** How each ground paints (./ground-table.ts). */
  table: PaintTable
}

export interface PaintResult {
  rgba: Uint8ClampedArray
  /** Time spent painting (the worker's own clock when it painted). */
  ms: number
  /** Where it was painted. */
  thread: 'worker' | 'main'
}

let worker: Worker | null = null
let broken = false
let nextId = 0
const waiting = new Map<number, { resolve: (r: PaintResult) => void; fallback: () => void }>()

function failAll(): void {
  broken = true
  worker?.terminate()
  worker = null
  for (const w of [...waiting.values()]) w.fallback()
  waiting.clear()
}

function start(): Worker | null {
  if (broken || typeof Worker === 'undefined') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./ground-worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<{ id: number; rgba: Uint8ClampedArray; ms: number }>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      w.resolve({ rgba: e.data.rgba, ms: e.data.ms, thread: 'worker' })
    })
    worker.addEventListener('error', failAll)
    return worker
  } catch {
    broken = true
    return null
  }
}

/** Paint on this thread, now. */
export function paintHere(job: PaintJob, src: GroundSource): PaintResult {
  const t = performance.now()
  const rgba = new Uint8ClampedArray(job.w * job.h * 4)
  paintGround(rgba, job.x0, job.y0, job.w, job.h, src, wildsLook(job.look, job.mark).ground, job.seed, job.table)
  return { rgba, ms: performance.now() - t, thread: 'main' }
}

/**
 * Paint off the main thread when a worker is up (else here); the tiles are
 * read now. The promise settles once: the worker's paint, or this thread's
 * from the same tiles if the worker fails or the job can't be posted (a
 * reply after that is dropped).
 */
export function paintAway(job: PaintJob, src: GroundSource): Promise<PaintResult> {
  // Kept for a fallback: posting transfers a copy, which detaches it here.
  const tiles = packGround(src, job.x0, job.y0, job.w, job.h)
  const w = start()
  if (!w) return Promise.resolve(paintHere(job, unpackGround(tiles)))
  return new Promise((resolve) => {
    const id = nextId++
    let done = false
    const settle = (r: () => PaintResult) => {
      if (done) return
      done = true
      waiting.delete(id)
      resolve(r())
    }
    const entry = { resolve: (r: PaintResult) => settle(() => r), fallback: () => settle(() => paintHere(job, unpackGround(tiles))) }
    waiting.set(id, entry)
    const sent = { ...tiles, ground: tiles.ground.slice(), solid: tiles.solid.slice() }
    try {
      w.postMessage({ id, ...job, tiles: sent }, [sent.ground.buffer, sent.solid.buffer])
    } catch {
      entry.fallback()
    }
  })
}
