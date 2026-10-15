/**
 * The open map's ground painter thread (open-map.md 4: no dropped frames
 * crossing an edge): one worker (./ground-worker.ts) paints chunks while
 * the hero walks; the main thread only puts the pixels into a texture. The
 * first window (behind the scene's fade) paints its 3×3 at once across a few
 * more (`lanes`). If a worker can't start or fails (an error, or a reply
 * that can't be read), painting falls back to the main thread for the page
 * (the pure painter is the same, so nothing looks different). A job whose
 * reply never comes is painted here after PAINT_DEADLINE_MS, so no chunk
 * waits on it for ever.
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

/** How long a job waits for its worker's reply before it is painted here instead (ms). */
export const PAINT_DEADLINE_MS = 2000

/** Workers by lane (lane 0 paints while walking; the others help the first window). */
const workers: Worker[] = []
let broken = false
let nextId = 0
const waiting = new Map<number, { resolve: (r: PaintResult) => void; fallback: () => void }>()

function failAll(): void {
  broken = true
  for (const w of workers) w.terminate()
  workers.length = 0
  for (const w of [...waiting.values()]) w.fallback()
  waiting.clear()
}

/** How many workers paint a first window together (one fewer than the cores, at most three). */
export function lanes(): number {
  if (broken || typeof Worker === 'undefined') return 1
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2
  return Math.max(1, Math.min(3, cores - 1))
}

/** Can a paint go off the main thread? */
export function paintsAway(): boolean {
  return !broken && typeof Worker !== 'undefined'
}

function start(lane = 0): Worker | null {
  if (broken || typeof Worker === 'undefined') return null
  const i = Math.max(0, Math.min(lane, lanes() - 1))
  const had = workers[i]
  if (had) return had
  try {
    const worker = new Worker(new URL('./ground-worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<{ id: number; rgba: Uint8ClampedArray; ms: number }>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      w.resolve({ rgba: e.data.rgba, ms: e.data.ms, thread: 'worker' })
    })
    worker.addEventListener('error', failAll)
    // A reply that can't be deserialised is lost as surely as a crash.
    worker.addEventListener('messageerror', failAll)
    workers[i] = worker
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
 * from the same tiles if the worker fails, the job can't be posted or no
 * reply comes within PAINT_DEADLINE_MS (a reply after that is dropped).
 * `lane` picks the worker (`lanes`).
 */
export function paintAway(job: PaintJob, src: GroundSource, lane = 0): Promise<PaintResult> {
  // Kept for a fallback: posting transfers a copy, which detaches it here.
  const tiles = packGround(src, job.x0, job.y0, job.w, job.h)
  const w = start(lane)
  if (!w) return Promise.resolve(paintHere(job, unpackGround(tiles)))
  return new Promise((resolve) => {
    const id = nextId++
    let done = false
    const settle = (r: () => PaintResult) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      waiting.delete(id)
      resolve(r())
    }
    const entry = { resolve: (r: PaintResult) => settle(() => r), fallback: () => settle(() => paintHere(job, unpackGround(tiles))) }
    const deadline = setTimeout(entry.fallback, PAINT_DEADLINE_MS)
    waiting.set(id, entry)
    const sent = { ...tiles, ground: tiles.ground.slice(), solid: tiles.solid.slice() }
    try {
      w.postMessage({ id, ...job, tiles: sent }, [sent.ground.buffer, sent.solid.buffer])
    } catch {
      entry.fallback()
    }
  })
}
