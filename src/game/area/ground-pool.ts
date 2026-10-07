/**
 * The ground-overlay painters: a small pool of workers (./ground-worker.ts),
 * or, when there are none, slices on the main thread. No DOM here beyond
 * timers: the workers come from a factory, so tests drive it with fakes.
 *
 * A pool that fails (a worker can't start, reports an error, or doesn't
 * answer within the watchdog) is disposed of whole: every worker is
 * terminated, every outstanding job on it (this paint's and any other's) is
 * settled, and each of those paints finishes its remaining overlays on the
 * main thread. A disposed pool stays disposed for the page.
 */
import { paintEdgeJobs, type EdgeJob } from './ground-paint.ts'

/** What the pool needs of a worker. */
export interface Painter {
  postMessage(message: unknown): void
  addEventListener(type: 'message' | 'error', listener: (e: Event) => void): void
  removeEventListener(type: 'message' | 'error', listener: (e: Event) => void): void
  terminate(): void
}

export type PaintedCell = { i: number; rgba: Uint8ClampedArray }

interface Outstanding {
  cancel(reason: Error): void
}

export class PaintPool {
  private workers: Painter[] | null = null
  private outstanding = new Set<Outstanding>()
  private nextId = 0
  /** Disposed after a failure (or never started): every paint runs on the main thread. */
  disposed = false

  private readonly make: () => Painter[]
  private readonly watchdogMs: number

  constructor(make: () => Painter[], watchdogMs = 20_000) {
    this.make = make
    this.watchdogMs = watchdogMs
  }

  /** The live workers (made on first use; none once disposed). */
  private pool(): Painter[] {
    if (this.disposed) return []
    if (!this.workers) {
      try {
        this.workers = this.make()
      } catch {
        // The factory disposes of what it made before throwing (see `startWorkers`).
        this.workers = []
        this.disposed = true
      }
    }
    return this.workers
  }

  /** Terminate every worker and settle every outstanding job (they fall back to the main thread). */
  dispose(): void {
    this.disposed = true
    for (const w of this.workers ?? []) w.terminate()
    this.workers = []
    for (const o of [...this.outstanding]) o.cancel(new Error('ground painters stopped'))
  }

  /** How many jobs are waiting on a worker (tests). */
  get waiting(): number {
    return this.outstanding.size
  }

  /**
   * Paint `jobs`, handing each painted cell to `onCells` as it arrives.
   * Resolves once every job is painted (by a worker or, after a failure or
   * with `mainThread`, here).
   */
  paint(jobs: EdgeJob[], refs: Record<string, Uint8ClampedArray>, k: number, onCells: (cells: PaintedCell[]) => void, mainThread = false): Promise<void> {
    const done = new Set<number>()
    const take = (cells: PaintedCell[]) => {
      for (const c of cells) done.add(c.i)
      onCells(cells)
    }
    const pool = mainThread ? [] : this.pool()
    if (pool.length === 0) return paintSlices(jobs, refs, k, take)
    // Round-robin batches, so each worker gets a share of every kind of edge.
    const batches: EdgeJob[][] = pool.map(() => [])
    jobs.forEach((j, n) => batches[n % pool.length].push(j))
    return Promise.all(pool.map((w, n) => (batches[n].length ? this.send(w, batches[n], refs, k, take) : Promise.resolve()))).then(
      () => undefined,
      () => {
        // A painter failed: stop them all, and finish what's left here.
        this.dispose()
        return paintSlices(jobs.filter((j) => !done.has(j.i)), refs, k, take)
      },
    )
  }

  /** One batch on one worker: settles on its answer, its error, the watchdog, or the pool's disposal. */
  private send(w: Painter, jobs: EdgeJob[], refs: Record<string, Uint8ClampedArray>, k: number, take: (cells: PaintedCell[]) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = ++this.nextId
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = () => {
        w.removeEventListener('message', onMessage)
        w.removeEventListener('error', onError)
        if (timer !== null) clearTimeout(timer)
        this.outstanding.delete(entry)
      }
      const onMessage = (e: Event) => {
        const data = (e as MessageEvent<{ id: number; cells: PaintedCell[] }>).data
        if (data?.id !== id) return
        finish()
        take(data.cells)
        resolve()
      }
      const onError = (e: Event) => {
        finish()
        const err = e as ErrorEvent
        reject(err.error ?? new Error(err.message ?? 'ground painter error'))
      }
      const entry: Outstanding = {
        cancel: (reason) => {
          finish()
          reject(reason)
        },
      }
      this.outstanding.add(entry)
      timer = setTimeout(() => entry.cancel(new Error('ground painter timed out')), this.watchdogMs)
      w.addEventListener('message', onMessage)
      w.addEventListener('error', onError)
      w.postMessage({ id, jobs, refs, k })
    })
  }
}

/** Paint jobs here, in slices of about a frame's worth, so the page keeps drawing. */
export function paintSlices(jobs: EdgeJob[], refs: Record<string, Uint8ClampedArray>, k: number, onCells: (cells: PaintedCell[]) => void): Promise<void> {
  return new Promise((resolve) => {
    let at = 0
    const slice = () => {
      const t0 = performance.now()
      while (at < jobs.length && performance.now() - t0 < 12) onCells(paintEdgeJobs([jobs[at++]], refs, k))
      if (at < jobs.length) setTimeout(slice, 0)
      else resolve()
    }
    slice()
  })
}

/**
 * Start `n` workers from `create`; if one can't be made, terminate the ones
 * already made and throw (the pool then paints on the main thread).
 */
export function startWorkers(n: number, create: () => Painter): Painter[] {
  const made: Painter[] = []
  try {
    for (let i = 0; i < n; i++) made.push(create())
  } catch (err) {
    for (const w of made) w.terminate()
    throw err
  }
  return made
}

/** What `refreshWhenPainted` needs of a texture (a Phaser CanvasTexture). */
export interface ShownTexture {
  source: { image: unknown }[]
  refresh(): unknown
}

/**
 * When a pending paint lands, upload it to `texture` again, if the texture
 * is still alive and still shows `canvas` (a newer area, or a new game,
 * has its own); then `then`. Every build that shows a pending paint calls
 * this for its own texture.
 */
export function refreshWhenPainted(done: Promise<void>, texture: ShownTexture, canvas: unknown, then?: () => void): void {
  void done.then(() => {
    if (texture.source.length === 0 || texture.source[0].image !== canvas) return
    texture.refresh()
    then?.()
  })
}
