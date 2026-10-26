/**
 * Height terrain's bake thread: one worker (./terrain-worker.ts) bakes the
 * chunks; if it can't start or fails, the bake runs here (the same pure
 * ./bake.ts, so nothing looks different).
 */
import { bakeChunk, type BakeJob, type Baked } from './bake.ts'

export interface BakeResult {
  baked: Baked
  ms: number
  thread: 'worker' | 'main'
}

let worker: Worker | null = null
let broken = false
let next = 0
const waiting = new Map<number, { resolve: (r: BakeResult) => void; job: BakeJob }>()

function here(job: BakeJob): BakeResult {
  const t = performance.now()
  const baked = bakeChunk(job)
  return { baked, ms: performance.now() - t, thread: 'main' }
}

function fail(): void {
  broken = true
  worker?.terminate()
  worker = null
  for (const w of [...waiting.values()]) w.resolve(here(w.job))
  waiting.clear()
}

function start(): Worker | null {
  if (broken || typeof Worker === 'undefined') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./terrain-worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<{ id: number; baked: Baked; ms: number }>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      w.resolve({ baked: e.data.baked, ms: e.data.ms, thread: 'worker' })
    })
    worker.addEventListener('error', fail)
    worker.addEventListener('messageerror', fail)
    return worker
  } catch {
    broken = true
    return null
  }
}

/** Bake off the main thread when a worker is up, else here. */
export function bakeAway(job: BakeJob): Promise<BakeResult> {
  const w = start()
  if (!w) return Promise.resolve(here(job))
  return new Promise((resolve) => {
    const id = next++
    waiting.set(id, { resolve, job })
    try {
      w.postMessage({ id, job })
    } catch {
      waiting.delete(id)
      resolve(here(job))
    }
  })
}
